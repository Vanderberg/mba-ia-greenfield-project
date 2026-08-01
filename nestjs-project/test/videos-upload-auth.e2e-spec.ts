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

function encodeMetadata(fields: Record<string, string>): string {
  return Object.entries(fields)
    .map(([key, value]) => `${key} ${Buffer.from(value).toString('base64')}`)
    .join(',');
}

// `@tus/server` writes its own hook-rejection responses directly (bypassing
// Nest's exception filters) without a `Content-Type: application/json`
// header, so supertest never populates `res.body` for these — the JSON is
// only available as raw text.
function parseTusErrorBody(res: { text: string }): { error: string } {
  return JSON.parse(res.text) as { error: string };
}

describe('Videos — tus upload session auth (e2e)', () => {
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

  async function createDraft(accessToken: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${accessToken}`);
    return res.body.id as string;
  }

  describe('POST /uploads (create)', () => {
    it('returns 401 without an access token', async () => {
      await request(app.getHttpServer())
        .post('/uploads')
        .set('Tus-Resumable', '1.0.0')
        .set('Upload-Length', '10')
        .set('Upload-Metadata', encodeMetadata({ videoId: 'irrelevant' }))
        .expect(401);
    });

    it('returns 400 UPLOAD_METADATA_INVALID when Upload-Metadata is missing videoId', async () => {
      const accessToken = await registerConfirmAndLogin(
        'upload-auth1@example.com',
      );

      const res = await request(app.getHttpServer())
        .post('/uploads')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('Tus-Resumable', '1.0.0')
        .set('Upload-Length', '10')
        .set('Upload-Metadata', encodeMetadata({ filename: 'video.mp4' }))
        .expect(400);

      expect(parseTusErrorBody(res).error).toBe('UPLOAD_METADATA_INVALID');
    });

    it('returns 403 UPLOAD_FORBIDDEN when videoId belongs to another user', async () => {
      const ownerToken = await registerConfirmAndLogin(
        'upload-auth-owner@example.com',
      );
      const videoId = await createDraft(ownerToken);

      const otherToken = await registerConfirmAndLogin(
        'upload-auth-other@example.com',
      );

      const res = await request(app.getHttpServer())
        .post('/uploads')
        .set('Authorization', `Bearer ${otherToken}`)
        .set('Tus-Resumable', '1.0.0')
        .set('Upload-Length', '10')
        .set('Upload-Metadata', encodeMetadata({ videoId }))
        .expect(403);

      expect(parseTusErrorBody(res).error).toBe('UPLOAD_FORBIDDEN');
    });

    it('returns 400 UPLOAD_METADATA_INVALID when videoId does not reference an existing draft', async () => {
      const accessToken = await registerConfirmAndLogin(
        'upload-auth2@example.com',
      );

      const res = await request(app.getHttpServer())
        .post('/uploads')
        .set('Authorization', `Bearer ${accessToken}`)
        .set('Tus-Resumable', '1.0.0')
        .set('Upload-Length', '10')
        .set(
          'Upload-Metadata',
          encodeMetadata({
            videoId: '00000000-0000-0000-0000-000000000000',
          }),
        )
        .expect(400);

      expect(parseTusErrorBody(res).error).toBe('UPLOAD_METADATA_INVALID');
    });
  });

  describe('HEAD/PATCH /uploads/:id (continue session)', () => {
    it('returns 401 without an access token', async () => {
      await request(app.getHttpServer())
        .head('/uploads/00000000-0000-0000-0000-000000000000')
        .set('Tus-Resumable', '1.0.0')
        .expect(401);
    });

    it('returns 403 when the resource id belongs to another user', async () => {
      const ownerToken = await registerConfirmAndLogin(
        'upload-auth-owner2@example.com',
      );
      const videoId = await createDraft(ownerToken);

      const otherToken = await registerConfirmAndLogin(
        'upload-auth-other2@example.com',
      );

      await request(app.getHttpServer())
        .head(`/uploads/${videoId}`)
        .set('Authorization', `Bearer ${otherToken}`)
        .set('Tus-Resumable', '1.0.0')
        .expect(403);
    });
  });
});
