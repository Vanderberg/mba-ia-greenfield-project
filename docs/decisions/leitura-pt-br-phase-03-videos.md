> **Nota:** esta é uma tradução de leitura do arquivo canônico [`technical-decisions-phase-03-videos.md`](./technical-decisions-phase-03-videos.md). Use este arquivo para **entender e decidir**; depois, preencha os campos `**Decision:**` **no arquivo original em inglês**, que é o que o pipeline (`/plan-context`, `/plan-validate`, `/plan-resolve`) realmente lê. Este arquivo `.pt-br.md` não é consumido pelo pipeline e não deve ser editado como fonte de verdade.

---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-07-25
---

# Decisões Técnicas — Fase 03: Upload e Processamento de Vídeos

_Subprojetos no escopo:_

- `nestjs-project/` — dono das seis decisões abaixo: cliente de armazenamento de objetos, topologia de fila/worker, protocolo de upload, pré-cadastro de rascunho + estratégia de identificador, pipeline de processamento com FFmpeg, e entrega de streaming/download.
- `next-frontend/` — nenhuma decisão em aberto neste documento. A lista de capacidades da Fase 03 (`docs/project-plan.md` § Fase 03) não cita nenhuma tela ou superfície de UI (diferente da Fase 02, que citava explicitamente "Telas de cadastro, login..."). O widget de upload e o player são preocupações de frontend que serão pesquisadas quando uma fase os citar explicitamente (painel de gerenciamento da Fase 04, página de visualização da Fase 05) — os contratos decididos aqui (protocolo de upload, entrega de streaming) restringem esse trabalho futuro de frontend, mas não exigem decisões de frontend agora.

---

## TD-01: Backend de Armazenamento de Objetos & SDK Cliente

**Escopo:** Backend

**Capacidade:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Contexto:** Vídeos e thumbnails precisam de uma camada de armazenamento persistente e "streamável", distinta do PostgreSQL. O diagrama C4 (`docs/diagrams/software-arch.mermaid`) já nomeia esse container como "Object Storage (S3/MinIO)" — esta decisão escolhe o backend concreto e como a API NestJS conversa com ele. Nenhum SDK de armazenamento está instalado ainda (`nestjs-project/package.json`).

**Premissa de endpoint duplo (vale para todas as opções abaixo):** o cliente S3 da API resolve o armazenamento pela rede Docker usando o nome do serviço do Compose (`minio`), conforme `CLAUDE.md` § Docker Networking. Mas o TD-06 entrega ao **navegador** uma URL pré-assinada (presigned) para esse mesmo objeto — e o navegador não está na rede Docker, então essa URL precisa usar um host que o navegador realmente alcance (`localhost:<porta>` em dev via o mapeamento de porta do Compose; um domínio público/CDN em produção). Ou seja, a configuração do cliente de storage precisa de **dois endpoints**: um interno (`S3_INTERNAL_ENDPOINT=http://minio:9000`, usado em toda chamada feita pelo servidor) e um público (`S3_PUBLIC_ENDPOINT`, usado apenas ao gerar URLs pré-assinadas para o TD-06). Qualquer que seja a opção escolhida abaixo, essa separação de endpoints é obrigatória — um único endpoint quebraria ou as chamadas do servidor (host do navegador inacessível a partir do container da API) ou toda URL pré-assinada entregue ao navegador (host interno inacessível a partir do navegador).

**Opções:**

### Opção A: MinIO (auto-hospedado, compatível com S3) + `@aws-sdk/client-s3`
- O MinIO roda como um serviço do Compose ao lado de `db` e `mailpit`; a API conversa com ele através da API padrão do S3, usando o cliente oficial `@aws-sdk/client-s3` v3 apontado para o endpoint do MinIO (`endpoint` + `forcePathStyle: true`).
- **Prós:** Ciclo de desenvolvimento local totalmente funcional (sem precisar de conta na nuvem); segue a convenção do projeto de "tudo roda em Docker" (`CLAUDE.md` § Docker Networking); nenhuma mudança de código necessária para futuramente apontar o mesmo cliente para o S3 real da AWS (mesma superfície de API); gratuito em qualquer volume para dev/CI.
- **Contras:** Mais um container para operar em produção (ou um passo de migração para o S3 real no deploy); ajuste fino de cluster/erasure-coding do MinIO para durabilidade real está fora do escopo desta fase.

### Opção B: AWS S3 na nuvem diretamente (dev + produção, sem emulação local)
- A API conversa com um bucket S3 real desde o início, inclusive em desenvolvimento local, usando `@aws-sdk/client-s3`.
- **Prós:** Nenhuma divergência de comportamento entre dev e produção; a semântica real do S3 (limites de multipart, casos de consistência eventual) é exercitada desde o início.
- **Contras:** Exige credenciais AWS e um bucket real para cada execução de desenvolvedor/CI — quebra o ambiente local totalmente "dockerizado" do projeto; custa dinheiro para um projeto sem ambiente de deploy ainda; viola a convenção "sempre use o nome do serviço do Compose" com uma dependência externa.

### Opção C: Volume de sistema de arquivos local (diretório montado via bind)
- Os arquivos são gravados em um volume Docker e servidos pelo próprio sistema de arquivos da API; nenhuma API do S3 envolvida.
- **Prós:** Configuração mais simples possível, sem biblioteca nova.
- **Contras:** Sem primitivas de multipart/URL pré-assinada para reaproveitar nos TD-03 e TD-06 (exigiria implementar na unha o atendimento de range-requests e o controle de upload retomável); não corresponde ao diagrama de arquitetura já desenhado; difícil de escalar ou migrar para nuvem depois, já que nenhuma parte da API do S3 é reaproveitada.

**Recomendação:** **Opção A (MinIO + `@aws-sdk/client-s3`)** — é a arquitetura literal já acordada em `software-arch.mermaid`, mantém o ambiente local totalmente contido em Docker conforme a convenção de rede do projeto, e sua API compatível com S3 é reaproveitada diretamente pelo TD-03 (upload) e TD-06 (streaming/download) em vez de inventar lógica própria de range-serving e retomada de upload. Os buckets são **privados** por padrão (sem política de leitura anônima) — toda leitura/escrita passa pelo cliente autenticado da API ou por uma URL pré-assinada com prazo curto (TD-06); a política de visibilidade pública/unlisted é escopo da Fase 04 e se sobrepõe a isso sem mudar esse padrão. **CORS precisa estar habilitado no bucket** (`AllowedOrigins`: a origem do frontend, `AllowedMethods`: `GET`, `AllowedHeaders`: `Range`) — sem isso, as requisições de range feitas diretamente pelo navegador ao endpoint público no TD-06 (Opção B) são bloqueadas pelo próprio navegador, mesmo com a URL pré-assinada válida.

**Decisão:** A (MinIO + `@aws-sdk/client-s3`)

---

## TD-02: Fila de Jobs em Segundo Plano & Topologia do Worker

**Escopo:** Backend

**Capacidade:** Serviço de processamento em segundo plano (filas)

**Contexto:** O processamento de vídeo (extração de duração/metadados, geração de thumbnail — TD-05) consome muita CPU e não pode bloquear o ciclo de requisição/resposta nem o event loop do processo da API. O diagrama de arquitetura já nomeia um container separado, "Video Worker (FFmpeg)", que "consome jobs da fila"; a própria fila de mensagens está marcada como `TBD` (a definir). Esta decisão escolhe a tecnologia de fila e como o worker se conecta a ela. Nenhuma biblioteca de fila está instalada ainda.

**Gatilho de enfileiramento (vale independentemente da opção escolhida):** o job precisa ser enfileirado no exato momento em que o upload termina de fato — não antes. Como o TD-03 (Opção A, `tus`) já finaliza um upload completo através do próprio hook `onUploadFinish` do protocolo, do lado da API, esse hook é o ponto de enfileiramento: ele emite o job `process-video` com `{ videoId }` como payload. Isso é preferível a um gatilho por notificação de bucket `ObjectCreated` do S3/MinIO, porque o hook do `tus` roda dentro do processo da API que já conhece o `videoId` (TD-04) — uma notificação de bucket só carregaria a chave de armazenamento e exigiria uma busca reversa, adicionando uma dependência do recurso de notificação/webhook do MinIO sem nenhum ganho.

**Idempotência:** o job é enfileirado com `jobId: videoId` (o BullMQ deduplica jobs que compartilham um `jobId` já presente na fila/em execução), então uma chamada duplicada de `onUploadFinish` (por exemplo, uma requisição `tus` reenviada) não consegue enfileirar o mesmo vídeo duas vezes. Dentro do processador, toda escrita é um upsert indexado por `videoId` (grava duração/metadados/thumbnail incondicionalmente como o estado final, nunca como incremento ou anexação) — assim, um reprocessamento do mesmo job pelo BullMQ após uma queda do worker é seguro, em vez de corromper ou duplicar o estado.

**Dead-letter / falha permanente:** o `attempts` + `backoff` exponencial do BullMQ governam as tentativas de retry para falhas transitórias (ex.: OOM do worker, instabilidade de storage). Quando as tentativas se esgotam, o handler do evento `failed` define o status da linha do `Video` como `failed` (ver máquina de estados do TD-04), em vez de deixá-la presa em `processing` — esse é o estado terminal que um dono de canal veria em um futuro painel de gerenciamento (Fase 04) para um upload que não pôde ser processado (arquivo corrompido, codec não suportado).

**Opções:**

### Opção A: BullMQ + Redis, worker como processo/container separado
- `bullmq` (baseado em Redis) com `@nestjs/bullmq` na API para produzir jobs; o worker roda como seu próprio entrypoint Node (`main-worker.ts` próprio, serviço Docker próprio) usando a classe `Worker` do BullMQ, consumindo a mesma instância Redis.
- **Prós:** Construído exatamente para esse formato (separação produtor/consumidor entre processos), retry/backoff de primeira classe, recuperação de jobs "travados" (stalled) se o worker cair no meio de uma transcodificação, controle de concorrência, e um dashboard opcional (Bull Board) para visibilidade operacional — tudo relevante para jobs longos de FFmpeg.
- **Contras:** Introduz o Redis como uma dependência de infraestrutura totalmente nova (não há cache/session store na stack hoje) — mais um serviço do Compose para rodar e operar.

### Opção B: pg-boss (fila baseada em PostgreSQL), worker como processo/container separado
- `pg-boss` usa a instância PostgreSQL já em execução como broker e como armazenamento de jobs (polling baseado em `SKIP LOCKED`); o worker é um entrypoint Node separado, inscrito nos tipos de job.
- **Prós:** Nenhum serviço de infraestrutura novo — reaproveita o container `db` já presente no Compose; jobs e linhas de vídeo podem compartilhar uma fronteira de transação, se necessário no futuro; uma peça a menos para operar.
- **Contras:** Baseado em polling (não em push) — latência adicional na captura de cada job, comparado ao pub/sub do Redis; ferramentas de retry/observabilidade menos maduras que o ecossistema do BullMQ; adiciona carga de escrita sustentada (polling + rotatividade da tabela de jobs) na mesma instância Postgres que atende às consultas voltadas ao usuário.

**Recomendação:** **Opção A (BullMQ + Redis)** — jobs de transcodificação de vídeo são longos e consomem muita CPU; a detecção de jobs travados e a semântica de backoff/retry do BullMQ foram construídas exatamente para esse cenário de "worker cai no meio do job", o que pesa mais aqui do que evitar mais um serviço no Compose. A dependência do Redis é uma adição pontual ao `nestjs-project/compose.yaml`, não um custo recorrente.

**Decisão:** A (BullMQ + Redis, worker em processo separado)

---

## TD-03: Protocolo de Upload de Arquivos Grandes (até 10GB)

**Escopo:** Backend

**Capacidade:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Contexto:** Um upload de 10GB numa conexão real vai sofrer interrupções de rede; reenviar tudo do zero a cada queda é inaceitável, e armazenar o arquivo inteiro na memória ou no disco local do processo da API antes de repassá-lo ao armazenamento consumiria recursos do servidor, contrariando o requisito "sem impacto na performance". Esta decisão escolhe o protocolo de transporte entre cliente e API/armazenamento.

**Autenticação (vale independentemente da opção escolhida):** só um dono de canal autenticado pode iniciar ou retomar um upload — os protocolos `tus`/multipart do S3, por si só, não carregam autenticação nenhuma. O token de acesso emitido na Fase 02 (`Authorization: Bearer <accessToken>`) é enviado em toda requisição `tus` (`POST`, `HEAD`, `PATCH`), exatamente como em qualquer outra chamada autenticada da API; o handler de requisições do servidor `tus` roda atrás do mesmo guard de autenticação usado no resto da API, antes de `tusServer.handle(req, res)` ser chamado, e adicionalmente verifica que o usuário autenticado é dono do `videoId` embutido nos metadados do upload (TD-04) antes de permitir que um `PATCH` continue esse upload — do contrário, um usuário poderia retomar ou sobrescrever o upload em andamento de outro usuário adivinhando/reutilizando uma URL de recurso `tus`.

**Limpeza de uploads incompletos (vale independentemente da opção escolhida):** um upload que o usuário abandona no meio do caminho (fecha a aba com 3GB de 10GB enviados) não pode virar custo de armazenamento permanente. Para a Opção A, o `@tus/s3-store` mapeia diretamente para uploads multipart do S3, então uma **regra de lifecycle do S3** expirando uploads multipart incompletos após N dias (ex.: 2 dias) é configurada no bucket (TD-01) — isso é uma política do lado do armazenamento, não código de aplicação, e não exige job/cron adicional.

**Opções:**

### Opção A: Protocolo resumível `tus` via `@tus/server` + `@tus/s3-store`
- A API monta um endpoint `tus`; o `@tus/s3-store` transmite os chunks diretamente para um upload multipart do S3/MinIO (TD-01) conforme chegam, e persiste o offset/estado do upload, de forma que um cliente interrompido possa retomar do último byte recebido usando o handshake padrão `HEAD`/`PATCH` do `tus`.
- **Prós:** A retomada é nativa do protocolo (exatamente a preocupação "sem travar o sistema" / de recuperação após queda citada em `docs/project-plan.md` § Pontos de Atenção); os chunks vão direto para as partes do multipart do S3 (sem armazenar o arquivo inteiro em buffer); protocolo aberto e consolidado, com bibliotecas cliente prontas (`tus-js-client`) para qualquer widget de upload que o frontend venha a construir.
- **Contras:** Adiciona uma nova superfície de protocolo/biblioteca que a equipe precisa aprender; o frontend vai precisar de um cliente compatível com `tus` em vez de um simples `fetch`/`FormData` (isso fica fora do escopo deste documento, mas ainda é um custo futuro de integração).

### Opção B: Upload multipart do S3 conduzido pelo cliente (URLs pré-assinadas por parte)
- A API cria um upload multipart e distribui URLs pré-assinadas de `UploadPart` por chunk (cliente S3 do TD-01); o navegador envia cada parte diretamente para o MinIO/S3, e então chama a API para completar o upload multipart.
- **Prós:** Os bytes nunca passam pelo processo da API Nest (melhor impacto possível em performance da API); reaproveita o mesmo `@aws-sdk/client-s3` já escolhido no TD-01, sem biblioteca de protocolo extra.
- **Contras:** A retomada após um recarregamento completo de página ou uma queda de rede no meio de uma parte precisa ser implementada na unha (rastrear quais partes tiveram sucesso, requisitar novas URLs pré-assinadas, orquestrar retries) — o `tus` entrega isso de graça; mais lógica customizada no frontend para conduzir corretamente o handshake do multipart.

### Opção C: Upload via formulário multipart em streaming através da API Nest (`FileInterceptor` + buffer em disco)
- O navegador envia uma única requisição grande `multipart/form-data`; o `FileInterceptor` do Nest faz o streaming para um arquivo temporário, que a API então envia ao armazenamento.
- **Prós:** Implementação mais simples, padrão comum do Nest/Multer, nenhum protocolo novo.
- **Contras:** Nenhuma retomada — qualquer interrupção num upload de vários GB significa recomeçar do zero; o arquivo transita e fica temporariamente em buffer no próprio disco da API, contrariando diretamente o "sem impacto na performance" na escala de 10GB; o próprio ponto de atenção citado no plano do projeto fica sem solução nesta opção.

**Recomendação:** **Opção A (`tus` via `@tus/s3-store`)** — é a única opção que satisfaz as duas metades do texto da capacidade ("até 10GB" e "sem impacto na performance") sem implementar a retomada na unha, e se encaixa diretamente no armazenamento compatível com S3 já escolhido no TD-01.

**Decisão:** A (`tus` via `@tus/server` + `@tus/s3-store`)

---

## TD-04: Pré-cadastro de Rascunho, Ciclo de Vida de Status & Estratégia de Identificador do Vídeo

**Escopo:** Backend

**Capacidade:** Transversal — cobre: "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload", "URL única por vídeo, sem conflito com outros vídeos"

**Contexto:** A capacidade exige explicitamente que uma linha de `Video` em rascunho exista automaticamente no momento em que um upload *começa* (não depois que termina), para que o dono do canal possa vê-la/gerenciá-la como rascunho mesmo enquanto um upload de 10GB ainda está em andamento. Esta decisão depende do TD-03: qualquer que seja o handshake de upload escolhido, a API precisa criar a identidade do vídeo (linha no banco + chave de armazenamento) antes de qualquer byte ser aceito, para que essa identidade seja carregada através da sessão de upload (`Upload-Metadata` do `tus`, na Opção A do TD-03).

**Ciclo de vida de status (vale independentemente da opção escolhida abaixo):** pré-cadastrar a linha é só metade da capacidade — a linha também precisa refletir em que ponto do pipeline o vídeo realmente está, já que o worker do TD-02 e o processamento do TD-05 a transicionam de forma assíncrona. A coluna `Video.status` é uma máquina de estados com quatro estados: `draft` (linha criada, upload ainda não terminou) → `processing` (upload completo, job `process-video` em execução — TD-02) → `ready` (duração/metadados/thumbnail persistidos — TD-05) ou `failed` (caminho de dead-letter do TD-02, falha permanente no processamento). O hook `onUploadFinish` do `tus` (TD-02) é quem vira `draft → processing` e enfileira o job; o worker vira `processing → ready` ou `processing → failed` ao concluir/esgotar as tentativas. O futuro painel de gerenciamento da Fase 04 lê essa coluna diretamente — nenhum mecanismo novo é necessário lá.

**Limpeza de rascunhos órfãos (vale independentemente da opção escolhida abaixo):** uma linha de rascunho criada antes do upload começar (Opção A) pode ser abandonada antes de sequer um byte chegar (usuário nunca abre a sessão `tus`) ou abandonada no meio do upload (coberto pela regra de lifecycle do S3 no TD-03, mas a linha do banco em si ainda existe sem nenhum objeto por trás). Uma limpeza agendada (um job repetitivo de baixa frequência no BullMQ — reaproveitando a fila do TD-02, sem infraestrutura nova) apaga linhas de `Video` ainda em `status: draft` além de um TTL (ex.: 48h) sem upload completo correspondente, mantendo a tabela `videos` livre de órfãos permanentes deixados por navegadores que nunca iniciaram ou nunca terminaram um upload.

**Opções:**

### Opção A: Pré-criar a linha de rascunho de forma síncrona, depois abrir a sessão de upload contra ela
- O cliente chama `POST /videos` primeiro (cria uma linha de `Video` com `status: draft`, gera seu `id` UUID via a convenção já existente no projeto `@PrimaryGeneratedColumn('uuid')` — já usada por `User`, `Channel` e as entidades de token de autenticação), recebe o id de volta, e então abre a sessão de upload `tus` com esse id embutido em `Upload-Metadata`. A chave de armazenamento do objeto é derivada de forma determinística a partir do id (ex.: `videos/{id}/original`).
- **Prós:** Corresponde literalmente à capacidade ("ao iniciar o upload" — a linha existe antes do primeiro byte chegar); reaproveita a convenção já estabelecida de PK em UUID, sem nenhuma lógica nova de unicidade, então o mesmo id serve também como o identificador público livre de colisão que a capacidade "URL única" pede; a derivação da chave de armazenamento é trivial e livre de colisão por construção (namespaced por UUID).
- **Contras:** Exige duas idas e voltas do cliente (criar rascunho, depois iniciar o upload) em vez de uma — aceitável dado que a integração de frontend para esse handshake está fora do escopo deste documento.

### Opção B: Criar o rascunho implicitamente a partir da primeira requisição da sessão de upload (guiado por webhook/hook)
- O cliente abre diretamente a sessão `tus` (ou multipart do S3); o hook `onUploadCreate` do `tus` da API (ou uma notificação de evento do S3) cria a linha de `Video` depois disso, derivando o id a partir da chave de upload/objeto atribuída pelo armazenamento.
- **Prós:** Uma única ida e volta para o cliente.
- **Contras:** O formato da chave de upload/objeto da camada de armazenamento vira a fonte da identidade pública do vídeo (dependência invertida — o armazenamento não deveria guiar o modelo de domínio); mais difícil garantir que a linha exista de forma síncrona para quem quer navegar imediatamente para a tela de gerenciamento do rascunho; mais indireção para rastrear "por que esse rascunho existe" durante depuração.

**Recomendação:** **Opção A** — pré-criar a linha é o que o texto da capacidade literalmente pede, custa uma ida e volta extra que é invisível para o usuário final (o frontend faz as duas chamadas antes de mostrar a barra de progresso do upload), e permite que a convenção já estabelecida de PK em UUID sirva também como identificador de URL única, sem nenhum mecanismo novo.

**Decisão:** A (pré-criar a linha de rascunho de forma síncrona, depois abrir a sessão de upload contra ela)

---

## TD-05: Processamento de Vídeo — Estratégia de Acesso a Bytes pelo Worker & Ferramental

**Escopo:** Backend

**Capacidade:** Transversal — cobre: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Contexto:** Quando o worker do TD-02 pega um job de upload concluído, ele precisa invocar o FFmpeg para ler a duração/metadados do vídeo (`ffprobe`) e extrair um frame como thumbnail (`ffmpeg`). As duas operações precisam de **acesso aleatório** ao arquivo, não apenas leitura sequencial: o `ffprobe` tipicamente precisa da caixa de metadados do container (no MP4, o átomo `moov`, que muitos encoders escrevem no **final** do arquivo, não no início) e a extração de thumbnail precisa buscar (seek) um timestamp arbitrário. Essa é a verdadeira questão estratégica para um arquivo de 10GB — como o worker obtém bytes nos quais consegue fazer seek — não qual biblioteca wrapper de linha de comando é usada para invocar o FFmpeg (uma escolha bem menor, de nível de implementação, tratada na recomendação abaixo).

**Opções:**

### Opção A: Baixar o objeto completo para o disco efêmero local do worker, depois processar o arquivo local
- No início do job, o worker transmite o objeto do MinIO/S3 (TD-01) para um caminho temporário (`/tmp/processing/{videoId}`); o `ffprobe`/`ffmpeg` então rodam contra esse arquivo local, com suporte completo a seek aleatório; o arquivo temporário é apagado em um bloco `finally`, independente de sucesso ou falha.
- **Prós:** `ffprobe`/`ffmpeg` se comportam exatamente como documentado/testado contra arquivos locais — nenhum caso extremo de formato de container para se preocupar; um job que quebra deixa no máximo um arquivo temporário perdido (limpo pela mesma exclusão via `finally` na próxima execução bem-sucedida, ou por uma varredura periódica); opção mais simples e robusta de implementar e depurar.
- **Contras:** O worker precisa de disco efêmero dimensionado para `(jobs concorrentes máximos × tamanho máximo de upload)` — em 10GB máximo, mesmo com 2 jobs concorrentes isso já são ≥20GB de espaço temporário por instância de worker; exige limpeza explícita e garantida (um arquivo temporário vazado num caminho de exceção não capturada consumiria disco silenciosamente ao longo do tempo).

### Opção B: Transmitir o objeto diretamente para o FFmpeg via stdin/pipe nomeado (sem cópia local)
- O worker encaminha um stream de leitura de `GetObject` do S3 diretamente para o stdin do `ffmpeg`, evitando qualquer download completo.
- **Prós:** Nenhum uso de disco proporcional ao tamanho do arquivo; pode começar a processar antes que o objeto inteiro termine de baixar, em operações lineares simples.
- **Contras:** Não funciona justamente para as duas operações que esta fase precisa: um único stream sequencial não consegue satisfazer a necessidade do `ffprobe` de ler um átomo `moov` no final do arquivo, nem a necessidade do `ffmpeg` de buscar um timestamp arbitrário para o thumbnail, a menos que se faça buffer do stream inteiro de qualquer forma (anulando o propósito) ou se exija que os arquivos de origem já venham remuxados em "faststart" (uma restrição que esta fase não pode impor sobre uploads arbitrários de usuários).

### Opção C: Downloads parciais (por range) cientes do formato do container (busca só os intervalos de bytes que o FFmpeg precisa)
- O worker interpreta o suficiente do próprio formato do container para saber quais intervalos de bytes requisitar (ex.: localizar o átomo `moov` via um pequeno GET por range no início e no fim de um MP4, depois um GET direcionado perto do timestamp desejado para o thumbnail).
- **Prós:** Transferência mínima de bytes, sem download completo e sem cópia local completa.
- **Contras:** Na prática, reimplementa o parsing de formato de container que o `ffprobe` já faz internamente — engenharia pesada, frágil e específica por formato (MP4 vs WebM vs MKV são todos diferentes) para construir e manter, para uma necessidade de apenas duas operações; desproporcional ao que a lista de capacidades desta fase realmente pede.

**Recomendação:** **Opção A (baixar para disco efêmero local do worker)** — o `ffprobe`/`ffmpeg` precisam de acesso aleatório genuíno para as duas operações que esta fase exige, e essa necessidade é exatamente o que inviabiliza a Opção B e torna a Opção C desproporcionalmente cara de construir. O contra do custo de disco é limitado e administrável: limitar a concorrência do worker para caber `(concorrência × 10GB)` dentro do volume alocado ao container do worker, e garantir a limpeza com exclusão via `finally` mais uma varredura periódica do diretório temporário como reforço contra qualquer arquivo vazado por uma queda abrupta.

**Nota de implementação (não é um eixo estratégico separado):** dentro da Opção A, o worker ainda precisa de alguma forma de invocar as duas operações do FFmpeg contra o arquivo temporário local. O `fluent-ffmpeg` (combinado com `@ffmpeg-installer/ffmpeg` / `@ffprobe-installer/ffprobe` para binários estáticos com versão fixada, evitando um passo `apt-get install ffmpeg` da distro cuja versão varia conforme a tag da imagem base) é um wrapper de conveniência fino e consolidado sobre os dois comandos — isso é uma escolha de ergonomia de biblioteca, não uma decisão com trade-offs arquiteturais concorrentes, por isso é registrada aqui como a convenção adotada, em vez de ter sua própria tabela de Opções.

**Decisão:** A (baixar o objeto completo para o disco efêmero local do worker, depois processar o arquivo local)

---

## TD-06: Estratégia de Entrega de Streaming & Download de Vídeo

**Escopo:** Backend

**Capacidade:** Transversal — cobre: "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Contexto:** Uma vez que um vídeo é processado e armazenado (TD-01), o elemento `<video>` do navegador precisa começar a reprodução sem baixar o arquivo inteiro (requisições HTTP de range), e o usuário precisa de uma ação separada de "download" para o arquivo completo. Esta decisão escolhe como os bytes vão do MinIO/S3 até o navegador, nos dois casos.

**Opções:**

### Opção A: API faz proxy das requisições de range para o armazenamento (controller Nest transmite `GetObjectCommand` repassando o `Range`)
- O link do player/download chega a um endpoint Nest (`GET /videos/:id/stream`), que repassa o cabeçalho `Range` recebido para um `GetObjectCommand` do S3 e envia o stream de resposta de volta ao cliente, com a semântica correspondente de `206 Partial Content`.
- **Prós:** A API continua sendo o único ponto de autorização/controle de acesso para cada byte servido (relevante quando a visibilidade unlisted/privada chegar na Fase 04); nenhum acoplamento direto cliente-armazenamento para gerenciar.
- **Contras:** Cada byte de cada visualização/download de vídeo transita pelo processo da API Nest — indo diretamente contra o "sem impacto na performance" em escala, e duplica lógica de parsing de range que o S3/MinIO já implementa corretamente.

### Opção B: Redirecionamento por URL pré-assinada (API emite uma URL pré-assinada de `GetObject` de curta duração; o navegador conversa diretamente com o armazenamento)
- O endpoint retorna (ou redireciona para) uma URL pré-assinada; o comportamento nativo de requisição de range do elemento `<video>` e o fluxo de download do navegador conversam diretamente com o MinIO/S3, que já serve `Range` e `Accept-Ranges` corretamente, de fábrica. O download reaproveita a mesma URL pré-assinada, com `ResponseContentDisposition: attachment` definido no comando.
- **Prós:** Zero bytes de vídeo transitam pelo processo da API (melhor perfil de performance para a preocupação declarada de 10GB/streaming); nenhum código customizado de parsing de range para escrever ou manter; download vs. streaming é apenas um parâmetro diferente (`ResponseContentDisposition`) no mesmo mecanismo de URL pré-assinada já disponível a partir do cliente S3 do TD-01.
- **Contras:** O controle de acesso precisa acontecer no momento de emissão da URL (expiração curta + uma checagem antes de gerar a URL), em vez de por byte — aceitável nesta fase, já que a Fase 03 ainda não tem o conceito de vídeo privado (a visibilidade unlisted/pública é explicitamente escopo da Fase 04). Esta opção só funciona com o endpoint **público** do MinIO e a política de **CORS** do bucket já exigidos no TD-01 (`S3_PUBLIC_ENDPOINT` + `AllowedOrigins`/`AllowedMethods: GET`/`AllowedHeaders: Range`) — a URL pré-assinada precisa ser assinada contra o endpoint que o navegador alcança, e a própria requisição de range do navegador para esse endpoint é bloqueada por CORS caso contrário, mesmo com a URL válida.

### Opção C: Transcodificação adaptativa HLS/DASH (o worker gera múltiplas variantes + manifesto)
- O worker do TD-05 também transcodifica cada upload em várias variantes de taxa de bits/resolução e um manifesto HLS; o player passa a requisitar segmentos em vez do arquivo original.
- **Prós:** Troca adaptativa de qualidade, padrão da indústria para plataformas de vídeo em grande escala.
- **Contras:** Aumento massivo de escopo para esta fase — múltiplas codificações por upload, geração/serviço de manifesto, layout de armazenamento de segmentos — nada disso é pedido pela lista de capacidades da fase (um único stream + um único download, sem menção a níveis de qualidade ou taxa de bits adaptativa).

**Recomendação:** **Opção B (redirecionamento por URL pré-assinada)** — o MinIO/S3 já implementa corretamente o tratamento de `Range`/`Accept-Ranges`, então fazer proxy através da API (Opção A) só adicionaria latência e carga sem adicionar capacidade; a Opção C resolve um problema que esta fase não pede. As URLs pré-assinadas reaproveitam o mesmo cliente S3 escolhido no TD-01, sem biblioteca nova.

**Decisão:** B (redirecionamento por URL pré-assinada)

---

## Resumo das Decisões

| ID | Escopo | Decisão | Recomendação | Escolha |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Backend de Armazenamento de Objetos & SDK Cliente | MinIO + `@aws-sdk/client-s3` | A |
| TD-02 | Backend | Fila de Jobs em Segundo Plano & Topologia do Worker | BullMQ + Redis, worker em processo separado | A |
| TD-03 | Backend | Protocolo de Upload de Arquivos Grandes (10GB) | `tus` via `@tus/server` + `@tus/s3-store` | A |
| TD-04 | Backend | Pré-cadastro de Rascunho, Ciclo de Vida & Estratégia de Identificador | Pré-criar linha de rascunho (UUID) antes do upload começar; máquina de estados `draft→processing→ready/failed` | A |
| TD-05 | Backend | Processamento de Vídeo — Estratégia de Acesso a Bytes pelo Worker & Ferramental | Baixar para disco efêmero local do worker + `fluent-ffmpeg` | A |
| TD-06 | Backend | Estratégia de Entrega de Streaming & Download de Vídeo | Redirecionamento por URL pré-assinada (cliente↔armazenamento direto) | B |
