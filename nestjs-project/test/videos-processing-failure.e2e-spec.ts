import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { Upload } from 'tus-js-client';
import { AddressInfo } from 'net';
import type { Server } from 'http';
import { DataSource } from 'typeorm';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { MailService } from '../src/mail/mail.service';

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
// shared Redis queue (per phase-03-videos/SI-03.9). The dead-letter policy
// (PROCESS_VIDEO_JOB_OPTIONS — 3 attempts, exponential backoff from 5s) is
// exercised for real here, so this test needs a generous timeout.
describe('Videos — processing failure ends in status: failed (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;
  let baseUrl: string;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

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

  it('marks the video as failed when the uploaded file is not a valid video', async () => {
    const accessToken = await registerConfirmAndLogin(
      'processing-failure@example.com',
    );
    const videoId = await createDraft(accessToken);

    // Not a real video container — ffprobe fails on this every attempt,
    // driving the job through all configured retries.
    const invalidContent = Buffer.from(
      'this is definitely not a valid video file'.repeat(100),
    );

    await new Promise<void>((resolve, reject) => {
      const upload = new Upload(invalidContent, {
        endpoint: `${baseUrl}/uploads`,
        metadata: { videoId, filename: 'not-a-video.mp4' },
        headers: { Authorization: `Bearer ${accessToken}` },
        onError: reject,
        onSuccess: () => resolve(),
      });
      upload.start();
    });

    await waitFor(
      async () => (await getStatus(videoId, accessToken)) === 'failed',
      180000,
    );

    expect(await getStatus(videoId, accessToken)).toBe('failed');
  }, 210000);
});
