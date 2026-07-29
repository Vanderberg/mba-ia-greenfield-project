# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 7/9 completed

### SI-03.1 — Infra: Dependências, Docker Compose e Namespaces de Configuração
- **Status:** completed
- **Tests:** no tests (Infra) — verificado indiretamente via `app.e2e-spec.ts` (app sobe com os novos namespaces `storage`/`queue` sem erro de DI/Joi)
- **Observations:**
  - `@tus/server` e `@tus/s3-store` resolveram para `^2.x` em vez do `^1.x` estimado no research/library-refs — atualizado `library-refs.md` para refletir a versão real instalada.
  - Adicionado `@types/fluent-ffmpeg` como devDependency (não estava listado no plano, mas é necessário para compilar com `strict` — `fluent-ffmpeg` não inclui tipos próprios).
  - `video-worker` reutiliza o mesmo `Dockerfile.dev` do `nestjs-api` (padrão já usado no projeto: container fica em `tail -f /dev/null`, comandos rodados via `docker compose exec`); scripts `start:worker:dev`/`start:worker:prod` adicionados ao `package.json`, mas o módulo do worker em si só será criado no SI-03.6.
  - Healthcheck do MinIO via `mc ready local` funcionou de primeira (a imagem oficial já inclui o binário `mc`).

### SI-03.2 — Entidade Video e Migration
- **Status:** completed
- **Tests:** 4 passing (`video.entity.integration-spec.ts`)
- **Observations:**
  - Convenção real do projeto usa colunas/campos `snake_case` (`channel_id`, `storage_key`, etc.), diferente do `camelCase` usado no plano/Tech Specs — segui a convenção real do código (`channel.entity.ts`), não o plano.
  - Adicionar `@OneToMany(() => Video, ...)` em `Channel` quebrou o boot da aplicação real (`openapi-export.integration-spec.ts` travava em `NestFactory.create(AppModule)`): `autoLoadEntities: true` só descobre uma entidade se algum módulo a registra via `TypeOrmModule.forFeature`, e `Video` ainda não tinha módulo. Criei um `VideosModule` mínimo (só `forFeature([Video])`) e registrei em `AppModule` — necessário para a entidade não deixar a fase num estado quebrado até o SI-03.3/03.4 expandirem o módulo. Isso não estava no plano original desta SI, mas é consequência direta e obrigatória de criar a entidade com relação bidirecional.
  - A relação bidirecional Channel↔Video exigiu adicionar `Video` ao array `ALL_ENTITIES` de 9 arquivos de teste existentes (`channels.module.spec.ts`, `auth.module.spec.ts`, `verification-token.entity.integration-spec.ts`, `channel.entity.integration-spec.ts`, `auth.service.integration-spec.ts`, `users.service.integration-spec.ts`, `users.module.spec.ts`, `channels.service.integration-spec.ts`, `refresh-token.entity.integration-spec.ts`, `user.entity.integration-spec.ts`) — sem isso, o TypeORM falha ao resolver a metadata da relação inversa nesses test data sources.
  - `migrations.integration-spec.ts` (teste que dropa/recria as tabelas via `DROP TABLE ... CASCADE`) foi estendido para gerenciar também `videos` e a migration `CreateVideos` — sem isso, o `DROP TABLE "channels" CASCADE` removeria silenciosamente a FK real de `videos` no banco compartilhado, quebrando testes subsequentes. O segundo teste do arquivo foi ajustado (agora reverte `CreateVideos`, a migration realmente mais recente, em vez de `CreateAuthTokens`).
  - `cleanAllTables()` (helper compartilhado de testes) passou a limpar `videos` antes de `channels` (ordem de FK).
  - `env.validation.integration-spec.ts` precisou do fixture `requiredEnv` atualizado com `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` (agora obrigatórios no schema Joi).

### SI-03.3 — Módulos de Storage e Fila (Cliente S3, URLs Pré-assinadas, Producer BullMQ)
- **Status:** completed
- **Tests:** 7 passing (`storage.service.integration-spec.ts`: 4, `storage.module.spec.ts`: 1, `queue.module.spec.ts`: 1) + suíte completa 155/155
- **Observations:**
  - MinIO não implementa a API S3 `PutBucketCors` (bucket-level CORS) — retorna `NotImplemented`. CORS foi movido para o nível de servidor via env var `MINIO_API_CORS_ALLOW_ORIGIN` no `compose.yaml`, em vez de uma chamada `PutBucketCorsCommand` no bootstrap.
  - MinIO (RELEASE.2025-09-07) descarta silenciosamente o elemento `AbortIncompleteMultipartUpload` de qualquer `PutBucketLifecycleConfiguration` — confirmado tanto via AWS SDK quanto via `mc ilm import` nativo do MinIO, e relendo a regra salva (a ação simplesmente não persiste, sem erro). É uma limitação real desta versão do MinIO, não um bug do cliente. A regra de limpeza de uploads incompletos (TD-03) **não foi configurada** — documentado no código como gap conhecido, a revisitar se o MinIO for atualizado.
  - AWS SDK v3 mais recente (`requestChecksumCalculation` default) adiciona headers de checksum que o MinIO rejeita com `NotImplemented` em operações de bucket — corrigido com `requestChecksumCalculation: 'WHEN_REQUIRED'` no client.
  - Para o teste de integração do `StorageService` rodar de dentro do container `nestjs-api` (que não alcança `localhost:9000`, o endpoint "público" real pensado para navegadores), o teste usa o hostname `minio` como stand-in de "endpoint público" — a mecânica de assinatura/entrega testada é idêntica, só muda qual host é alcançável a partir de quem faz a chamada.
  - `migrations.integration-spec.ts` tinha um `Promise.all` de `DROP TABLE ... CASCADE` concorrente que passou a deadlockar depois que `videos` (com FK para `channels`) entrou no conjunto gerenciado — trocado para drops sequenciais.
  - `openapi-export.integration-spec.ts` precisou de timeout maior (30s → 90s): o boot completo da `AppModule` agora inclui a conexão do BullMQ com o Redis, que soma tempo real ao bootstrap.
  - `objectExists()` foi ajustado para só tratar `404` como "não existe"; qualquer outro erro é relançado (não engolir erros, per `nestjs-services.md`).

### SI-03.4 — Endpoints de Pré-cadastro do Vídeo (POST /videos, GET /videos/:id)
- **Status:** completed
- **Tests:** 13 unit/module (`videos.service.spec.ts`: 7, `optional-jwt-auth.guard.spec.ts`: 4, `videos.module.spec.ts`: 1) + 6 E2E (`videos-draft.e2e-spec.ts`) — suíte completa: 167 unit/integration + 58 E2E
- **Observations:**
  - Criado `OptionalJwtAuthGuard` (novo — não estava no plano original) para viabilizar a regra de visibilidade de `GET /videos/:id` (owner vê qualquer status, não-owner só vê `ready`): combina `@Public()` (bypassa o guard JWT global obrigatório) com esse guard leve, que popula `request.user` quando um token válido existe mas nunca rejeita a requisição — segue a convenção do projeto ("global guard fica global") sem duplicar a lógica do `JwtAuthGuard`.
  - Adicionado `ChannelsService.findByUserId` (método novo, não existia) — necessário para resolver o canal do usuário autenticado antes de criar o rascunho.
  - `VideosService.createDraftForUser` trata "usuário sem canal" como erro genérico (não é um `DomainException` catalogado) — invariante que nunca deveria ocorrer na prática, já que todo usuário registrado ganha um canal automaticamente na Fase 02.
  - Adicionadas ao catálogo de exceções (`domain.exception.ts`) as exceptions de todo o Error Catalog da fase (`VideoNotFound`, `VideoNotVisible`, `VideoNotReady`, `UploadMetadataInvalid`, `UploadForbidden`) de uma vez, já que vivem no mesmo arquivo por convenção do projeto — só as duas primeiras são usadas nesta SI; as demais serão consumidas nos SIs 03.5/03.7.
  - `thumbnailUrl` em `GET /videos/:id` só é calculado (chamada a `StorageService.getPresignedUrl`) quando `status: ready` e `thumbnail_key` existe — nesta SI sempre retorna `null`, pois nenhum vídeo chega a `ready` ainda (isso só acontece a partir do worker, SI-03.6).

### SI-03.5 — Endpoint de Upload Resumível (tus)
- **Status:** completed
- **Tests:** 1 module compile (`uploads.module.spec.ts`) + 7 E2E (`videos-upload.e2e-spec.ts`: 1 fluxo completo com resume após queda simulada; `videos-upload-auth.e2e-spec.ts`: 6 casos 401/400/403) — suíte completa: 168 unit/integration + 65 E2E
- **Observations:**
  - `@tus/server`, `@tus/s3-store`, `@tus/utils` e sua dependência `srvx` são pacotes ESM-only (`.mjs`) que o Jest (CJS) não consegue importar via `ts-jest` — precisou de `transformIgnorePatterns` liberando esses pacotes + um transform dedicado (`babel-jest` com `@babel/preset-env`, novo `babel.esm-interop.config.js`) só para arquivos `.mjs`, aplicado em ambos `test/jest-e2e.json` e no jest config do `package.json`. Não estava previsto no plano original; é puramente infraestrutura de teste, sem impacto no código de produção.
  - O tipo `Request` usado pelos hooks do `@tus/server` não é reexportado por `@tus/server` — é `ServerRequest` do pacote `srvx` (`@tus/server`'s `types.d.ts` importa como `import type { ServerRequest as Request } from 'srvx'`); corrigido o import para vir diretamente de `srvx`.
  - `onUploadCreate` originalmente deixava `DomainException` (lançada por `VideosService.assertOwnedDraft`) vazar sem tradução — o `@tus/server` só sabe formatar erros com a forma `{status_code, body}` (sua própria convenção, não a do Nest), então qualquer outro tipo de erro lançado dali vira `500` genérico. Adicionado um `catch` que traduz `DomainException` para essa forma antes de relançar.
  - Erros de lint (`only-throw-error`) exigiram transformar o helper `jsonError` de um objeto literal `{status_code, body}` em uma classe `TusError extends Error` com essas mesmas propriedades — mantém compatibilidade com a leitura que `@tus/server` faz do erro (`error.status_code`/`error.body`) e ainda assim lança um `Error` de verdade.
  - Bug de parsing de rota corrigido em `TusUploadMiddleware`: o `req.path` visto dentro do middleware é **relativo ao prefixo montado** (`/uploads`) — para `HEAD /uploads/{id}` o `req.path` é `/{id}`, não `/uploads/{id}`. O parsing original assumia path absoluto (`split('/')[1]`) e sempre lia `uploadId` como `undefined`, deixando a checagem de posse do dono nunca disparar para PATCH/HEAD/DELETE; corrigido para `split('/')[0]`. Descoberto via teste E2E que esperava `403` e recebia `404` (rota "não encontrada" por engano, mascarando o bug).
  - Respostas de erro geradas pelo próprio `@tus/server` (rejeições dentro dos hooks, ex. `onUploadCreate`) não passam pelos `ExceptionFilter`s do Nest e não setam `Content-Type: application/json` — o corpo é JSON válido, mas chega como texto puro. Os testes E2E para esses casos fazem `JSON.parse(res.text)` em vez de usar `res.body`. Erros vindos do `TusUploadMiddleware` (checagem de posse pré-tus, incluindo o `HEAD`/`PATCH` de recurso existente) passam normalmente pelo `DomainExceptionFilter` e têm `res.body` populado do jeito usual.
  - Fluxo de "retomada após queda de conexão" testado via `tus-js-client` (nova devDependency): primeira sessão sobe 1 chunk e chama `upload.abort()`; segunda sessão usa `uploadUrl` apontando direto para a URL do recurso (determinística, já que `namingFunction` força o id do recurso `tus` a ser igual ao `videoId`) — o próprio `tus-js-client` faz o `HEAD` para descobrir o offset e retoma o `PATCH` daí. Precisou de `app.listen(0)` (porta real) no `beforeAll`, diferente do padrão usual de `app.getHttpServer()` puro dos outros E2E specs, porque `tus-js-client` é um cliente HTTP real e precisa de uma URL de verdade.

### SI-03.6 — Worker de Processamento de Vídeo (FFmpeg + Dead-letter)
- **Status:** completed
- **Tests:** 2 passing (`video.processor.integration-spec.ts`: fluxo real com FFmpeg+MinIO+BullMQ marcando `status: ready` com duração/thumbnail; dead-letter esgotando `attempts` e marcando `status: failed`) — suíte completa: 170 unit/integration + 65 E2E
- **Observations:**
  - `attempts`/`backoff` do job (per TD-02's dead-letter) são configurados no **producer**, não no worker — adicionado `PROCESS_VIDEO_JOB_OPTIONS` (`attempts: 3`, backoff exponencial 5s) em `queue.constants.ts` e aplicado no `queue.add(...)` de `TusUploadService.onUploadFinish` (SI-03.5), já que é ali que o job é de fato enfileirado.
  - `WorkerModule` é um `NestApplicationContext` totalmente separado do `AppModule` da API (próprio `TypeOrmModule.forRootAsync` + `BullModule.forRootAsync`/`registerQueue` + `StorageModule`), iniciado via `NestFactory.createApplicationContext` em `src/worker/main.ts` — processo `video-worker` independente, per TD-02.
  - `StorageService` ganhou `downloadToFile(key, destinationPath)` (novo método, não existia) — usa `GetObjectCommand` + `stream/promises`' `pipeline` para gravar o objeto em disco local; necessário porque `ffprobe`/`ffmpeg` exigem acesso aleatório (seek) ao arquivo (moov atom no fim do MP4, thumbnail em timestamp arbitrário) — per TD-05's Opção A, um stream direto não serviria.
  - `@OnWorkerEvent('failed')` (decorator do `@nestjs/bullmq`) usado em vez de acessar `worker.on('failed', ...)` manualmente — é o wrapper idiomático do Nest para o mesmo evento do BullMQ; verifica `job.attemptsMade >= job.opts.attempts` para só marcar `status: failed` no esgotamento real (não em toda tentativa falha intermediária).
  - Upsert idempotente: `videoRepository.update({id}, {status:'ready', thumbnail_key, duration_seconds})` sempre escreve o estado final completo (nunca incrementa/agrega) — um retry do mesmo `jobId` após crash do worker reprocessa em segurança, per TD-02.
  - Arquivo temporário local (`os.tmpdir()/video-{videoId}-*`) sempre apagado em bloco `finally`, sucesso ou falha, per TD-05.
  - Bug real de configuração de teste encontrado durante a implementação: o `TestingModule` do teste de integração esqueceu `TypeOrmModule.forFeature([Video])` — a falha de resolução de DI (`Nest can't resolve dependencies of the VideoProcessor`) só apareceu depois de ~45s (overhead do `ts-jest`/compile), e como o `afterAll` também falhava (`queue` nunca chegou a ser atribuída), as conexões Redis/Postgres abertas pelo `BullModule`/`TypeOrmModule` impediam o processo Jest de encerrar — parecia um "hang" indefinido até se rodar com um wrapper `timeout` do shell para forçar a saída e revelar o erro real.
  - Vídeo de teste sintetizado via `ffmpeg -f lavfi -i testsrc=...` diretamente no `beforeAll` do teste de integração (sem commitar um asset binário no repo).

### SI-03.7 — Endpoints de Streaming e Download
- **Status:** completed
- **Tests:** 10 E2E (`videos-delivery.e2e-spec.ts`: redirecionamento 302 com `Range` real resultando em 206, `Content-Disposition: attachment`, 404/409 para inexistente/não pronto) — suíte completa: 170 unit/integration + 75 E2E
- **Observations:**
  - Endpoints totalmente públicos (per Authorization Matrix: anônimo/autenticado/dono têm o mesmo acesso) — sem `OptionalJwtAuthGuard`, sem checagem de posse; apenas `status: 'ready'` é validado, diferente de `GET /videos/:id` que tem regra de visibilidade por dono.
  - Adicionado `VideosService.findReadyById` (novo — não existia): carrega por id, `404 VIDEO_NOT_FOUND` se inexistente, `409 VIDEO_NOT_READY` se `status !== 'ready'`. Não reaproveita `findVisibleById` porque as regras são diferentes (aquele é sobre visibilidade por dono, este é só sobre prontidão).
  - Usado o padrão de redirect dinâmico do Nest (`@Redirect()` decorator + handler retornando `{url, statusCode}`) em vez de injetar `Response` e chamar `res.redirect()` manualmente — mantém o controller livre de acesso direto ao objeto de resposta do Express.
  - Teste E2E precisou sobrescrever o provider `StorageService` (`overrideProvider(StorageService).useValue(...)`) trocando `publicEndpoint` por `internalEndpoint` — a mesma ressalva já documentada em `storage.service.integration-spec.ts`: a URL pré-assinada é gerada contra `S3_PUBLIC_ENDPOINT` (`http://localhost:9000`), alcançável de um browser no host mas não do processo de teste, que roda dentro do container `nestjs-api` (sibling do `minio`, não o host).

### SI-03.8 — Job Agendado de Limpeza de Rascunhos Órfãos
- **Status:** pending
- **Tests:** no tests
- **Observations:** none

### SI-03.9 — Suíte E2E do Fluxo Completo de Upload, Processamento e Entrega
- **Status:** pending
- **Tests:** no tests
- **Observations:** none
