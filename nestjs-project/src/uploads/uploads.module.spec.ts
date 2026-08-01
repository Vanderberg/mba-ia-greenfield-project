import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigType } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import appConfig from '../config/app.config';
import authConfig from '../config/auth.config';
import mailConfig from '../config/mail.config';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { Channel } from '../channels/entities/channel.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { User } from '../users/entities/user.entity';
import { createTestDataSource } from '../test/create-test-data-source';
import { Video } from '../videos/entities/video.entity';
import { TusUploadService } from './tus-upload.service';
import { UploadsModule } from './uploads.module';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('UploadsModule', () => {
  let module: TestingModule;

  afterAll(async () => {
    await module?.close();
  });

  it('should compile with AuthModule, StorageModule, QueueModule, and VideosModule wired', async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [appConfig, authConfig, mailConfig, storageConfig, queueConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        BullModule.forRootAsync({
          imports: [ConfigModule],
          inject: [queueConfig.KEY],
          useFactory: (config: ConfigType<typeof queueConfig>) => ({
            connection: {
              host: config.host,
              port: config.port,
              maxRetriesPerRequest: null,
            },
          }),
        }),
        UploadsModule,
      ],
    }).compile();

    expect(module).toBeDefined();
    expect(module.get(TusUploadService)).toBeDefined();
  }, 30000);
});
