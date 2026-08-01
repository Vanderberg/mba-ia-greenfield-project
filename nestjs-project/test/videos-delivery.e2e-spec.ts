import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { AppModule } from '../src/app.module';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import storageConfig from '../src/config/storage.config';
import { bootstrapBucket } from '../src/storage/bootstrap-bucket';
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { Channel } from '../src/channels/entities/channel.entity';
import { User } from '../src/users/entities/user.entity';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';

describe('Videos — streaming and download delivery (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let storageService: StorageService;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    await bootstrapBucket();

    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    })
      // The presigned URL is signed against S3_PUBLIC_ENDPOINT
      // (http://localhost:9000), reachable from a browser on the Docker
      // host but NOT from this test process, which itself runs inside the
      // nestjs-api container — a sibling of `minio`, not the host (same
      // caveat as storage.service.integration-spec.ts). Swap in the
      // container-reachable `minio` hostname for `fetch()` calls below;
      // the signing/serving mechanics under test are unaffected.
      .overrideProvider(StorageService)
      .useValue(
        new StorageService({
          ...storageConfig(),
          publicEndpoint: storageConfig().internalEndpoint,
        }),
      )
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    storageService = moduleFixture.get(StorageService);
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  }, 30000);

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createVideo(
    status: VideoStatus,
    storageKey?: string,
  ): Promise<Video> {
    const user = await userRepository.save(
      userRepository.create({
        email: `delivery_${++counter}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await channelRepository.save(
      channelRepository.create({
        name: `channel${counter}`,
        nickname: `channel${counter}`,
        user_id: user.id,
      }),
    );
    return videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        storage_key: storageKey ?? `videos/delivery-${counter}/original`,
        status,
      }),
    );
  }

  describe('GET /videos/:id/stream', () => {
    it('redirects to a presigned URL that honors Range requests', async () => {
      const storageKey = `videos/delivery-${++counter}/original`;
      await storageService.putObject(storageKey, Buffer.from('0123456789'));
      const video = await createVideo('ready', storageKey);

      const res = await request(app.getHttpServer())
        .get(`/videos/${video.id}/stream`)
        .redirects(0)
        .expect(302);

      const location = res.headers.location;
      expect(location).toBeDefined();

      const rangeResponse = await fetch(location, {
        headers: { Range: 'bytes=2-5' },
      });
      expect(rangeResponse.status).toBe(206);
      expect(await rangeResponse.text()).toBe('2345');
    });

    it('returns 404 VIDEO_NOT_FOUND for an unknown id', async () => {
      const res = await request(app.getHttpServer())
        .get('/videos/00000000-0000-0000-0000-000000000000/stream')
        .expect(404);

      expect(res.body.error).toBe('VIDEO_NOT_FOUND');
    });

    it.each<[VideoStatus]>([['draft'], ['processing'], ['failed']])(
      'returns 409 VIDEO_NOT_READY for a video with status %s',
      async (status) => {
        const video = await createVideo(status);

        const res = await request(app.getHttpServer())
          .get(`/videos/${video.id}/stream`)
          .expect(409);

        expect(res.body.error).toBe('VIDEO_NOT_READY');
      },
    );
  });

  describe('GET /videos/:id/download', () => {
    it('redirects to a presigned URL with Content-Disposition: attachment', async () => {
      const storageKey = `videos/delivery-${++counter}/original`;
      await storageService.putObject(storageKey, Buffer.from('download me'));
      const video = await createVideo('ready', storageKey);

      const res = await request(app.getHttpServer())
        .get(`/videos/${video.id}/download`)
        .redirects(0)
        .expect(302);

      const location = res.headers.location;
      expect(location).toBeDefined();

      const downloadResponse = await fetch(location);
      expect(downloadResponse.headers.get('content-disposition')).toContain(
        'attachment',
      );
    });

    it('returns 404 VIDEO_NOT_FOUND for an unknown id', async () => {
      const res = await request(app.getHttpServer())
        .get('/videos/00000000-0000-0000-0000-000000000000/download')
        .expect(404);

      expect(res.body.error).toBe('VIDEO_NOT_FOUND');
    });

    it.each<[VideoStatus]>([['draft'], ['processing'], ['failed']])(
      'returns 409 VIDEO_NOT_READY for a video with status %s',
      async (status) => {
        const video = await createVideo(status);

        const res = await request(app.getHttpServer())
          .get(`/videos/${video.id}/download`)
          .expect(409);

        expect(res.body.error).toBe('VIDEO_NOT_READY');
      },
    );
  });
});
