# Plano de Execução — Fase 03: Upload e Processamento de Vídeos

> Roteiro operacional para conduzir a Fase 03 do StreamTube de ponta a ponta, seguindo o
> workflow em pipeline do projeto (research → planejamento → implementação) com Claude Code.
> Baseado em [desafio-tecnico.md](desafio-tecnico.md), no [CLAUDE.md](CLAUDE.md) e nas skills em `.claude/`.

---

## 0. Leitura rápida do que já foi verificado

| Item | Estado atual | Ação |
|------|--------------|------|
| `compose.yaml` do backend | Existe em [nestjs-project/compose.yaml](nestjs-project/compose.yaml) — hoje só `nestjs-api`, `db` (postgres:17), `mailpit` | Estender com storage, fila e worker (SI de infra) |
| Docker CLI | **NÃO disponível** no PATH (Bash e PowerShell) | **Bloqueador** — instalar/subir Docker Desktop antes do Setup |
| `node_modules` do backend | **Ausente** | Instalar deps dentro do container (`docker compose exec nestjs-api npm install`) |
| Branch git | Só existe `main` | Criar `dev` e depois `feature/phase-03-videos` (Git Flow) |
| Skills do workflow | `research`, `plan-context`, `plan-validate`, `plan-resolve`, `plan-build`, `plan-test-specs`, `implement` | Invocar via `/nome-da-skill` |
| Sub-agents | `decisions-reader`, `decisions-detail-reader`, `decisions-correlator`, `phases-reader`, `plan-reader`, `inventory-digest-reader` | **Não invocar diretamente** — as skills os usam por baixo |
| Slug da fase | Definido pelo enunciado: `videos` → pasta `docs/phases/phase-03-videos/` | Usar `videos` como slug em toda a pipeline |

> **Atenção — pré-requisito não atendido:** o Docker não está acessível nesta máquina. Como toda a
> Definition of Done depende de rodar testes, tsc e lint **dentro do container**, e a fase inteira
> exige storage/fila/worker reais no Compose, **nada avança sem Docker funcionando**. Resolva isso na etapa 1.

---

## 1. Setup (pré-workflow)

Objetivo: ambiente rodando, suíte atual verde, Git Flow preparado. **Nenhuma skill aqui — trabalho manual.**

1. **Docker.** Instalar/abrir o Docker Desktop e confirmar:
   ```bash
   docker --version && docker compose version
   ```
2. **Subir a infra atual** (sem servir a API — regra do [nestjs-project/CLAUDE.md](nestjs-project/CLAUDE.md)):
   ```bash
   cd nestjs-project
   docker compose up -d
   docker compose ps                              # todos "running"
   docker compose exec db pg_isready -U streamtube # "accepting connections"
   ```
3. **Instalar dependências** (dentro do container):
   ```bash
   docker compose exec nestjs-api npm install
   ```
4. **Rodar migrations e confirmar suíte verde** (baseline antes de mexer em qualquer coisa):
   ```bash
   docker compose exec nestjs-api npm run migration:run
   docker compose exec nestjs-api npm test -- --runInBand
   docker compose exec nestjs-api npm run test:e2e
   docker compose exec nestjs-api npx tsc --noEmit
   docker compose exec nestjs-api npm run lint
   ```
5. **Git Flow.** Criar a branch de integração e a de feature a partir dela:
   ```bash
   git checkout -b dev            # se ainda não existir
   git checkout -b feature/phase-03-videos
   ```
   > Regra dura: **nunca** commitar em `main`. Feature sai de `dev` e volta para `dev`.
6. **MCP.** Confirmar que os servidores MCP (`context7`, `postgres`) estão conectados — a etapa de
   research e planejamento dependem do `context7` para consultar docs das libs novas.

**Critério de saída da etapa 1:** containers up, suíte baseline verde, tsc 0, lint ok, branch `feature/phase-03-videos` ativa.

---

## 2. Research — decisões técnicas

**Skill:** `/research phase 03` (ou `/research` descrevendo o escopo da Fase 03).
**Artefato:** `docs/decisions/technical-decisions-phase-03-videos.md`.
**Sub-agents acionados automaticamente:** `plan-reader` (lê a Fase 03 do project-plan), `decisions-reader` (decisões anteriores como restrições).

### O que a skill faz
Lê a Fase 03 em [docs/project-plan.md](docs/project-plan.md), identifica as decisões em aberto, pesquisa
opções (via `context7` + web) e gera um documento com Options/Trade-offs/Recommendation por TD, deixando
o campo `**Decision:**` como `_[pending]_` para **você** decidir.

### Decisões que PRECISAM sair desta etapa (do enunciado)
1. **Tecnologia de fila** — a grande decisão de stack (project-plan marca "TBD"). Ex.: BullMQ (Redis) vs. outras.
2. **Estratégia de upload de 10GB sem travar** — presigned URL / multipart direto ao storage vs. passar pela API (cross-layer).
3. **Worker** — como roda (container separado) e como extrai metadados/thumbnail (FFmpeg/ffprobe).
4. **URL única + streaming** — geração da URL única e streaming com range requests / `206 Partial Content`.
5. **Ciclo de status do vídeo** — rascunho → processando → pronto/erro e o comportamento em falha de processamento.

> **Object storage NÃO é decisão em aberto:** já é S3-compatível → **MinIO** local em Docker. O que se
> decide é *como usar* (buckets, organização de chaves, presigned URLs), não *qual* storage.

### Sua ação de maestro
- Revisar cada TD criticamente; se vier raso, refinar o prompt e re-rodar.
- **Preencher os campos `**Decision:**`** de cada TD (a skill recomenda, você decide).
- Consultar a versão instalada das libs candidatas antes de decidir (regra de docs de libs).

**Critério de saída:** documento de decisões com todas as 5 decisões resolvidas e justificadas (nenhum `_[pending]_`).

---

## 3. Planejamento (pipeline de 4 estágios)

Ordem canônica e obrigatória: **context → validate → resolve → validate (loop) → build**. Cada estágio
aborta com o próximo comando se um pré-requisito faltar. Todos os artefatos vão para `docs/phases/phase-03-videos/`.

### 3.1 `/plan-context videos`
- **Artefato:** `context.md`. Consolida project-plan + decisões da fase + fases anteriores + testing guide.
- **Sub-agents:** `phases-reader` (convenções das Fases 01/02), `decisions-reader`, `decisions-detail-reader`.
- Puro consolidador — não detecta problemas.

### 3.2 `/plan-validate videos`
- **Artefato:** `validation.md` com veredito `status: clean | dirty`.
- Aponta: inconsistências, ambiguidades, **decisões faltando (MD-N)**, gaps de dependência, conflitos herdados.
- Quase certo que sai `dirty` na primeira passada — isso é esperado.

### 3.3 `/plan-resolve videos`
- Lê `validation.md`, **pergunta a você** (batched via `AskUserQuestion`), aplica as respostas no documento de
  decisões + `context.md`, e **fixa as libs novas** em `library-refs.md` (confirmadas via `context7`).
- Espera-se `library-refs.md` nesta fase por causa de storage (SDK S3), fila (ex.: BullMQ) e FFmpeg.

### 3.4 Loop `validate ↔ resolve`
- Re-rodar `/plan-validate videos`. Se ainda `dirty`, voltar ao `/plan-resolve videos`. **Repetir até `status: clean`.**
- Referência de "clean": [docs/phases/phase-02-auth/validation.md](docs/phases/phase-02-auth/validation.md).

### 3.5 `/plan-build videos`
- **Artefato:** `docs/phases/phase-03-videos/phase-03-videos.md` — o plano executável.
- **Hard-block** se `validation.md` não estiver `clean`.
- Deve conter (formato do projeto, veja [phase-02-auth.md](docs/phases/phase-02-auth/phase-02-auth.md)):
  - **Step Implementations** `SI-03.1`, `SI-03.2`, … (máx. 5 ações e 5 arquivos de teste por SI; separar infra de comportamento).
  - **Technical Specifications:** Data Model, API Contracts, Authorization Matrix, Error Catalog e **Events/Messages** (obrigatório por causa da fila).
  - **Dependency Map** e **Deliverables** (checklist).

### 3.6 (Opcional) `/plan-test-specs videos`
- Só dispara se o plano marcar `test_specs_aware: true` e houver SIs com `**Test Specs:**`. Pode pular.

> **Dica do enunciado:** "Plano frouxo gera implementação frouxa." Gaste tempo aqui. SIs bem fatiados,
> contratos de API e eventos bem definidos = implementação limpa.

**Critério de saída:** `validation.md` em `clean` + `phase-03-videos.md` completo com SIs e todas as Technical Specifications aplicáveis.

---

## 4. Implementação

**Skill:** `/implement 3` (ou `/implement videos`). Para rodar sem pausar entre SIs: `/implement 3 continuous` (padrão é pausar e pedir confirmação a cada SI).
**Artefatos:** código + `docs/phases/phase-03-videos/progress.md` (status + testes por SI).

### Como a skill trabalha
- Faz preflight (checa branch — não pode ser `main`/`dev`; checa deps instaladas).
- Cria uma task por SI, implementa **um SI de cada vez** na ordem do Dependency Map.
- Após cada SI: roda **só os testes daquele SI**, atualiza `progress.md`, e **para** pedindo "Seguir para SI-03.X+1?" (modo default).
- Carrega skills de best-practices conforme o artefato do SI: `nestjs-best-practices`, `typeorm`, `testing-guide-nestjs-project`.

### Blocos de trabalho esperados (o fatiamento real sai do plano-build; isto é a expectativa)
1. **Infra no Compose** — adicionar em [nestjs-project/compose.yaml](nestjs-project/compose.yaml):
   - **MinIO** (object storage S3-compatível) + criação de bucket.
   - **Fila** (ex.: Redis para BullMQ, conforme a decisão da etapa 2).
   - **Worker de vídeo** (container com FFmpeg/ffprobe) consumindo a fila.
   - Lembrete de rede Docker: host = **nome do serviço** do Compose (`db`, `minio`, `redis`…), **nunca** `localhost`.
2. **Módulo de vídeos** (`src/videos/`) — usar `src/auth/` e `src/channels/` como referência de forma
   (separação de camadas, repository pattern, guard JWT, filtro de exceções). Entidade `Video` ligada ao canal.
3. **Migration** — `<timestamp>-CreateVideos.ts` em `src/database/migrations/` (entidade ligada ao canal;
   status, chaves de storage do arquivo e do thumbnail, duração, metadados, identificador de URL única).
4. **Fluxo de upload** — pré-cadastro como rascunho + estratégia assíncrona/direta ao storage (presigned).
5. **Worker** — processamento pós-upload: duração/metadados (ffprobe) + thumbnail (FFmpeg) + atualização de status no banco.
6. **Streaming + download** — range requests / `206 Partial Content` e endpoint de download.
7. **Testes por nível** (sufixos do projeto):
   - `*.spec.ts` (unit, tudo mockado),
   - `*.integration-spec.ts` (banco/serviços reais — MinIO/fila do Compose),
   - `*.e2e-spec.ts` (HTTP via supertest, em `test/`).
   - **Não mocke o que dá para testar de verdade** com a infra do Compose.

### Regra de ouro do upload
Nunca passe o arquivo de 10GB inteiro pela API de forma que trave o sistema — isso é **reprova automática**.
A estratégia (presigned/multipart direto ao storage) tem que estar refletida no código.

**Critério de saída:** todos os SIs com `progress.md` marcado `completed` e testes verdes por SI.

---

## 5. Fechamento (Definition of Done)

Rodar **tudo dentro do container** e confirmar verde antes do push:

```bash
docker compose exec nestjs-api npm test -- --runInBand   # unit + integração
docker compose exec nestjs-api npm run test:e2e          # e2e
docker compose exec nestjs-api npx tsc --noEmit          # deve sair com código 0
docker compose exec nestjs-api npm run lint              # sem erros
docker compose exec nestjs-api npm run build             # compila
```

Depois:
1. **Atualizar a documentação de IA** — seção de vídeos no [CLAUDE.md](CLAUDE.md) raiz e/ou no
   [nestjs-project/CLAUDE.md](nestjs-project/CLAUDE.md): módulo de vídeos, endpoints, fila/worker, storage.
   Documentação que cite arquivo ou comportamento inexistente **reprova**.
2. **Revisar os Critérios de Aceite do enunciado item a item** (seção "Critérios de Aceite" do desafio).
3. **Commit e integração** — commits curtos e descritivos na `feature/phase-03-videos`; PR/merge para `dev`.
   (A skill `implement` não faz git — o controle de versão é seu.)

---

## 6. Mapa rápido: etapa → skill → artefato

| # | Etapa | Comando / Skill | Artefato de saída | Sub-agents (automáticos) |
|---|-------|-----------------|-------------------|--------------------------|
| 1 | Setup | manual (docker, git) | ambiente + branch | — |
| 2 | Research | `/research phase 03` | `docs/decisions/technical-decisions-phase-03-videos.md` | `plan-reader`, `decisions-reader` |
| 3.1 | Contexto | `/plan-context videos` | `.../phase-03-videos/context.md` | `phases-reader`, `decisions-reader`, `decisions-detail-reader` |
| 3.2 | Validação | `/plan-validate videos` | `.../validation.md` (clean/dirty) | `decisions-reader` |
| 3.3 | Resolução | `/plan-resolve videos` | edita decisões + `context.md` + `library-refs.md` | — |
| 3.4 | Loop | `/plan-validate videos` (repetir) | `validation.md` → `clean` | — |
| 3.5 | Plano | `/plan-build videos` | `.../phase-03-videos.md` | — |
| 3.6 | Test specs (opc.) | `/plan-test-specs videos` | specs de teste | — |
| 4 | Implementação | `/implement 3` | código + `.../progress.md` | — |
| 5 | Fechamento | manual (DoD + docs + git) | suíte verde + CLAUDE.md atualizado | — |

---

## 7. Checklist de reprova automática (não fazer)

- [ ] Pular etapas do workflow (implementar sem research/planejamento/artefatos).
- [ ] Plano sem SIs ou sem Technical Specifications; `validation.md` que não fecha em `clean`.
- [ ] Passar o arquivo de 10GB pela API travando o sistema (sem upload assíncrono/direto).
- [ ] Não ter fila, worker e storage reais subindo no Compose.
- [ ] `tsc` com erro, lint quebrado ou suíte vermelha.
- [ ] Commit direto na `main`.
- [ ] CLAUDE.md inconsistente com o código.

---

## 8. Pontos de atenção / dúvidas a confirmar antes de começar

1. **Docker ausente na máquina** — bloqueador nº 1. Sem ele, nem o Setup nem a DoD rodam. Confirmar instalação.
2. **Tecnologia de fila** — decisão real de stack (etapa 2). Se pretende BullMQ, já implica adicionar **Redis**
   ao Compose; se preferir algo sem Redis, isso muda a infra. Definir na research.
3. **Estratégia de upload** — presigned URL direto ao MinIO é o caminho recomendado para 10GB. Confirmar que
   o cliente (frontend/teste) fará o PUT direto ao storage, e a API só orquestra (pré-cadastro + presign + callback/polling).
4. **Escopo é backend** — o frontend de vídeo **não** faz parte desta fase (apesar de existir `next-frontend/`).
