import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import type { Queue } from 'bullmq';
import {
  DRAFT_CLEANUP_INTERVAL_MS,
  DRAFT_CLEANUP_JOB_NAME,
  DRAFT_CLEANUP_QUEUE,
} from '../queue/queue.constants';

@Injectable()
export class DraftCleanupScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(DraftCleanupScheduler.name);

  constructor(
    @InjectQueue(DRAFT_CLEANUP_QUEUE) private readonly queue: Queue,
  ) {}

  // BullMQ keys a repeatable job definition by its (name + repeat options),
  // so re-adding the same definition on every worker restart is idempotent
  // — it does not create duplicate scheduled jobs (per
  // phase-03-videos/TD-04).
  async onApplicationBootstrap(): Promise<void> {
    await this.queue.add(
      DRAFT_CLEANUP_JOB_NAME,
      {},
      { repeat: { every: DRAFT_CLEANUP_INTERVAL_MS } },
    );
    this.logger.log(
      `Scheduled repeatable draft-cleanup job every ${DRAFT_CLEANUP_INTERVAL_MS}ms`,
    );
  }
}
