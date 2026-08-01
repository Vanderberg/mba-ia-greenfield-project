import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { MailService } from '../src/mail/mail.service';

describe('Videos — draft pre-registration (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;

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

  describe('POST /videos', () => {
    it('returns 201 with { id, status: "draft" } for an authenticated user', async () => {
      const accessToken = await registerConfirmAndLogin('drafts1@example.com');

      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(201);

      expect(res.body.id).toBeDefined();
      expect(res.body.status).toBe('draft');
    });

    it('returns 401 without an access token', async () => {
      await request(app.getHttpServer()).post('/videos').expect(401);
    });
  });

  describe('GET /videos/:id', () => {
    it('returns 404 for an unknown id', async () => {
      const accessToken = await registerConfirmAndLogin('drafts2@example.com');

      const res = await request(app.getHttpServer())
        .get('/videos/00000000-0000-0000-0000-000000000000')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(404);

      expect(res.body.error).toBe('VIDEO_NOT_FOUND');
    });

    it('returns the draft to its owner regardless of status', async () => {
      const accessToken = await registerConfirmAndLogin('drafts3@example.com');
      const created = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${accessToken}`);

      const res = await request(app.getHttpServer())
        .get(`/videos/${created.body.id}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(res.body.id).toBe(created.body.id);
      expect(res.body.status).toBe('draft');
      expect(res.body.thumbnailUrl).toBeNull();
    });

    it('returns 403 VIDEO_NOT_VISIBLE to a non-owner for a draft video', async () => {
      const ownerToken = await registerConfirmAndLogin('drafts4@example.com');
      const created = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${ownerToken}`);

      const otherToken = await registerConfirmAndLogin('drafts5@example.com');

      const res = await request(app.getHttpServer())
        .get(`/videos/${created.body.id}`)
        .set('Authorization', `Bearer ${otherToken}`)
        .expect(403);

      expect(res.body.error).toBe('VIDEO_NOT_VISIBLE');
    });

    it('returns 403 VIDEO_NOT_VISIBLE to an anonymous requester for a draft video', async () => {
      const ownerToken = await registerConfirmAndLogin('drafts6@example.com');
      const created = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${ownerToken}`);

      const res = await request(app.getHttpServer())
        .get(`/videos/${created.body.id}`)
        .expect(403);

      expect(res.body.error).toBe('VIDEO_NOT_VISIBLE');
    });
  });
});
