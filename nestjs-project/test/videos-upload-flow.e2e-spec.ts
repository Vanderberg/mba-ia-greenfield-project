import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { Upload } from 'tus-js-client';
import ffmpeg from 'fluent-ffmpeg';
import { path as ffmpegPath } from '@ffmpeg-installer/ffmpeg';
import { path as ffprobePath } from '@ffprobe-installer/ffprobe';
import { AddressInfo } from 'net';
import type { Server } from 'http';
import { DataSource } from 'typeorm';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import storageConfig from '../src/config/storage.config';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { MailService } from '../src/mail/mail.service';
import { StorageService } from '../src/storage/storage.service';

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

async function generateTestVideoBuffer(): Promise<Buffer> {
  const tempPath = path.join(os.tmpdir(), `flow-test-source-${Date.now()}.mp4`);
  await new Promise<void>((resolve, reject) => {
    ffmpeg()
      .input('testsrc=size=320x240:rate=10')
      .inputFormat('lavfi')
      .duration(2)
      .output(tempPath)
      .on('end', () => resolve())
      .on('error', (err: Error) => reject(err))
      .run();
  });
  const buffer = await fs.readFile(tempPath);
  await fs.rm(tempPath, { force: true });
  return buffer;
}

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Condition not met within ${timeoutMs}ms`);
}

// Requires the real `video-worker` process to be running and consuming the
// shared Redis queue (per phase-03-videos/SI-03.9 — validates the full
// pipeline against real Compose infrastructure: MinIO, Redis, worker).
describe('Videos — full upload → processing → delivery flow (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;
  let baseUrl: string;
  let testVideoBuffer: Buffer;

  beforeAll(async () => {
    testVideoBuffer = await generateTestVideoBuffer();

    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    })
      // The presigned URL is signed against S3_PUBLIC_ENDPOINT
      // (http://localhost:9000), reachable from a browser on the Docker
      // host but NOT from this test process, which runs inside the
      // nestjs-api container (a sibling of `minio`, not the host).
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
    await app.listen(0);

    const address = (app.getHttpServer() as Server).address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;

    dataSource = moduleFixture.get(DataSource);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
  }, 30000);

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
  });

  async function captureConfirmationToken(
    email: string,
    password = 'password123',
  ): Promise<string> {
    const authService = app.get(AuthService);
    const mailServiceInstance = (
      authService as unknown as { mailService: MailService }
    ).mailService;
    let capturedToken = '';
    jest
      .spyOn(mailServiceInstance, 'sendConfirmationEmail')
      .mockImplementationOnce(async (_e: string, _n: string, t: string) => {
        await Promise.resolve();
        capturedToken = t;
      });
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password });
    return capturedToken;
  }

  async function registerConfirmAndLogin(
    email: string,
    password = 'password123',
  ): Promise<string> {
    const token = await captureConfirmationToken(email, password);
    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token });
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password });
    return res.body.access_token as string;
  }

  async function createDraft(accessToken: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${accessToken}`);
    return res.body.id as string;
  }

  async function getStatus(
    videoId: string,
    accessToken: string,
  ): Promise<string> {
    const res = await request(app.getHttpServer())
      .get(`/videos/${videoId}`)
      .set('Authorization', `Bearer ${accessToken}`);
    return res.body.status as string;
  }

  it('goes from draft to ready and serves both stream and download after a complete upload', async () => {
    const accessToken = await registerConfirmAndLogin(
      'upload-flow-happy@example.com',
    );
    const videoId = await createDraft(accessToken);

    await new Promise<void>((resolve, reject) => {
      const upload = new Upload(testVideoBuffer, {
        endpoint: `${baseUrl}/uploads`,
        chunkSize: 1024 * 1024,
        metadata: { videoId, filename: 'flow-happy.mp4' },
        headers: { Authorization: `Bearer ${accessToken}` },
        onError: reject,
        onSuccess: () => resolve(),
      });
      upload.start();
    });

    await waitFor(
      async () => (await getStatus(videoId, accessToken)) === 'ready',
      60000,
    );

    const streamRes = await request(app.getHttpServer())
      .get(`/videos/${videoId}/stream`)
      .redirects(0)
      .expect(302);
    const streamUrl = streamRes.headers.location;
    const rangeResponse = await fetch(streamUrl, {
      headers: { Range: 'bytes=0-100' },
    });
    expect(rangeResponse.status).toBe(206);

    const downloadRes = await request(app.getHttpServer())
      .get(`/videos/${videoId}/download`)
      .redirects(0)
      .expect(302);
    const downloadUrl = downloadRes.headers.location;
    const downloadResponse = await fetch(downloadUrl);
    expect(downloadResponse.headers.get('content-disposition')).toContain(
      'attachment',
    );
  }, 90000);
});
