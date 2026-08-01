import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigType } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import appConfig from '../config/app.config';
import databaseConfig from '../config/database.config';
import { envValidationSchema } from '../config/env.validation';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import {
  DRAFT_CLEANUP_QUEUE,
  PROCESS_VIDEO_QUEUE,
} from '../queue/queue.constants';
import { Channel } from '../channels/entities/channel.entity';
import { StorageModule } from '../storage/storage.module';
import { User } from '../users/entities/user.entity';
import { Video } from '../videos/entities/video.entity';
import { DraftCleanupProcessor } from './draft-cleanup.processor';
import { DraftCleanupScheduler } from './draft-cleanup.scheduler';
import { VideoProcessor } from './video.processor';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig, databaseConfig, storageConfig, queueConfig],
      validationSchema: envValidationSchema,
      validationOptions: { allowUnknown: true, abortEarly: false },
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [databaseConfig.KEY],
      useFactory: (dbConfig: ConfigType<typeof databaseConfig>) => ({
        type: 'postgres',
        host: dbConfig.host,
        port: dbConfig.port,
        username: dbConfig.username,
        password: dbConfig.password,
        database: dbConfig.name,
        autoLoadEntities: true,
        synchronize: false,
      }),
    }),
    TypeOrmModule.forFeature([Video, Channel, User]),
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [queueConfig.KEY],
      useFactory: (qConfig: ConfigType<typeof queueConfig>) => ({
        connection: {
          host: qConfig.host,
          port: qConfig.port,
          maxRetriesPerRequest: null,
        },
      }),
    }),
    BullModule.registerQueue({ name: PROCESS_VIDEO_QUEUE }),
    BullModule.registerQueue({ name: DRAFT_CLEANUP_QUEUE }),
    StorageModule,
  ],
  providers: [VideoProcessor, DraftCleanupProcessor, DraftCleanupScheduler],
})
export class WorkerModule {}
