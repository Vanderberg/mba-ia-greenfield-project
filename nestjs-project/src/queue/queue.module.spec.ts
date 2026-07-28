import { getQueueToken } from '@nestjs/bullmq';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigType } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { Queue } from 'bullmq';
import queueConfig from '../config/queue.config';
import { PROCESS_VIDEO_QUEUE } from './queue.constants';
import { QueueModule } from './queue.module';

describe('QueueModule', () => {
  let queue: Queue;
  let module: TestingModule;

  afterAll(async () => {
    await queue?.close();
    await module?.close();
  });

  it('should compile and provide the process-video queue', async () => {
    const testModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
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
        QueueModule,
      ],
    }).compile();
    module = testModule;

    queue = testModule.get<Queue>(getQueueToken(PROCESS_VIDEO_QUEUE));
    expect(queue).toBeDefined();
  }, 30000);
});
