# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 3/9 completed

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
- **Status:** pending
- **Tests:** no tests
- **Observations:** none

### SI-03.5 — Endpoint de Upload Resumível (tus)
- **Status:** pending
- **Tests:** no tests
- **Observations:** none

### SI-03.6 — Worker de Processamento de Vídeo (FFmpeg + Dead-letter)
- **Status:** pending
- **Tests:** no tests
- **Observations:** none

### SI-03.7 — Endpoints de Streaming e Download
- **Status:** pending
- **Tests:** no tests
- **Observations:** none

### SI-03.8 — Job Agendado de Limpeza de Rascunhos Órfãos
- **Status:** pending
- **Tests:** no tests
- **Observations:** none

### SI-03.9 — Suíte E2E do Fluxo Completo de Upload, Processamento e Entrega
- **Status:** pending
- **Tests:** no tests
- **Observations:** none
