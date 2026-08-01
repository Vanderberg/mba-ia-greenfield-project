import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { PROCESS_VIDEO_QUEUE } from './queue.constants';

@Module({
  imports: [BullModule.registerQueue({ name: PROCESS_VIDEO_QUEUE })],
  exports: [BullModule],
})
export class QueueModule {}
