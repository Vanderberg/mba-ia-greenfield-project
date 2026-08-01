import { INestApplication, ValidationPipe } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { Upload } from 'tus-js-client';
import type { Queue } from 'bullmq';
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
import { PROCESS_VIDEO_QUEUE } from '../src/queue/queue.constants';
import { Video } from '../src/videos/entities/video.entity';

describe('Videos — tus resumable upload flow (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;
  let processVideoQueue: Queue;
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
    processVideoQueue = moduleFixture.get<Queue>(
      getQueueToken(PROCESS_VIDEO_QUEUE),
    );
  }, 30000);

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
    await processVideoQueue.drain(true);
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

  it('uploads a file end-to-end, resuming after a simulated connection drop, and enqueues processing', async () => {
    const accessToken = await registerConfirmAndLogin(
      'upload-flow1@example.com',
    );
    const videoId = await createDraft(accessToken);

    const fileSize = 3 * 1024 * 1024; // 3MB across 1MB chunks
    const fileContent = Buffer.alloc(fileSize, 'a');
    const chunkSize = 1024 * 1024;

    // First session: abort partway through, after the first chunk lands —
    // simulates a dropped connection mid-upload.
    const offsetAfterDrop = await new Promise<number>((resolve, reject) => {
      const upload = new Upload(fileContent, {
        endpoint: `${baseUrl}/uploads`,
        chunkSize,
        metadata: { videoId, filename: 'test-video.mp4' },
        headers: { Authorization: `Bearer ${accessToken}` },
        onError: reject,
        onChunkComplete: (_chunkSize, bytesAccepted) => {
          void upload.abort().then(() => resolve(bytesAccepted));
        },
        onSuccess: () => reject(new Error('unexpected early success')),
      });
      upload.start();
    });

    expect(offsetAfterDrop).toBe(chunkSize);

    // The tus resource id equals videoId (per phase-03-videos/TD-04's
    // namingFunction), so the resume target URL is fully deterministic.
    const resumeUrl = `${baseUrl}/uploads/${videoId}`;

    await new Promise<void>((resolve, reject) => {
      const resumedUpload = new Upload(fileContent, {
        uploadUrl: resumeUrl,
        chunkSize,
        metadata: { videoId, filename: 'test-video.mp4' },
        headers: { Authorization: `Bearer ${accessToken}` },
        onError: reject,
        onSuccess: () => resolve(),
      });
      resumedUpload.start();
    });

    const videoRepository = dataSource.getRepository(Video);
    const video = await videoRepository.findOneByOrFail({ id: videoId });
    expect(video.status).toBe('processing');

    const job = await processVideoQueue.getJob(videoId);
    expect(job).not.toBeNull();
    expect(job?.data).toEqual({ videoId });
  }, 30000);
});
