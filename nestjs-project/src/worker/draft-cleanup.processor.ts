import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import { DRAFT_CLEANUP_QUEUE, DRAFT_TTL_MS } from '../queue/queue.constants';
import { Video } from '../videos/entities/video.entity';

@Processor(DRAFT_CLEANUP_QUEUE)
export class DraftCleanupProcessor extends WorkerHost {
  private readonly logger = new Logger(DraftCleanupProcessor.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
  ) {
    super();
  }

  async process(): Promise<void> {
    const cutoff = new Date(Date.now() - DRAFT_TTL_MS);
    const result = await this.videoRepository.delete({
      status: 'draft',
      created_at: LessThan(cutoff),
    });
    this.logger.log(
      `Draft cleanup removed ${result.affected ?? 0} orphaned draft video(s) older than ${cutoff.toISOString()}`,
    );
  }
}
