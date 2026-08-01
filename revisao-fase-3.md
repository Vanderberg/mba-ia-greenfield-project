# Revisão Crítica — `technical-decisions-phase-03-upload-processing.md`

Data da revisão: 2026-07-25
Arquivo revisado: `docs/decisions/technical-decisions-phase-03-upload-processing.md`

Avaliação geral: os 6 TDs têm opções e trade-offs bem escritos, mas **três** (TD-02, TD-04, TD-05) ficam rasos em pontos que são justamente os mais arriscados da fase (arquivos de 10GB, processamento em background). Também há **lacunas transversais** — decisões reais que a fase precisa, mas que não aparecem em nenhum TD porque caem "entre" dois deles.

---

## TD-01 — Object Storage Backend & Client SDK

**Veredito: adequado, com uma lacuna que se propaga para o TD-06.**

- Não discute **endpoint duplo do MinIO**: o cliente S3 da API resolve `minio` (nome do serviço Compose), mas qualquer URL entregue ao navegador (presigned URL, no TD-06) precisa de um host **alcançável pelo browser** (`localhost:9000` em dev, domínio público em prod) — não `minio:9000`. Isso não é mencionado aqui nem no TD-06, e é exatamente o tipo de detalhe que a regra "sempre use o nome do serviço Compose, nunca localhost" do `CLAUDE.md` pode levar a implementar errado.
- Não trata política de bucket/objeto (privado por padrão) nem lifecycle de custo — aceitável adiar para quando visibilidade pública/unlisted existir (Fase 04), mas vale registrar como pressuposto explícito, já que "Pontos de Atenção" do `project-plan.md` já cita custo de armazenamento como preocupação da própria Fase 03.

## TD-02 — Background Job Queue & Worker Topology

**Veredito: raso — falta a decisão mais importante da fila.**

- **Não decide como o job é enfileirado.** O TD assume que "a video processing job" existe, mas nunca decide o gatilho: hook `onUploadFinish` do tus (TD-03), evento `ObjectCreated` do MinIO, ou chamada explícita da API após o upload terminar? Essa é uma decisão de arquitetura real (acopla TD-02, TD-03 e TD-04) e está ausente dos três.
- **Não discute idempotência.** A própria lista de categorias do skill de research ("retry strategy; idempotency") pede isso explicitmente para "Background jobs & workers" — e aqui é crítico: se o worker cai a meio de um job de 10GB e o BullMQ reenfileira, o reprocessamento pode gerar thumbnail/metadata duplicados ou escritas parciais no `Video`. Nenhuma estratégia (chave de idempotência, upsert, checagem de estado antes de reprocessar) é mencionada.
- **Não trata falha permanente (dead-letter).** Se o FFmpeg falhar definitivamente (arquivo corrompido, codec não suportado), o que acontece com a linha do vídeo? Fica `draft` para sempre? Precisa de um status `failed`? Isso conecta com a lacuna de state machine do TD-04.

## TD-03 — Large File Upload Protocol (10GB)

**Veredito: bom nas opções, mas falta autenticação e limpeza de upload abandonado.**

- **Autenticação/autorização no endpoint `tus` não é discutida.** O protocolo `tus` não carrega auth nativamente — como o token de sessão (Fase 02) chega numa requisição `PATCH` de upload em chunks? Isso é essencial: só o dono do canal pode iniciar/continuar um upload. Sem isso, o TD descreve só "como os bytes trafegam", não "quem pode enviá-los".
- **Não menciona limpeza de uploads incompletos.** O próprio `@tus/s3-store` documenta uma lifecycle policy do S3 para expirar multipart uploads abandonados (ex.: usuário fecha a aba aos 3GB de 10GB) — sem isso, storage cresce indefinidamente com uploads nunca finalizados. Ponto relevante porque "Pontos de Atenção" do plano já cita custo de armazenamento como risco.

## TD-04 — Video Draft Pre-registration & Identifier Strategy

**Veredito: raso — resolve bem o problema errado (unicidade de ID), mas não decide o que a capability pede (ciclo de vida do rascunho).**

- O TD nasceu para responder "URL única" e acabou absorvendo isso quase por completo (via convenção de UUID já existente, que é um não-problema). A pergunta que a capability *"Pré-cadastro automático do vídeo como rascunho"* realmente levanta — **qual é a máquina de estados do vídeo** (`draft` → `uploading`/`processing` → `ready`/`failed`) e quem transiciona cada estado — não é tratada. Isso é uma decisão estratégica de verdade (cross-cutting entre TD-02, TD-03 e o futuro painel de gerenciamento da Fase 04) e está ausente.
- Não trata **uploads abandonados**: se o draft é criado antes do upload começar (Opção A escolhida) e o usuário nunca envia um byte, fica um `Video` órfão sem arquivo. Precisa de TTL/limpeza? Não é mencionado.

## TD-05 — Video Processing Tooling (Metadata & Thumbnail Extraction)

**Veredito: o mais raso dos seis — decide a biblioteca (`fluent-ffmpeg` vs `child_process`) e ignora a pergunta arquitetural real.**

- **Falta completamente:** como o worker busca os bytes do vídeo (potencialmente 10GB) para o FFmpeg processar? Baixar o objeto inteiro para disco local do worker antes de rodar `ffmpeg`/`ffprobe`, ou fazer streaming via range-GET direto para o stdin do processo? A primeira opção exige um volume/tmpfs dimensionado para o maior upload permitido *por job concorrente*; a segunda é mais eficiente mas complica seek para extração de frame (thumbnail) em um stream não-seekável. **Essa é a decisão realmente arriscada da fase de processamento — não a escolha de wrapper de CLI.**
- Pela mesma régua que o próprio skill usa (teste "(d) best-practices resolution + (a) cross-component contract"), a escolha `fluent-ffmpeg` vs `child_process` bruto é discutivelmente um detalhe de implementação (resolvido por convenção/skill de código), não um TD — enquanto a estratégia de acesso aos bytes é o TD que devia estar aqui.
- Não menciona limpeza do arquivo temporário após o processamento (espaço em disco do worker crescendo a cada job).

## TD-06 — Video Streaming & Download Delivery Strategy

**Veredito: bem argumentado, mas depende de uma premissa não verificada (ver TD-01).**

- Presigned URL só funciona se o host assinado for alcançável pelo navegador — o TD não verifica/declara essa premissa (é a mesma lacuna do TD-01).
- Não menciona **CORS** no MinIO: o navegador faz a requisição de range diretamente para um host diferente da API (`minio`/porta do MinIO vs porta da API) — sem CORS configurado no bucket/serviço, a Opção B recomendada simplesmente não funciona em produção.

---

## Lacunas transversais (não cobertas por nenhum TD isoladamente)

Estes pontos aparecem "entre" os TDs e por isso nenhum dos seis os assume:

1. **Gatilho de enfileiramento do job de processamento** (TD-02 ↔ TD-03 ↔ TD-04).
2. **Máquina de estados do vídeo** (`draft`/`processing`/`ready`/`failed`) e quem a transiciona (TD-02 ↔ TD-04 ↔ TD-05).
3. **Autenticação no endpoint de upload `tus`** (TD-03).
4. **Limpeza de uploads incompletos e drafts órfãos** (TD-01 ↔ TD-03 ↔ TD-04).
5. **Estratégia de acesso a bytes de até 10GB pelo worker** (download completo vs streaming) (TD-05) — provavelmente o gap mais sério tecnicamente.
6. **Endpoint público vs interno do MinIO** para presigned URLs, e CORS (TD-01 ↔ TD-06).
7. **Idempotência e dead-letter em caso de falha do worker** (TD-02).

## Recomendação

Antes de preencher `**Decision:**`, considerar:
- Expandir TD-05 para incluir a estratégia de acesso a bytes (item 5) como opções reais (é a decisão de maior risco técnico da fase).
- Adicionar ao TD-04 (ou um TD-04b) a máquina de estados do vídeo (item 2) e a política de limpeza de rascunhos órfãos (item 4).
- Adicionar ao TD-02 um parágrafo/opção sobre gatilho de enfileiramento (item 1) e idempotência (item 7).
- Adicionar ao TD-03 uma nota sobre autenticação no endpoint `tus` (item 3) e lifecycle de uploads incompletos (item 4).
- Adicionar ao TD-01/TD-06 a premissa do endpoint público do MinIO + CORS (item 6).

Nenhum desses pontos exige um TD novo isolado — todos cabem como texto adicional (contexto + opções) nos TDs existentes, exceto o item 5 (estratégia de acesso a bytes), que merece opções formais dentro do TD-05.
