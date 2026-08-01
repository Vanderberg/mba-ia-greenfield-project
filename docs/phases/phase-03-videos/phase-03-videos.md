---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/project-plan.md: "2026-07-14T19:57:16-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-07-26T19:07:44-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-07-26T19:46:27-03:00"
  docs/phases/phase-01-configuracao-base/context.md: "2026-07-14T19:57:16-03:00"
  docs/phases/phase-02-auth/context.md: "2026-07-14T19:57:16-03:00"
  docs/phases/phase-02-auth-frontend/context.md: "2026-07-14T19:57:16-03:00"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-07-14T19:57:16-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Entregar o módulo de vídeos da Fase 03: armazenamento de arquivos (vídeos e thumbnails) via MinIO/S3, fila de processamento em segundo plano com worker dedicado, upload resumível de até 10GB sem impacto na performance, pré-cadastro automático do vídeo como rascunho ao iniciar o upload, processamento automático (duração, metadados e thumbnail via FFmpeg), URL única por vídeo, e reprodução via streaming com download disponível.

---

## Step Implementations

### SI-03.1 — Infra: Dependências, Docker Compose e Namespaces de Configuração

**Description:** Instala as bibliotecas decididas na fase, sobe MinIO e Redis via Compose, adiciona o serviço do worker de vídeo, e cria os namespaces de configuração (`registerAs`) para storage e fila, seguindo a convenção herdada de `@nestjs/config` (per `## Inherited Conventions`).

**Technical actions:**

1. Instalar `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, `bullmq`, `@nestjs/bullmq`, `ioredis`, `@tus/server`, `@tus/s3-store`, `fluent-ffmpeg`, `@ffmpeg-installer/ffmpeg`, `@ffprobe-installer/ffprobe` (per `phase-03-videos/TD-01`, `phase-03-videos/TD-02`, `phase-03-videos/TD-03`, `phase-03-videos/TD-05`, `phase-03-videos/TD-06`)
2. Adicionar o serviço `minio` a `nestjs-project/compose.yaml` (imagem oficial, volume persistente, portas do console + API expostas ao host) (per `phase-03-videos/TD-01`)
3. Adicionar o serviço `redis` a `nestjs-project/compose.yaml` (per `phase-03-videos/TD-02`)
4. Adicionar o serviço `video-worker` a `nestjs-project/compose.yaml`, com Dockerfile próprio apontando para um entrypoint separado do processo da API (per `phase-03-videos/TD-02`)
5. Criar `src/config/storage.config.ts` e `src/config/queue.config.ts` via `registerAs`, seguindo o padrão de `databaseConfig`/`appConfig` já estabelecido (per `## Inherited Conventions`) — `storage.config.ts` expõe `S3_INTERNAL_ENDPOINT` e `S3_PUBLIC_ENDPOINT` distintos (per `phase-03-videos/TD-01`'s dual-endpoint premise)

**Tests:** _(empty — Infra)_

**Dependencies:** none

**Acceptance criteria:**

- `docker compose ps` mostra os serviços `minio`, `redis` e `video-worker` com status `running`
- O console do MinIO responde na porta mapeada para o host
- `redis-cli -h redis ping` (executado de dentro do container `nestjs-api`) retorna `PONG`
- `ConfigModule` resolve `storageConfig` e `queueConfig` via `ConfigType<typeof ...>` sem erros de inicialização

---

### SI-03.2 — Entidade Video e Migration

**Description:** Cria a entidade `Video` e a migration correspondente, com o ciclo de vida de status e a chave de storage determinística que servem de base para todo o restante da fase.

**Technical actions:**

1. Criar `src/videos/entities/video.entity.ts` com os campos, relação e índices descritos em `## Technical Specifications → Data Model → Video` (`id`, `channelId`, `title`, `status`, `storageKey`, `thumbnailKey`, `durationSeconds`, timestamps) (per `phase-03-videos/TD-04`, `phase-03-videos/TD-01`, `phase-03-videos/TD-05`)
2. Criar a migration `<timestamp>-CreateVideos.ts` — tabela `videos`, FK `channelId → channels.id`, índice único em `storageKey`, índice em `status`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` | Integration: constraints, defaults (`status` default `'draft'`), unique `storageKey`, FK a `Channel` | `src/videos/entities/video.entity.integration-spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- A migration cria a tabela `videos` com FK para `channels.id`
- Inserir duas linhas com o mesmo `storageKey` viola a constraint de unicidade
- Uma linha inserida sem `status` explícito recebe `'draft'`

---

### SI-03.3 — Módulos de Storage e Fila (Cliente S3, URLs Pré-assinadas, Producer BullMQ)

**Description:** Encapsula o cliente S3/MinIO e a geração de URLs pré-assinadas num `StorageModule`, e registra a fila `process-video` (lado producer) num `QueueModule` — a infraestrutura que todo o resto da fase consome.

**Technical actions:**

1. Criar `StorageModule`/`StorageService` configurando `S3Client` com endpoint interno (`S3_INTERNAL_ENDPOINT`, `forcePathStyle: true`) (per `phase-03-videos/TD-01`)
2. Implementar `StorageService.getPresignedUrl(key, { download?: boolean })` via `@aws-sdk/s3-request-presigner`, assinando contra `S3_PUBLIC_ENDPOINT` e aplicando `ResponseContentDisposition: attachment` quando `download: true` (per `phase-03-videos/TD-06`)
3. Registrar a fila `process-video` via `BullModule.registerQueue({ name: 'process-video' })` no módulo da API (lado producer) (per `phase-03-videos/TD-02`)
4. Provisionar, uma única vez, o bucket do MinIO com política privada, CORS (`AllowedMethods: GET`, `AllowedHeaders: Range`) e a lifecycle rule de expiração de multipart uploads incompletos (script de bootstrap ou documentação de setup manual) (per `phase-03-videos/TD-01`, `phase-03-videos/TD-03`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageService` | Integration: real MinIO test bucket — upload, `getPresignedUrl` (stream e download), round-trip de bytes | `src/storage/storage.service.integration-spec.ts` |
| `StorageModule` / `QueueModule` | Unit: compilation test (imports resolvem, `ConfigType` injetado corretamente) | `src/storage/storage.module.spec.ts` |

**Dependencies:** SI-03.1 (MinIO, Redis e config de storage/fila precisam existir)

**Acceptance criteria:**

- `StorageService.getPresignedUrl(key)` retorna uma URL que, ao ser buscada, responde `200` com os bytes exatos do objeto
- `StorageService.getPresignedUrl(key, { download: true })` retorna uma URL cuja resposta inclui `Content-Disposition: attachment`
- O bucket aceita requisições `GET` com header `Range` vindas da origem configurada (CORS)
- `Test.createTestingModule({ imports: [StorageModule, QueueModule] }).compile()` não lança erro de DI

---

### SI-03.4 — Endpoints de Pré-cadastro do Vídeo (POST /videos, GET /videos/:id)

**Description:** Implementa o pré-cadastro automático do vídeo como rascunho e o endpoint de leitura de status, satisfazendo a capacidade "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload" antes de qualquer byte ser enviado.

**Technical actions:**

1. Criar `VideosModule` com `VideosService.createDraft(channelId)` — gera o `id` (UUID, per a convenção já estabelecida `@PrimaryGeneratedColumn('uuid')`), deriva `storageKey` deterministicamente (`videos/{id}/original`), insere a linha com `status: 'draft'` (per `phase-03-videos/TD-04`)
2. Criar `VideosController` com `POST /videos` (guard JWT, per `## Technical Specifications → Authorization Matrix`) e `GET /videos/:id` (auth opcional; regra de visibilidade por `status`, per o rodapé da Authorization Matrix)
3. Registrar `VideosModule` em `AppModule`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.createDraft` | Unit: branch logic (mock repo) — geração de `storageKey`, status inicial | `src/videos/videos.service.spec.ts` |
| `POST /videos`, `GET /videos/:id` | E2E: shape de resposta, guard JWT, regra de visibilidade | `test/videos-draft.e2e-spec.ts` |

**Dependencies:** SI-03.2 (entidade `Video` precisa existir)

**Acceptance criteria:**

- `POST /videos` com token válido retorna `201` com `{ id, status: "draft" }`
- `POST /videos` sem token retorna `401 UNAUTHORIZED`
- `GET /videos/:id` retorna `404 VIDEO_NOT_FOUND` para um id inexistente
- `GET /videos/:id` do dono do canal retorna o status real independentemente do valor
- `GET /videos/:id` de um não-dono para um vídeo não-`ready` retorna `403 VIDEO_NOT_VISIBLE`

---

### SI-03.5 — Endpoint de Upload Resumível (tus)

**Description:** Monta o protocolo `tus` para o upload de até 10GB sem travar a API, com autenticação, verificação de posse do rascunho e disparo do enfileiramento ao término do upload — o núcleo da capacidade "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance".

**Technical actions:**

1. Montar `@tus/server` em `POST/HEAD/PATCH /uploads`, com `@tus/s3-store` apontando para o bucket configurado em `StorageModule` (per `phase-03-videos/TD-03`)
2. Implementar `onIncomingRequest` validando o Bearer token (reaproveitando o guard JWT já existente) (per `phase-03-videos/TD-03`)
3. Implementar `onUploadCreate` validando que `Upload-Metadata.videoId` referencia uma linha `Video` em `status: 'draft'` pertencente ao canal do usuário autenticado; rejeita com `400 UPLOAD_METADATA_INVALID` ou `403 UPLOAD_FORBIDDEN` caso contrário (per `phase-03-videos/TD-04`, `phase-03-videos/TD-03`)
4. Implementar `onUploadFinish` — atualiza `Video.status` para `'processing'` e enfileira o job `process-video` com `jobId: videoId` (per `phase-03-videos/TD-02`'s Context)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| Fluxo `tus` completo (create → patch em chunks → finish) | E2E: upload real contra MinIO via `tus-js-client`, incluindo retomada após queda simulada de conexão | `test/videos-upload.e2e-spec.ts` |
| `onUploadCreate` / `onIncomingRequest` | E2E: casos 401/400/403 (token ausente, metadata inválido, canal errado) | `test/videos-upload-auth.e2e-spec.ts` |

**Dependencies:** SI-03.3 (storage + fila) + SI-03.4 (rascunho precisa existir antes da sessão `tus`)

**Acceptance criteria:**

- Uma sessão `tus` sem token retorna `401 UNAUTHORIZED`
- `POST /uploads` sem `videoId` no `Upload-Metadata` retorna `400 UPLOAD_METADATA_INVALID`
- `POST /uploads` com `videoId` de um rascunho de outro canal retorna `403 UPLOAD_FORBIDDEN`
- Um upload interrompido no meio do caminho é retomado com sucesso a partir do offset correto (via `HEAD`)
- Ao final do upload, `Video.status` muda de `draft` para `processing` e um job `process-video` é enfileirado

---

### SI-03.6 — Worker de Processamento de Vídeo (FFmpeg + Dead-letter)

**Description:** Implementa o processo separado do worker que consome o job `process-video`, extrai duração/metadados e thumbnail via FFmpeg, e trata falhas permanentes — cobrindo "Processamento automático do vídeo após upload" e "Geração automática de thumbnail".

**Technical actions:**

1. Criar o bootstrap do worker (`src/worker/main.ts`, `NestFactory.createApplicationContext`) registrando `VideoProcessor` como `@Processor('process-video')` no `AppModule` próprio do worker — processo separado do da API (per `phase-03-videos/TD-02`)
2. Implementar `VideoProcessor.process(job)` — baixa o objeto original para um arquivo temporário local via `StorageService` (per `phase-03-videos/TD-05`'s Opção A)
3. Rodar `ffmpeg.ffprobe` (duração + metadados) e `ffmpeg(...).screenshots()` (thumbnail em `'50%'`) sobre o arquivo temporário; enviar o thumbnail ao storage; fazer upsert de `Video` (`status: 'ready'`, `thumbnailKey`, `durationSeconds`) (per `phase-03-videos/TD-05`, `phase-03-videos/TD-02`'s idempotência)
4. Apagar o arquivo temporário em bloco `finally`, independentemente de sucesso ou falha (per `phase-03-videos/TD-05`)
5. Configurar `attempts`/`backoff` do job e o listener `worker.on('failed', ...)` que atualiza `Video.status` para `'failed'` quando as tentativas se esgotam (per `phase-03-videos/TD-02`'s Context — dead-letter)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessor.process` | Integration: real fila BullMQ + real MinIO + FFmpeg real sobre um arquivo de vídeo de teste — valida duração, thumbnail gerado e `status: ready` | `src/worker/video.processor.integration-spec.ts` |
| Dead-letter | Integration: job configurado para falhar sempre atinge `attempts` esgotados e `status` vira `'failed'` | `src/worker/video.processor.integration-spec.ts` |

**Dependencies:** SI-03.2 (entidade) + SI-03.3 (storage + fila, lado consumer)

**Acceptance criteria:**

- Um job `process-video` válido resulta em `Video.status: 'ready'` com `durationSeconds` e `thumbnailKey` preenchidos
- O arquivo temporário local não existe mais em disco após o processamento (sucesso ou falha)
- Um job que falha repetidamente até esgotar `attempts` deixa `Video.status: 'failed'`
- Um reprocessamento do mesmo `jobId` (retry após crash) não duplica nem corrompe o estado do `Video` (upsert idempotente)

---

### SI-03.7 — Endpoints de Streaming e Download

**Description:** Implementa os endpoints de redirecionamento por URL pré-assinada que entregam "Reprodução via streaming" e "Download do vídeo pelo usuário" sem que os bytes do vídeo transitem pela API.

**Technical actions:**

1. Implementar `GET /videos/:id/stream` — carrega o `Video`, valida `status: 'ready'`, redireciona (`302`) para `StorageService.getPresignedUrl(storageKey)` (per `phase-03-videos/TD-06`)
2. Implementar `GET /videos/:id/download` — mesma validação, redireciona para `StorageService.getPresignedUrl(storageKey, { download: true })` (per `phase-03-videos/TD-06`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `GET /videos/:id/stream`, `GET /videos/:id/download` | E2E: redirecionamento `302`, `404`/`409` para vídeo inexistente/não pronto, requisição de `Range` contra a URL assinada resultando em `206` | `test/videos-delivery.e2e-spec.ts` |

**Dependencies:** SI-03.3 (storage) + SI-03.4 (entidade/status do vídeo)

**Acceptance criteria:**

- `GET /videos/:id/stream` de um vídeo `ready` retorna `302` para uma URL que responde `206 Partial Content` a uma requisição com header `Range`
- `GET /videos/:id/download` de um vídeo `ready` retorna `302` para uma URL cuja resposta inclui `Content-Disposition: attachment`
- Ambos os endpoints retornam `409 VIDEO_NOT_READY` para um vídeo em `draft`, `processing` ou `failed`
- Ambos os endpoints retornam `404 VIDEO_NOT_FOUND` para um `id` inexistente

---

### SI-03.8 — Job Agendado de Limpeza de Rascunhos Órfãos

**Description:** Remove linhas `Video` que ficaram em `status: 'draft'` sem upload correspondente além do TTL, evitando acúmulo permanente de rascunhos órfãos (per `phase-03-videos/TD-04`'s Context).

**Technical actions:**

1. Registrar um job repetível de baixa frequência (ex.: a cada 6h) via a opção de repeat do BullMQ, no bootstrap do worker (per `phase-03-videos/TD-04`)
2. Implementar `DraftCleanupProcessor` — apaga linhas `Video` com `status: 'draft'` e `createdAt` além do TTL (48h) (per `phase-03-videos/TD-04`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `DraftCleanupProcessor` | Integration: real DB — rascunho antigo é removido, rascunho recente e vídeos não-`draft` são preservados | `src/worker/draft-cleanup.processor.integration-spec.ts` |

**Dependencies:** SI-03.3 (fila) + SI-03.4 (entidade/status)

**Acceptance criteria:**

- Um `Video` em `status: 'draft'` criado há mais de 48h é removido pelo job
- Um `Video` em `status: 'draft'` criado há menos de 48h permanece intacto
- Um `Video` em `status: 'processing'`, `'ready'` ou `'failed'` nunca é removido pelo job, independentemente da idade

---

### SI-03.9 — Suíte E2E do Fluxo Completo de Upload, Processamento e Entrega

**Description:** Valida, contra a infraestrutura real do Compose (MinIO, Redis, worker), o fluxo ponta a ponta que a Fase 03 promete entregar: pré-cadastro → upload resumível → processamento → streaming/download — fechando o Definition of Done desta fase.

**Technical actions:**

1. Autor `test/videos-upload-flow.e2e-spec.ts` — fluxo feliz completo: `POST /videos` → sessão `tus` até o fim → aguarda `status: 'ready'` → `GET /videos/:id/stream` (`206` com `Range`) → `GET /videos/:id/download` (`Content-Disposition: attachment`)
2. Autor `test/videos-upload-resume.e2e-spec.ts` — upload interrompido no meio e retomado com sucesso via `HEAD`/`PATCH`, resultando no mesmo fluxo feliz ao final
3. Autor `test/videos-processing-failure.e2e-spec.ts` — upload de um arquivo que força falha de processamento (ex.: não é um vídeo válido) resulta em `Video.status: 'failed'` após esgotar as tentativas

**Tests:** _(as próprias ações desta SI já são a autoria dos arquivos de teste — não há uma camada adicional de teste sobre os testes)_

**Dependencies:** SI-03.5 (upload) + SI-03.6 (worker) + SI-03.7 (streaming/download)

**Acceptance criteria:**

- O fluxo feliz completo (rascunho → upload → processamento → streaming → download) passa de ponta a ponta contra a infraestrutura real do Compose
- Um upload retomado após queda de conexão chega ao mesmo resultado do fluxo feliz
- Um arquivo inválido resulta em `Video.status: 'failed'` de forma observável via `GET /videos/:id`
- `npm run test:e2e` (nestjs-project) passa incluindo os três specs desta SI

---

## Technical Specifications

### Data Model

#### Video

| Field | Type | Constraints |
|-------|------|-------------|
| id | uuid | PK, generated — doubles as the unique public video identifier, no separate slug (per `phase-03-videos/TD-04`) |
| channelId | uuid | FK → Channel, not null |
| title | varchar(255) | nullable — draft has no title until Phase 04's editing flow lands |
| status | enum('draft', 'processing', 'ready', 'failed') | not null, default `'draft'` (per `phase-03-videos/TD-04`'s status lifecycle) |
| storageKey | varchar(512) | not null, unique — derived deterministically from `id` (e.g. `videos/{id}/original`) (per `phase-03-videos/TD-01`, `phase-03-videos/TD-04`) |
| thumbnailKey | varchar(512) | nullable — set once processing succeeds (per `phase-03-videos/TD-05`) |
| durationSeconds | integer | nullable — set once processing succeeds (per `phase-03-videos/TD-05`) |
| createdAt | timestamptz | default now() |
| updatedAt | timestamptz | default now(), updated on every status transition |

**Relations:** `Channel` has many `Video` (one-to-many); `Video` belongs to `Channel`.
**Indexes:** unique on `storageKey`; index on `channelId`; index on `status` (worker dead-letter handling and the orphan-draft cleanup job both filter by `status`, per `phase-03-videos/TD-02` and `phase-03-videos/TD-04`).

---

### API Contracts

#### POST /videos (SI-03.4)

**Request headers:**
- Authorization: Bearer {accessToken}, required

**Request body:** _None._

**Response 201:**
- id: string (uuid)
- status: string — always `"draft"` on creation

**Error responses:**
- 401 UNAUTHORIZED: when the access token is missing or invalid

---

#### GET /videos/:id (SI-03.4)

**Request headers:**
- Authorization: Bearer {accessToken}, optional — required only to see a non-`ready` video (per the Authorization Matrix footnote below)

**Response 200:**
- id: string (uuid)
- status: string — one of `draft` \| `processing` \| `ready` \| `failed`
- title: string \| null
- durationSeconds: number \| null
- thumbnailUrl: string \| null — presigned URL (per `phase-03-videos/TD-06`), present only when `status: ready`

**Error responses:**
- 404 VIDEO_NOT_FOUND: when the id does not exist
- 403 VIDEO_NOT_VISIBLE: when the video is not `ready` and the requester is not the owning channel's user

---

#### POST /uploads (SI-03.5)

Mounts the `tus` resumable-upload protocol (per `phase-03-videos/TD-03`). This is the `tus` creation extension request — not a conventional REST body.

**Request headers:**
- Authorization: Bearer {accessToken}, required — validated in the `onIncomingRequest` hook (per `phase-03-videos/TD-03`)
- Upload-Length: integer, required — total file size in bytes (must not exceed the 10GB cap)
- Upload-Metadata: base64 tus metadata pairs, required — MUST include `videoId` (the id returned by `POST /videos`)
- Tus-Resumable: "1.0.0", required

**Response 201:**
- Location header: the created upload resource path (`/uploads/{tusUploadId}`)

**Error responses:**
- 401 UNAUTHORIZED: token missing/invalid (`onIncomingRequest`)
- 400 UPLOAD_METADATA_INVALID: `videoId` missing from `Upload-Metadata`, or no matching draft `Video` row exists (`onUploadCreate`, per `phase-03-videos/TD-04`)
- 403 UPLOAD_FORBIDDEN: the authenticated user's channel does not own the `videoId` referenced in the metadata (`onUploadCreate`, per `phase-03-videos/TD-03`)
- 413 payload too large: `Upload-Length` exceeds the 10GB cap

---

#### PATCH /uploads/:uploadId (SI-03.5)

`tus` chunk upload — repeated per chunk until the upload completes. Standard `tus` headers (`Upload-Offset`, `Content-Type: application/offset+octet-stream`, `Tus-Resumable`).

**Response 204:** No content. `Upload-Offset` response header reflects the new offset.

**Error responses:**
- 401 UNAUTHORIZED: token missing/invalid, or the token no longer matches the upload's owner (`onIncomingRequest`)
- 409 conflict: `Upload-Offset` does not match the server's recorded offset (standard `tus` semantics)

---

#### HEAD /uploads/:uploadId (SI-03.5)

`tus` offset query, used by the client to resume after a dropped connection.

**Response 200:** `Upload-Offset` and `Upload-Length` response headers; no body.

**Error responses:**
- 401 UNAUTHORIZED: token missing/invalid, or does not match the upload's owner
- 404 not found: unknown or expired upload resource

---

#### GET /videos/:id/stream (SI-03.7)

**Request headers:**
- Range: bytes=... , optional — forwarded natively by the browser's `<video>` element once redirected (per `phase-03-videos/TD-06`)

**Response 302:** redirect to a short-lived presigned `GetObject` URL (per `phase-03-videos/TD-06`); the browser's own subsequent `Range` request against that URL is answered directly by MinIO/S3 with `206 Partial Content`.

**Error responses:**
- 404 VIDEO_NOT_FOUND: when the id does not exist
- 409 VIDEO_NOT_READY: when `status` is not `ready`

---

#### GET /videos/:id/download (SI-03.7)

**Response 302:** redirect to a short-lived presigned `GetObject` URL with `ResponseContentDisposition: attachment` (per `phase-03-videos/TD-06`) — same mechanism as streaming, one parameter apart.

**Error responses:**
- 404 VIDEO_NOT_FOUND: when the id does not exist
- 409 VIDEO_NOT_READY: when `status` is not `ready`

---

#### Validation Rules — Video Endpoints

- `Upload-Length` (tus creation): required, integer, `<= 10 * 1024^3` bytes (10GB cap, per `phase-03-videos/TD-03`)
- `Upload-Metadata.videoId` (tus creation): required, must resolve to an existing `Video` row in `status: draft` owned by the authenticated user's channel (per `phase-03-videos/TD-04`)

---

### Authorization Matrix

| Endpoint | Anonymous | Authenticated (non-owner) | Owner |
|----------|-----------|---------------------------|-------|
| POST /videos | ✗ | ✗ | ✓ |
| GET /videos/:id | ✓* | ✓* | ✓ |
| POST /uploads | ✗ | ✗ | ✓ |
| PATCH /uploads/:uploadId | ✗ | ✗ | ✓ |
| HEAD /uploads/:uploadId | ✗ | ✗ | ✓ |
| GET /videos/:id/stream | ✓ | ✓ | ✓ |
| GET /videos/:id/download | ✓ | ✓ | ✓ |

`*` — non-owners (including anonymous) may `GET /videos/:id` only when `status: ready`; `draft`/`processing`/`failed` states return `403 VIDEO_NOT_VISIBLE` to non-owners. This phase has no visibility policy (public/unlisted is `phase-03-videos`'s own TD-06 Recommendation: explicitly deferred to Phase 04) — streaming/download of a `ready` video is intentionally open to any requester, matching the project's "acesso anônimo" principle (`docs/project-plan.md` § Principais Características), while non-ready states stay owner-only because they expose in-progress/failed processing state that has no product meaning for a non-owner yet.

---

### Error Catalog

| errorCode | HTTP | Trigger |
|-----------|------|---------|
| UNAUTHORIZED | 401 | Requisição autenticada sem token válido (padrão herdado — `phase-02-auth/TD-07`) |
| VIDEO_NOT_FOUND | 404 | `GET /videos/:id`, `.../stream` ou `.../download` para um `id` inexistente |
| VIDEO_NOT_VISIBLE | 403 | `GET /videos/:id` de um vídeo não-`ready` por quem não é o dono |
| VIDEO_NOT_READY | 409 | `.../stream` ou `.../download` de um vídeo cujo `status` não é `ready` |
| UPLOAD_METADATA_INVALID | 400 | `Upload-Metadata.videoId` ausente ou sem rascunho correspondente (`onUploadCreate`, per `phase-03-videos/TD-04`) |
| UPLOAD_FORBIDDEN | 403 | O `videoId` do metadata pertence a outro canal (`onUploadCreate`, per `phase-03-videos/TD-03`) |

Error response envelope (`{ statusCode, error, message }`) is inherited unchanged from `phase-02-auth/TD-07` — this phase only adds domain-specific `error` codes, not a new shape.

---

### Events/Messages

#### process-video

**Payload:**

```json
{ "videoId": "uuid" }
```

**Producer:** `VideosService` — enqueued from the `tus` `onUploadFinish` hook (per `phase-03-videos/TD-02`'s Context, SI-03.5)
**Consumer:** `VideoProcessor` (worker process) (per `phase-03-videos/TD-02`, `phase-03-videos/TD-05`, SI-03.6)
**Trigger:** fires the instant a `tus` upload completes; flips `Video.status` from `draft` to `processing`
**Delivery semantics:** at-least-once, deduplicated at the producer via `jobId: videoId` (per `phase-03-videos/TD-02`'s Context); the consumer is idempotent (upsert-style writes) to tolerate BullMQ redelivery after a worker crash

---

#### cleanup-orphan-drafts

**Payload:** _None_ — a repeatable, schedule-triggered job (no per-invocation payload).

**Producer:** scheduled at worker bootstrap via BullMQ's repeatable-job option (per `phase-03-videos/TD-04`'s orphan-draft cleanup Context, SI-03.8)
**Consumer:** `DraftCleanupProcessor` (worker process) (SI-03.8)
**Trigger:** low-frequency interval (e.g., every 6h)
**Delivery semantics:** best-effort — deletes `Video` rows still in `status: draft` past a TTL (48h) with no completed upload behind them (per `phase-03-videos/TD-04`)

---

## Dependency Map

SI-03.1 (root)
└── SI-03.3 — depends on SI-03.1 (MinIO/Redis/config precisam existir)
    ├── SI-03.5 — depends on SI-03.3 + SI-03.4 (storage/fila + rascunho)
    │   └── SI-03.9 — depends on SI-03.5 + SI-03.6 + SI-03.7 (fluxo completo)
    ├── SI-03.6 — depends on SI-03.2 + SI-03.3 (entidade + storage/fila)
    │   └── SI-03.9 (ver acima)
    ├── SI-03.7 — depends on SI-03.3 + SI-03.4 (storage + entidade/status)
    │   └── SI-03.9 (ver acima)
    └── SI-03.8 — depends on SI-03.3 + SI-03.4 (fila + entidade/status)
SI-03.2 (root)
└── SI-03.4 — depends on SI-03.2 (entidade precisa existir)
    └── (ver SI-03.5, SI-03.6, SI-03.7, SI-03.8 acima)

---

## Deliverables

- [ ] SI-03.1 — Infra: Dependências, Docker Compose e Namespaces de Configuração
- [ ] SI-03.2 — Entidade Video e Migration
- [ ] SI-03.3 — Módulos de Storage e Fila (Cliente S3, URLs Pré-assinadas, Producer BullMQ)
- [ ] SI-03.4 — Endpoints de Pré-cadastro do Vídeo (POST /videos, GET /videos/:id)
- [ ] SI-03.5 — Endpoint de Upload Resumível (tus)
- [ ] SI-03.6 — Worker de Processamento de Vídeo (FFmpeg + Dead-letter)
- [ ] SI-03.7 — Endpoints de Streaming e Download
- [ ] SI-03.8 — Job Agendado de Limpeza de Rascunhos Órfãos
- [ ] SI-03.9 — Suíte E2E do Fluxo Completo de Upload, Processamento e Entrega

**Full test suites:**

- [ ] Testes unitários passam (`docker compose exec nestjs-api npm test -- --runInBand`)
- [ ] Testes E2E passam (`docker compose exec nestjs-api npm run test:e2e`)
- [ ] Type-check sem erros (`docker compose exec nestjs-api npx tsc --noEmit`)
- [ ] Lint sem erros (`docker compose exec nestjs-api npm run lint`)
- [ ] `docker compose ps` mostra `minio`, `redis` e `video-worker` com status `running` junto com `nestjs-api` e `db`
