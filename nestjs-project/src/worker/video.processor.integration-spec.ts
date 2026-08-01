import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { ConfigModule, ConfigType } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { Queue } from 'bullmq';
import ffmpeg from 'fluent-ffmpeg';
import { DataSource, Repository } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import {
  PROCESS_VIDEO_QUEUE,
  PROCESS_VIDEO_JOB_OPTIONS,
} from '../queue/queue.constants';
import { bootstrapBucket } from '../storage/bootstrap-bucket';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video } from '../videos/entities/video.entity';
import { VideoProcessor } from './video.processor';

const ALL_ENTITIES = [User, Channel, Video];

async function generateTestVideoBuffer(): Promise<Buffer> {
  const tempPath = path.join(os.tmpdir(), `tus-test-source-${Date.now()}.mp4`);
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
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Condition not met within ${timeoutMs}ms`);
}

describe('VideoProcessor (integration)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;
  let queue: Queue;
  let storageService: StorageService;
  let testVideoBuffer: Buffer;

  beforeAll(async () => {
    await bootstrapBucket();
    testVideoBuffer = await generateTestVideoBuffer();

    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, queueConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        TypeOrmModule.forFeature([Video]),
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
        BullModule.registerQueue({ name: PROCESS_VIDEO_QUEUE }),
        StorageModule,
      ],
      providers: [VideoProcessor],
    }).compile();

    await moduleRef.init();

    dataSource = moduleRef.get(DataSource);
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
    queue = moduleRef.get<Queue>(getQueueToken(PROCESS_VIDEO_QUEUE));
    storageService = moduleRef.get(StorageService);
  }, 60000);

  afterAll(async () => {
    await queue.close();
    await moduleRef.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await queue.drain(true);
  });

  let counter = 0;
  async function createDraftVideo(storageKey: string): Promise<Video> {
    const user = await userRepository.save(
      userRepository.create({
        email: `video_processor_${++counter}@example.com`,
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
        storage_key: storageKey,
      }),
    );
  }

  it('processes a real video: extracts duration, generates a thumbnail, and marks the video ready', async () => {
    const storageKey = `videos/test-${++counter}/original`;
    await storageService.putObject(storageKey, testVideoBuffer);
    const video = await createDraftVideo(storageKey);

    await queue.add(
      'process-video',
      { videoId: video.id },
      { jobId: video.id, ...PROCESS_VIDEO_JOB_OPTIONS },
    );

    await waitFor(async () => {
      const current = await videoRepository.findOneByOrFail({
        id: video.id,
      });
      return current.status !== 'draft' && current.status !== 'processing';
    }, 30000);

    const processed = await videoRepository.findOneByOrFail({ id: video.id });
    expect(processed.status).toBe('ready');
    expect(processed.duration_seconds).toBeGreaterThan(0);
    expect(processed.thumbnail_key).toBe(`videos/${video.id}/thumbnail.jpg`);
    expect(await storageService.objectExists(processed.thumbnail_key!)).toBe(
      true,
    );
  }, 40000);

  it('marks the video as failed once retries are exhausted (dead-letter)', async () => {
    // storage_key deliberately never uploaded — every attempt's
    // downloadToFile() fails with a real MinIO "not found" error.
    const storageKey = `videos/test-${++counter}/missing-original`;
    const video = await createDraftVideo(storageKey);

    await queue.add(
      'process-video',
      { videoId: video.id },
      { jobId: video.id, attempts: 2, backoff: { type: 'fixed', delay: 200 } },
    );

    await waitFor(async () => {
      const current = await videoRepository.findOneByOrFail({
        id: video.id,
      });
      return current.status === 'failed';
    }, 20000);

    const failed = await videoRepository.findOneByOrFail({ id: video.id });
    expect(failed.status).toBe('failed');
  }, 30000);
});
