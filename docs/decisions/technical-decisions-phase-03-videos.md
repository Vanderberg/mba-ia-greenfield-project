---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-07-25
scope_description: "Backend foundation for video upload and processing: object storage backend (dual-endpoint + CORS), background job queue/worker topology (enqueue trigger, idempotency, dead-letter), resumable large-file (10GB) upload protocol (with upload auth and incomplete-upload cleanup), video draft pre-registration + status lifecycle + unique identifier strategy (with orphan cleanup), FFmpeg-based metadata/thumbnail extraction (worker byte-access strategy), and video streaming/download delivery."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — owns all six decisions below: object storage client, queue/worker topology, upload protocol, draft pre-registration + identifier strategy, FFmpeg processing pipeline, and streaming/download delivery.
- `next-frontend/` — no open decision in this document. Phase 03's capability list (`docs/project-plan.md` § Fase 03) does not name any screen or UI surface (unlike Phase 02, which explicitly listed "Telas de cadastro, login..."). The upload widget and player UI are FE-runtime concerns that will be researched when a phase names them explicitly (Phase 04's management panel, Phase 05's viewing page) — the wire contracts decided here (upload protocol, streaming delivery) constrain that future FE work but do not require FE decisions now.

---

## TD-01: Object Storage Backend & Client SDK

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** Videos and thumbnails need a persistent, streamable storage layer distinct from PostgreSQL. The C4 diagram (`docs/diagrams/software-arch.mermaid`) already names this container "Object Storage (S3/MinIO)" — this TD picks the concrete backend and how the NestJS API talks to it. No storage SDK is installed yet (`nestjs-project/package.json`).

**Dual-endpoint premise (applies to every option below):** the API's S3 client resolves storage over the Docker network using the Compose service name (`minio`), per `CLAUDE.md` § Docker Networking. But TD-06 hands the *browser* a presigned URL for the same object — and the browser is not on the Docker network, so that URL must use a host the browser can actually reach (`localhost:<port>` in dev via the Compose port mapping, a public domain/CDN in prod). This means the storage client config needs **two endpoints**: an internal one (`S3_INTERNAL_ENDPOINT=http://minio:9000`, used for every server-side SDK call) and a public one (`S3_PUBLIC_ENDPOINT`, used only when generating presigned URLs for TD-06). Whichever option below is chosen, this dual-endpoint split is mandatory — a single-endpoint config would either break server-side calls (browser host unreachable from the API container) or break every presigned URL handed to a browser (internal host unreachable from the browser).

**Options:**

### Option A: MinIO (self-hosted, S3-compatible) + `@aws-sdk/client-s3`
- MinIO runs as a Compose service alongside `db` and `mailpit`; the API talks to it through the standard AWS S3 API surface using the official `@aws-sdk/client-s3` v3 client pointed at MinIO's endpoint (`endpoint` + `forcePathStyle: true`).
- **Pros:** Fully local dev loop (no cloud account needed), matches the project's "everything runs in Docker" convention (`CLAUDE.md` § Docker Networking), zero code change needed to later point the same client at real AWS S3 (same API surface), free at any volume for dev/CI.
- **Cons:** One more container to operate in prod (or a migration step to real S3 at deploy time); MinIO cluster/erasure-coding tuning for real durability is out of scope for this phase.

### Option B: Cloud AWS S3 directly (dev + prod, no local emulation)
- The API talks to a real S3 bucket from day one, including in local development, using `@aws-sdk/client-s3`.
- **Pros:** No emulation drift between dev and prod; real S3 semantics (multipart limits, eventual consistency corner cases) are exercised from the start.
- **Cons:** Requires AWS credentials and a real bucket for every developer/CI run — breaks the project's fully-Dockerized local environment; costs money for a project with no deploy target yet; violates the "always Compose service name" networking convention with an external dependency.

### Option C: Local filesystem volume (bind-mounted directory)
- Files are written to a Docker volume and served through the API's own filesystem; no S3 API involved.
- **Pros:** Simplest possible setup, no new library.
- **Cons:** No multipart/presigned-URL primitives to reuse for TD-03 and TD-06 (would require hand-rolling range-request serving and resumable-upload bookkeeping); does not match the already-drawn architecture diagram; painful to scale or move to real cloud storage later since none of the S3 API shape is reused.

**Recommendation:** **Option A (MinIO + `@aws-sdk/client-s3`)** — it is the literal architecture already agreed in `software-arch.mermaid`, keeps local dev fully Docker-contained per the project's networking convention, and its S3-compatible API is reused directly by TD-03 (upload) and TD-06 (streaming/download) instead of inventing bespoke range-serving and resumability logic. Buckets default to **private** (no anonymous read policy) — every read/write goes through the API's credentialed client or a time-boxed presigned URL (TD-06); public/unlisted visibility policy is Phase 04 scope and layers on top without changing this default. **CORS must be enabled on the bucket** (`AllowedOrigins`: the FE's origin, `AllowedMethods`: `GET`, `AllowedHeaders`: `Range`) — without it, the browser's direct range requests to the public endpoint in TD-06 Option B are blocked by the browser itself, regardless of the presigned URL being valid.

**Decision:** A (MinIO + `@aws-sdk/client-s3`)
**Libraries:** @aws-sdk/client-s3

---

## TD-02: Background Job Queue & Worker Topology

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** Video processing (duration/metadata extraction, thumbnail generation — TD-05) is CPU-heavy and must not block the request/response cycle or the event loop of the API process. The architecture diagram already names a separate "Video Worker (FFmpeg)" container that "consumes jobs from queue"; the message queue itself is marked `TBD`. This TD picks the queue technology and how the worker attaches to it. No queue library is installed yet.

**Enqueue trigger (applies regardless of which option is chosen):** the job has to be enqueued the moment the upload is actually complete — not before. Since TD-03 (Option A, `tus`) already terminates a finished upload through the protocol's own `onUploadFinish` hook on the API side, that hook is the enqueue point: it emits the `process-video` job with `{ videoId }` as payload. This is preferred over an S3/MinIO `ObjectCreated` bucket-notification trigger because the `tus` hook fires inside the API process that already knows the `videoId` (TD-04) — a bucket notification would only carry the storage key and require a reverse lookup, adding a dependency on MinIO's notification/webhook feature for no benefit.

**Idempotency:** the job is enqueued with `jobId: videoId` (BullMQ deduplicates jobs sharing an `jobId` already in the queue/active state), so a duplicate `onUploadFinish` call (e.g., a retried `tus` request) cannot double-enqueue the same video. Inside the processor, every write is an upsert keyed by `videoId` (write duration/metadata/thumbnail unconditionally as the final state, never as an increment or append) — so a BullMQ-driven retry of the same job after a worker crash reprocesses safely instead of corrupting or duplicating state.

**Dead-letter / permanent failure:** BullMQ's `attempts` + exponential `backoff` govern transient retries (e.g., worker OOM, storage hiccup). When attempts are exhausted, the `failed` event handler sets the `Video` row's status to `failed` (see TD-04's state machine) instead of leaving it stuck in `processing` — this is the terminal state a channel owner would see in a future management panel (Phase 04) for an unprocessable upload (corrupt file, unsupported codec).

**Options:**

### Option A: BullMQ + Redis, worker as a separate process/container
- `bullmq` (Redis-backed) with `@nestjs/bullmq` in the API for producing jobs; the worker runs as its own Node entrypoint (own `main-worker.ts`, own Docker service) using BullMQ's `Worker` class, consuming the same Redis instance.
- **Pros:** Purpose-built for this exact shape (producer/consumer split across processes), first-class retry/backoff, stalled-job recovery if the worker crashes mid-transcode, concurrency control, and an optional dashboard (Bull Board) for operational visibility — all relevant for long-running FFmpeg jobs.
- **Cons:** Introduces Redis as a brand-new infra dependency (no cache/session store in the stack today) — one more Compose service to run and operate.

### Option B: pg-boss (PostgreSQL-backed queue), worker as a separate process/container
- `pg-boss` uses the already-running PostgreSQL instance as both broker and job store (`SKIP LOCKED`-based polling); the worker is a separate Node entrypoint subscribing to job types.
- **Pros:** No new infra service — reuses the `db` container already in Compose; jobs and video rows can share a transaction boundary if ever needed; one fewer moving part to operate.
- **Cons:** Polling-based (not push-based) — added latency per job pickup compared to Redis pub/sub; less mature retry/observability tooling than BullMQ's ecosystem; adds sustained write load (polling + job table churn) to the same Postgres instance serving user-facing queries.

**Recommendation:** **Option A (BullMQ + Redis)** — video transcoding jobs are long-running and CPU-bound; BullMQ's stalled-job detection and backoff/retry semantics are specifically built for exactly this "worker crashes mid-job" failure mode, which matters more here than avoiding one extra Compose service. The Redis dependency is a one-time addition to `nestjs-project/compose.yaml`, not a recurring cost.

**Decision:** A (BullMQ + Redis, separate worker process)
**Libraries:** bullmq, @nestjs/bullmq, ioredis

---

## TD-03: Large File Upload Protocol (up to 10GB)

**Scope:** Backend

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** A 10GB upload over a real-world connection will hit network interruptions; re-uploading from byte zero on every drop is unacceptable, and buffering the whole file in the API process's memory or local disk before forwarding it to storage would tie up server resources per the "sem impacto na performance" requirement. This decision picks the wire protocol between client and API/storage.

**Authentication (applies regardless of which option is chosen):** only an authenticated channel owner may start or resume an upload — the raw `tus`/S3-multipart protocols carry no auth of their own. The access token issued in Phase 02 (`Authorization: Bearer <accessToken>`) is sent on every `tus` request (`POST`, `HEAD`, `PATCH`) exactly like any other authenticated API call; the `tus` server's request handler runs behind the same auth guard used elsewhere in the API before `tusServer.handle(req, res)` is invoked, and additionally checks that the authenticated user owns the `videoId` embedded in the upload's metadata (TD-04) before allowing a `PATCH` to continue it — otherwise one user could resume or overwrite another user's in-progress upload by guessing/reusing a `tus` resource URL.

**Incomplete-upload cleanup (applies regardless of which option is chosen):** an upload a user abandons mid-transfer (closes the tab at 3GB of 10GB) must not become permanent storage cost. For Option A, `@tus/s3-store` maps directly onto S3 multipart uploads, so an **S3 lifecycle rule** expiring incomplete multipart uploads after N days (e.g., 2 days) is configured on the bucket (TD-01) — this is a storage-side policy, not application code, and requires no additional job/cron.

**Options:**

### Option A: `tus` resumable protocol via `@tus/server` + `@tus/s3-store`
- The API mounts a `tus` endpoint; `@tus/s3-store` streams chunks directly into an S3/MinIO multipart upload (TD-01) as they arrive, and persists upload offset/state so an interrupted client can resume from the last received byte using the standard `tus` `HEAD`/`PATCH` handshake.
- **Pros:** Resumability is protocol-native (the exact "sem travar o sistema" / recoverable-on-drop concern called out in `docs/project-plan.md` § Pontos de Atenção), chunks stream straight into S3 multipart parts (no full-file buffering), well-established open protocol with existing client libraries (`tus-js-client`) for whatever upload widget the FE builds later.
- **Cons:** Adds a new protocol/library surface the team has to learn; the FE will need a `tus`-aware client instead of a plain `fetch`/`FormData` call (deferred to the FE phase per this doc's scope note, but still a future integration cost).

### Option B: Client-driven S3 multipart upload (presigned part URLs)
- The API creates a multipart upload and hands out presigned `UploadPart` URLs per chunk (TD-01's S3 client); the browser uploads each part directly to MinIO/S3, then calls the API to complete the multipart upload.
- **Pros:** Bytes never transit the Nest API process at all (best possible API performance impact); reuses the same `@aws-sdk/client-s3` already chosen in TD-01, no extra protocol library.
- **Cons:** Resumability across a full page reload or network drop mid-part must be hand-built (tracking which parts succeeded, re-requesting presigned URLs, retry orchestration) — `tus` gives this for free; more custom FE logic to drive the multipart handshake correctly.

### Option C: Streaming multipart form upload through the Nest API (`FileInterceptor` + disk buffering)
- The browser sends one large `multipart/form-data` request; Nest's `FileInterceptor` streams it to a temp file, which the API then pushes to storage.
- **Pros:** Simplest implementation, standard Nest/Multer pattern, no new protocol.
- **Cons:** No resumability at all — any interruption on a multi-GB upload means starting over; the file transits and is temporarily buffered on the API's own disk, directly contradicting "sem impacto na performance" at 10GB scale; the whole point flagged in the project's own attention list is unresolved by this option.

**Recommendation:** **Option A (`tus` via `@tus/s3-store`)** — it is the only option that satisfies both halves of the capability text ("até 10GB" and "sem impacto na performance") without hand-rolling resumability, and it plugs directly into the S3-compatible storage already chosen in TD-01.

**Decision:** A (`tus` via `@tus/server` + `@tus/s3-store`)
**Libraries:** @tus/server, @tus/s3-store

---

## TD-04: Video Draft Pre-registration, Status Lifecycle & Identifier Strategy

**Scope:** Backend

**Capability:** Transversal — covers: "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload", "URL única por vídeo, sem conflito com outros vídeos"

**Context:** The capability explicitly requires a draft `Video` row to exist automatically the moment an upload *starts* (not after it finishes), so the channel owner can see/manage it as a draft even while an in-progress 10GB upload is still streaming. This decision depends on TD-03: whichever upload handshake is chosen, the API needs to mint the video's identity (DB row + storage object key) before any bytes are accepted, so that identity can be threaded through the upload session (`tus` `Upload-Metadata`, in TD-03's Option A).

**Status lifecycle (applies regardless of which option below is chosen):** pre-registering the row is only half the capability — the row also has to reflect where the video actually is in the pipeline, since TD-02's worker and TD-05's processing both transition it asynchronously. The `Video.status` column is a state machine with four states: `draft` (row created, upload not yet finished) → `processing` (upload complete, `process-video` job running — TD-02) → `ready` (duration/metadata/thumbnail persisted — TD-05) or `failed` (TD-02's dead-letter path, permanent processing failure). The `tus` `onUploadFinish` hook (TD-02) is what flips `draft → processing` and enqueues the job; the worker flips `processing → ready` or `processing → failed` on completion/exhaustion. Phase 04's management panel reads this column directly — no new mechanism is needed there.

**Orphan-draft cleanup (applies regardless of which option below is chosen):** a draft row created before the upload starts (Option A) can be abandoned before a single byte arrives (user never opens the `tus` session at all) or abandoned mid-upload (covered by TD-03's S3 lifecycle rule on the object, but the DB row itself still exists with no object behind it). A scheduled cleanup (a low-frequency BullMQ repeatable job — reusing TD-02's queue, no new infra) deletes `Video` rows still in `status: draft` past a TTL (e.g., 48h) with no corresponding completed upload, keeping the `videos` table free of permanent orphans left by browsers that never started or never finished an upload.

**Options:**

### Option A: Pre-create the draft row synchronously, then open the upload session against it
- Client calls `POST /videos` first (creates a `Video` row with `status: draft`, generates its UUID `id` via the project's existing `@PrimaryGeneratedColumn('uuid')` convention — already used by `User`, `Channel`, and the auth token entities), receives the id back, then opens the `tus` upload session with that id embedded in `Upload-Metadata`. The storage object key is derived deterministically from the id (e.g. `videos/{id}/original`).
- **Pros:** Matches the capability literally ("ao iniciar o upload" — the row exists before the first byte lands); reuses the project's established UUID-PK convention with zero new uniqueness logic, so the same id doubles as the collision-free public identifier the "URL única" capability asks for; storage key derivation is trivial and collision-free by construction (UUID-namespaced).
- **Cons:** Requires two round-trips from the client (create draft, then start upload) instead of one — acceptable given the FE integration for this handshake is out of this document's scope.

### Option B: Create the draft implicitly from the upload session's first request (webhook/hook-driven)
- The client opens the `tus` (or S3 multipart) session directly; the API's `tus` `onUploadCreate` hook (or an S3 event notification) creates the `Video` row after the fact, deriving the id from the storage-assigned upload/object key.
- **Pros:** One round-trip for the client.
- **Cons:** The storage layer's upload/object key format becomes the source of the video's public identity (inverted dependency — storage should not drive the domain model); harder to guarantee the row exists synchronously for a caller who wants to immediately navigate to the draft's management screen; more indirection to trace "why does this draft exist" during debugging.

**Recommendation:** **Option A** — pre-creating the row is what the capability text literally asks for, costs one extra round-trip that is invisible to the end user (the FE issues both calls before showing the upload progress bar), and lets the already-established UUID PK convention double as the unique-URL identifier with no new mechanism.

**Decision:** A (pre-create draft row synchronously, then open the upload session against it)

---

## TD-05: Video Processing — Worker Byte-Access Strategy & Tooling

**Scope:** Backend

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** Once TD-02's worker picks up a completed-upload job, it must invoke FFmpeg to read the video's duration/metadata (`ffprobe`) and extract a frame as a thumbnail (`ffmpeg`). Both operations need **random access** into the file, not just a forward read: `ffprobe` typically needs the container's metadata box (for MP4, the `moov` atom, which many encoders write at the **end** of the file, not the start) and thumbnail extraction needs to seek to an arbitrary timestamp. This is the real strategic question for a 10GB file — how the worker gets bytes it can seek within — not which CLI wrapper library is used to invoke FFmpeg (a much smaller, implementation-level choice, addressed in the recommendation below).

**Options:**

### Option A: Download the full object to worker-local ephemeral disk, then process the local file
- On job start, the worker streams the object from MinIO/S3 (TD-01) to a temp path (`/tmp/processing/{videoId}`); `ffprobe`/`ffmpeg` then run against that local file with full random-seek support; the temp file is deleted in a `finally` block regardless of success or failure.
- **Pros:** `ffprobe`/`ffmpeg` behave exactly as documented/tested against local files — no container-format edge cases to reason about; a crashed job leaves at most one stray temp file (cleaned by the same `finally`-based deletion on the next successful run, or a periodic sweep); simplest and most robust option to implement and debug.
- **Cons:** Worker needs ephemeral disk sized for `(max concurrent jobs × max upload size)` — at 10GB max, even 2 concurrent jobs means ≥20GB of scratch space per worker instance; requires explicit, guaranteed cleanup (a leaked temp file on an uncaught exception path would silently eat disk over time).

### Option B: Stream the object directly into FFmpeg via stdin/named pipe (no local copy)
- The worker pipes an S3 `GetObject` read stream straight into `ffmpeg`'s stdin, avoiding any full download.
- **Pros:** No disk usage proportional to file size; can start processing before the full object has finished downloading for simple linear operations.
- **Cons:** Breaks for exactly the two operations this phase needs: a single forward stream cannot satisfy `ffprobe`'s need to read a trailing `moov` atom or `ffmpeg`'s need to seek to an arbitrary thumbnail timestamp, without either buffering the whole stream anyway (defeating the purpose) or requiring "faststart"-remuxed source files (a constraint this phase cannot impose on arbitrary user uploads).

### Option C: Container-aware ranged partial downloads (fetch only the byte ranges FFmpeg needs)
- The worker parses just enough of the container format itself to know which byte ranges to request (e.g., locate the `moov` atom via a small ranged GET at the head and tail of an MP4, then a targeted GET near the desired thumbnail timestamp).
- **Pros:** Minimal bytes transferred, no full download and no full local copy.
- **Cons:** Effectively re-implements container-format parsing that `ffprobe` already does internally — heavy, fragile, format-specific engineering (MP4 vs WebM vs MKV all differ) to build and maintain for a two-operation need; disproportionate for what this phase's capability list actually asks for.

**Recommendation:** **Option A (download to worker-local ephemeral disk)** — `ffprobe`/`ffmpeg` need genuine random access for the two operations this phase requires, and that need is exactly what defeats Option B and makes Option C disproportionately expensive to build. The disk-cost con is bounded and manageable: cap worker concurrency to fit `(concurrency × 10GB)` within the worker container's allocated volume, and guarantee cleanup with a `finally`-based delete plus a periodic sweep of the temp directory as a backstop against any leaked file from a hard crash.

**Implementation note (not a separate strategic axis):** within Option A, the worker still needs some way to invoke the two FFmpeg operations against the local temp file. `fluent-ffmpeg` (paired with `@ffmpeg-installer/ffmpeg` / `@ffprobe-installer/ffprobe` for version-pinned static binaries, avoiding a distro `apt-get install ffmpeg` step with a version that drifts across base image tags) is a thin, well-established convenience wrapper over both commands — this is a library-ergonomics choice, not a decision with competing architectural trade-offs, so it is recorded here as the adopted convention rather than as its own Options table.

**Decision:** A (download the full object to worker-local ephemeral disk, then process the local file)
**Libraries:** fluent-ffmpeg, @ffmpeg-installer/ffmpeg, @ffprobe-installer/ffprobe

---

## TD-06: Video Streaming & Download Delivery Strategy

**Scope:** Backend

**Capability:** Transversal — covers: "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** Once a video is processed and stored (TD-01), the browser's `<video>` element needs to start playback without downloading the whole file (HTTP range requests), and the user needs a separate "download" action for the full file. This decision picks how bytes get from MinIO/S3 to the browser for both cases.

**Options:**

### Option A: API proxies range requests to storage (Nest controller streams `GetObjectCommand` with `Range` forwarded)
- The player/download link hits a Nest endpoint (`GET /videos/:id/stream`), which forwards the incoming `Range` header into an S3 `GetObjectCommand` and pipes the response stream back to the client with the matching `206 Partial Content` semantics.
- **Pros:** The API stays the single point of authorization/access-control for every byte served (relevant once unlisted/private visibility lands in Phase 04); no direct client-to-storage coupling to manage.
- **Cons:** Every byte of every video view/download transits the Nest API process — directly working against "sem impacto na performance" at scale, and duplicates range-parsing logic that S3/MinIO already implements correctly.

### Option B: Presigned URL redirect (API issues a short-lived presigned `GetObject` URL, browser talks to storage directly)
- The endpoint returns (or redirects to) a presigned URL; the `<video>` element's native range-request behavior and the browser's download flow talk directly to MinIO/S3, which already serves `Range` and `Accept-Ranges` correctly out of the box. Download reuses the same presigned URL with `ResponseContentDisposition: attachment` set on the command.
- **Pros:** Zero video bytes transit the API process (best performance profile for the stated 10GB/streaming concern); no custom range-parsing code to write or maintain; download vs. stream is just one differing parameter (`ResponseContentDisposition`) on the same presigned-URL mechanism already available from TD-01's S3 client.
- **Cons:** Access control has to happen at URL-issuance time (short expiry + a check before minting the URL) rather than per-byte — acceptable for this phase since Phase 03 has no private-video concept yet (unlisted/public visibility is explicitly Phase 04 scope). This option only works with the **public** MinIO endpoint and bucket **CORS** policy already required by TD-01 (`S3_PUBLIC_ENDPOINT` + `AllowedOrigins`/`AllowedMethods: GET`/`AllowedHeaders: Range`) — the presigned URL must be signed against the endpoint the browser can reach, and the browser's own range request to that endpoint is otherwise blocked by CORS regardless of the URL's validity.

### Option C: HLS/DASH adaptive-bitrate transcoding (worker generates multiple renditions + manifest)
- TD-05's worker also transcodes each upload into several bitrate/resolution renditions and an HLS manifest; the player requests segments instead of the original file.
- **Pros:** Adaptive quality switching, industry-standard for large-scale video platforms.
- **Cons:** Massive scope increase for this phase — multiple encodes per upload, manifest generation/serving, segment storage layout — none of which is asked for in the phase's capability list (single stream + single download, no mention of quality tiers or adaptive bitrate).

**Recommendation:** **Option B (presigned URL redirect)** — MinIO/S3 already implements correct `Range`/`Accept-Ranges` handling, so proxying through the API (Option A) would only add latency and load without adding capability; Option C solves a problem this phase does not ask for. Presigned URLs reuse the exact S3 client chosen in TD-01 with no new library.

**Decision:** B (presigned URL redirect)
**Libraries:** @aws-sdk/s3-request-presigner

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Object Storage Backend & Client SDK | MinIO + `@aws-sdk/client-s3` | A |
| TD-02 | Backend | Background Job Queue & Worker Topology | BullMQ + Redis, separate worker process | A |
| TD-03 | Backend | Large File Upload Protocol (10GB) | `tus` via `@tus/server` + `@tus/s3-store` | A |
| TD-04 | Backend | Video Draft Pre-registration, Status Lifecycle & Identifier Strategy | Pre-create draft row (UUID) before upload starts; `draft→processing→ready/failed` state machine | A |
| TD-05 | Backend | Video Processing — Worker Byte-Access Strategy & Tooling | Download to worker-local ephemeral disk + `fluent-ffmpeg` | A |
| TD-06 | Backend | Video Streaming & Download Delivery Strategy | Presigned URL redirect (direct client↔storage) | B |
