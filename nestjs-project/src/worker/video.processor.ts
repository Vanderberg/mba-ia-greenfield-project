import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { path as ffmpegPath } from '@ffmpeg-installer/ffmpeg';
import { path as ffprobePath } from '@ffprobe-installer/ffprobe';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Job } from 'bullmq';
import ffmpeg from 'fluent-ffmpeg';
import { Repository } from 'typeorm';
import { PROCESS_VIDEO_QUEUE } from '../queue/queue.constants';
import { StorageService } from '../storage/storage.service';
import { Video } from '../videos/entities/video.entity';

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

interface ProcessVideoJobData {
  videoId: string;
}

const THUMBNAIL_FILENAME = 'thumbnail.jpg';

@Processor(PROCESS_VIDEO_QUEUE)
export class VideoProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessor.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
  ) {
    super();
  }

  async process(job: Job<ProcessVideoJobData>): Promise<void> {
    const { videoId } = job.data;
    const video = await this.videoRepository.findOneByOrFail({
      id: videoId,
    });

    // Worker needs genuine random-seek access for ffprobe's trailing `moov`
    // atom read and the thumbnail's arbitrary-timestamp seek (per
    // phase-03-videos/TD-05's Option A) — the object is downloaded to a
    // local temp file rather than streamed.
    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), `video-${videoId}-`),
    );
    const tempFilePath = path.join(tempDir, 'original');

    try {
      await this.storageService.downloadToFile(video.storage_key, tempFilePath);

      const probeData = await this.ffprobe(tempFilePath);
      const durationSeconds = Math.round(probeData.format.duration ?? 0);

      await this.generateThumbnail(tempFilePath, tempDir);
      const thumbnailBuffer = await fs.readFile(
        path.join(tempDir, THUMBNAIL_FILENAME),
      );
      const thumbnailKey = `videos/${videoId}/${THUMBNAIL_FILENAME}`;
      await this.storageService.putObject(thumbnailKey, thumbnailBuffer);

      // Upsert-by-final-value (per phase-03-videos/TD-02's idempotency
      // note): a BullMQ retry of the same job after a crash safely
      // rewrites the same final state instead of duplicating/corrupting it.
      await this.videoRepository.update(
        { id: videoId },
        {
          status: 'ready',
          thumbnail_key: thumbnailKey,
          duration_seconds: durationSeconds,
        },
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }

  private ffprobe(filePath: string): Promise<ffmpeg.FfprobeData> {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(
        filePath,
        (err: Error | null, data: ffmpeg.FfprobeData) => {
          if (err) {
            reject(err);
          } else {
            resolve(data);
          }
        },
      );
    });
  }

  private generateThumbnail(filePath: string, folder: string): Promise<void> {
    return new Promise((resolve, reject) => {
      ffmpeg(filePath)
        .on('end', () => resolve())
        .on('error', (err: Error) => reject(err))
        .screenshots({
          count: 1,
          timemarks: ['50%'],
          folder,
          filename: THUMBNAIL_FILENAME,
        });
    });
  }

  // Dead-letter (per phase-03-videos/TD-02's Context): once BullMQ's
  // configured `attempts` are exhausted, this fires as the terminal event
  // for the job and Video.status moves to 'failed' instead of staying
  // stuck in 'processing'.
  @OnWorkerEvent('failed')
  async onFailed(job: Job<ProcessVideoJobData> | undefined): Promise<void> {
    if (!job) {
      return;
    }
    const maxAttempts =
      typeof job.opts.attempts === 'number' ? job.opts.attempts : 1;
    if (job.attemptsMade < maxAttempts) {
      return;
    }
    this.logger.error(
      `process-video job for videoId=${job.data.videoId} exhausted all ${maxAttempts} attempts — marking as failed`,
    );
    await this.videoRepository.update(
      { id: job.data.videoId },
      { status: 'failed' },
    );
  }
}
