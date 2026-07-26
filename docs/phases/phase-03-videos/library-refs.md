---
libs:
  "@aws-sdk/client-s3":
    version: "^3.x"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-07-26T19:09:55-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3.x"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-07-26T19:09:55-03:00"
  "bullmq":
    version: "^5.x"
    context7_id: "/taskforcesh/bullmq"
    fetched_at: "2026-07-26T19:09:55-03:00"
  "@nestjs/bullmq":
    version: "^11.x"
    context7_id: "/nestjs/docs.nestjs.com"
    fetched_at: "2026-07-26T19:09:55-03:00"
  "ioredis":
    version: "^5.x"
    context7_id: "/redis/ioredis"
    fetched_at: "2026-07-26T19:09:55-03:00"
  "@tus/server":
    version: "^1.x"
    context7_id: "/tus/tus-node-server"
    fetched_at: "2026-07-26T19:09:55-03:00"
  "@tus/s3-store":
    version: "^1.x"
    context7_id: "/tus/tus-node-server"
    fetched_at: "2026-07-26T19:09:55-03:00"
  "fluent-ffmpeg":
    version: "^2.x"
    context7_id: "/fluent-ffmpeg/node-fluent-ffmpeg"
    fetched_at: "2026-07-26T19:09:55-03:00"
  "@ffmpeg-installer/ffmpeg":
    version: "^1.x"
    context7_id: null
    fetched_at: "2026-07-26T19:09:55-03:00"
  "@ffprobe-installer/ffprobe":
    version: "^2.x"
    context7_id: null
    fetched_at: "2026-07-26T19:09:55-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-07-26T19:07:44-03:00"
---

# Library References — phase-03-videos

Distilled Context7 docs for the libraries decided in this phase's TDs, scoped to how each TD's Recommendation actually uses them. Full library docs live upstream (Context7 / official repos) — this file is a project-scoped cheat sheet, not a mirror.

### @aws-sdk/client-s3

_Used by: TD-01 (storage client), TD-03 (multipart target for `@tus/s3-store`), TD-06 (as the client behind presigned URLs)._

- Point the client at MinIO instead of real AWS by setting a custom `endpoint` + `forcePathStyle: true`:
  ```ts
  new S3Client({
    endpoint: process.env.S3_INTERNAL_ENDPOINT, // e.g. http://minio:9000
    forcePathStyle: true,
    region: 'us-east-1', // required by the SDK even for MinIO; value is arbitrary
    credentials: { accessKeyId: ..., secretAccessKey: ... },
  })
  ```
- Full multipart flow (only needed if NOT delegating to `@tus/s3-store`, e.g. for manual bucket/lifecycle setup): `CreateMultipartUploadCommand` → `UploadPartCommand` (per part, collect `ETag`) → `CompleteMultipartUploadCommand` (with the `Parts` list) → `AbortMultipartUploadCommand` on failure.
- `@aws-sdk/lib-storage`'s `Upload` class is a higher-level wrapper around the same 4 commands with a configurable `partSize` (min 5MB) and `queueSize` (concurrency) — useful if any code path uploads to S3 outside the `tus` flow (e.g., a future direct-download re-encode).

### @aws-sdk/s3-request-presigner

_Used by: TD-06 (streaming + download delivery)._

- `getSignedUrl(client, command, { expiresIn })` — `expiresIn` is in seconds, defaults to 900.
- Streaming: sign a `GetObjectCommand` with no extra params; the browser's `<video>` tag issues its own `Range` requests against the signed URL — MinIO/S3 answers those natively with `206 Partial Content`.
- Download: sign a `GetObjectCommand` with `ResponseContentDisposition: 'attachment; filename="..."'` — same mechanism, different one param, exactly as TD-06's Recommendation describes.
- Short expiry (e.g., 5–15 min) is the access-control mechanism for this phase (no per-byte auth) — mint a fresh URL per request, never cache/reuse across users.

### bullmq

_Used by: TD-02 (queue + worker topology)._

- Install: `npm install --save @nestjs/bullmq bullmq`.
- API-side (producer): `BullModule.registerQueue({ name: 'process-video' })` in the module that enqueues jobs after `tus`'s `onUploadFinish` fires.
- Worker-side (separate process/container, per TD-02's decision): `@Processor('process-video') class VideoProcessor extends WorkerHost { async process(job: Job) { ... } }`, registered as a provider in the worker's own `AppModule` — NOT the API's.
- **Idempotency (per TD-02's Context):** enqueue with `jobId: videoId` so BullMQ deduplicates retried enqueue calls; write DB state as an unconditional upsert inside `process()` so a BullMQ-driven retry after a crash is safe.
- **Dead-letter (per TD-02):** configure `attempts` + `backoff` on the job; listen to the worker's `failed` event to flip the `Video.status` to `failed` once attempts are exhausted.
- Sandboxed/separate-process workers (extra isolation beyond just "a different container") are configured by passing a file path instead of a class to `new Worker(queueName, processorFile, { connection })` — evaluate only if per-job process isolation (crash containment) is needed beyond container-level separation.

### @nestjs/bullmq

_Used by: TD-02 — see `### bullmq` above; `@nestjs/bullmq` is the NestJS module wrapper (`BullModule.registerQueue`, `@Processor`, `WorkerHost`) installed alongside `bullmq` itself (`npm install --save @nestjs/bullmq bullmq`)._

### ioredis

_Used by: TD-02 (BullMQ's required Redis connection)._

- BullMQ uses `ioredis` internally for its Redis connection; connection config is passed as BullMQ's `connection` option (`{ host: 'redis', port: 6379 }` — service name `redis`, per the project's Docker networking convention).
- `maxRetriesPerRequest` must be set to `null` when the connection is used by BullMQ (BullMQ's own docs require this — command queueing on connection loss must be unbounded, not ioredis's default of 20 retries) — confirm this exact setting when the compose service + connection options are implemented.

### @tus/server

_Used by: TD-03 (upload protocol), TD-04 (draft pre-registration hooks), TD-01 (CORS/private-bucket premise)._

- `@tus/s3-store` maps `tus` uploads directly onto S3 multipart uploads. Tunable: `partSize` (default too small for 10GB — the phase's own TD-03 math example: 50MB parts → 1000 parts for a 5GB file, well under the 10,000-part S3 limit), `maxConcurrentPartUploads`.
- **Auth (per TD-03's Context):** `onIncomingRequest: async (req, uploadId) => { ... throw {status_code: 401 | 403, body} }` — this is where the access-token guard + per-upload ownership check described in TD-03 goes; `tus` has no auth of its own.
- **Draft pre-registration handshake (per TD-04, Option A):** the client calls `POST /videos` first, gets a `videoId`, then opens the `tus` session with that id in `Upload-Metadata`. `onUploadCreate: async (req, upload) => { ... }` is where the server can validate that `upload.metadata.videoId` matches an existing draft row before accepting the session (can also normalize/reject bad metadata here).
- **Enqueue trigger (per TD-02's Context):** `onUploadFinish: async (req, upload) => { await videoQueue.add('process-video', { videoId }, { jobId: videoId }) }` — this hook is the exact wiring point between TD-03 (upload) and TD-02 (queue).
- **Incomplete-upload cleanup (per TD-03's Context):** configure an S3 lifecycle rule to expire incomplete multipart uploads after N days — bucket-side policy, not `tus` config.

### @tus/s3-store

_Used by: TD-03 — see `### @tus/server` above; `@tus/s3-store` is the storage adapter passed as the `tus` server's `datastore`, mapping chunks directly onto S3/MinIO multipart uploads (`partSize`, `maxConcurrentPartUploads` tunables)._

### fluent-ffmpeg

_Used by: TD-05 (worker byte-access + processing tooling)._

- `@ffmpeg-installer/ffmpeg` / `@ffprobe-installer/ffprobe` are tiny packages that vendor a static per-platform binary and export `{ path }`; wire them in once at worker bootstrap:
  ```ts
  import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
  import ffprobeInstaller from '@ffprobe-installer/ffprobe';
  import ffmpeg from 'fluent-ffmpeg';
  ffmpeg.setFfmpegPath(ffmpegInstaller.path);
  ffmpeg.setFfprobePath(ffprobeInstaller.path);
  ```
  (No dedicated Context7 docs exist for these two installer packages — they are thin binary-distribution wrappers; their entire public API is the exported `path` string used above.)
- Metadata extraction (duration + format), per TD-05's Option A (local temp file, random access needed for the trailing `moov` atom): `ffmpeg.ffprobe(localFilePath, (err, data) => { data.format.duration, data.streams... })`.
- Thumbnail extraction, per TD-05 + the "Geração automática de thumbnail" capability: `ffmpeg(localFilePath).screenshots({ timestamps: ['50%'], filename: 'thumb.png', folder: tmpDir, size: '?x480' })` — `screenshots()` needs a real seekable file, which is exactly why TD-05 rejected the streaming/pipe options.
- Both calls run against the **worker-local temp file** downloaded in TD-05's Option A — delete it in a `finally` block regardless of ffprobe/ffmpeg success or failure (per TD-05's cleanup requirement).

### @ffmpeg-installer/ffmpeg

_Used by: TD-05 — see `### fluent-ffmpeg` above. No dedicated Context7 docs (thin binary-distribution wrapper); its entire public API is the exported `path` string wired via `ffmpeg.setFfmpegPath(ffmpegInstaller.path)`._

### @ffprobe-installer/ffprobe

_Used by: TD-05 — see `### fluent-ffmpeg` above. No dedicated Context7 docs (thin binary-distribution wrapper); its entire public API is the exported `path` string wired via `ffmpeg.setFfprobePath(ffprobeInstaller.path)`._
