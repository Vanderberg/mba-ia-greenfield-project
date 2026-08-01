import { S3Store } from '@tus/s3-store';
import { Server } from '@tus/server';
import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { Queue } from 'bullmq';
import type { ServerRequest as Request } from 'srvx';
import * as http from 'http';
import { BEARER_PREFIX } from '../auth/auth.constants';
import type { JwtPayload } from '../auth/auth.types';
import { DomainException } from '../common/exceptions/domain.exception';
import storageConfig from '../config/storage.config';
import {
  PROCESS_VIDEO_JOB_OPTIONS,
  PROCESS_VIDEO_QUEUE,
} from '../queue/queue.constants';
import { VideosService } from '../videos/videos.service';

const TEN_GB = 10 * 1024 ** 3;

// @tus/server's hook error convention reads `status_code`/`body` off
// whatever is thrown (see its `onError` handler) — a real Error subclass
// carrying those fields satisfies both that convention and lint's
// only-throw-error rule.
class TusError extends Error {
  constructor(
    public readonly status_code: number,
    error: string,
    message: string,
  ) {
    super(message);
    this.body = JSON.stringify({ statusCode: status_code, error, message });
  }

  readonly body: string;
}

function jsonError(
  status_code: number,
  error: string,
  message: string,
): TusError {
  return new TusError(status_code, error, message);
}

@Injectable()
export class TusUploadService {
  readonly server: Server;

  constructor(
    @Inject(storageConfig.KEY)
    config: ConfigType<typeof storageConfig>,
    private readonly jwtService: JwtService,
    private readonly videosService: VideosService,
    @InjectQueue(PROCESS_VIDEO_QUEUE) private readonly queue: Queue,
  ) {
    this.server = new Server({
      path: '/uploads',
      maxSize: TEN_GB,
      // The tus resource id equals our videoId (per phase-03-videos/TD-04) —
      // this is what lets onIncomingRequest/PATCH/HEAD/DELETE resolve
      // ownership directly from the URL, with no separate id mapping.
      namingFunction: (_req, metadata) => {
        const videoId = metadata?.videoId;
        if (!videoId) {
          throw jsonError(
            400,
            'UPLOAD_METADATA_INVALID',
            'Upload-Metadata is missing the required "videoId" field',
          );
        }
        return videoId;
      },
      datastore: new S3Store({
        s3ClientConfig: {
          endpoint: config.internalEndpoint,
          forcePathStyle: true,
          region: config.region,
          bucket: config.bucket,
          requestChecksumCalculation: 'WHEN_REQUIRED',
          credentials: {
            accessKeyId: config.accessKeyId,
            secretAccessKey: config.secretAccessKey,
          },
        },
      }),
      onUploadCreate: async (req, upload) => {
        const user = this.verifyBearerToken(req);
        try {
          await this.videosService.assertOwnedDraft(upload.id, user.sub);
        } catch (error) {
          if (error instanceof DomainException) {
            throw jsonError(error.httpStatus, error.errorCode, error.message);
          }
          throw error;
        }
        return {};
      },
      onUploadFinish: async (_req, upload) => {
        const videoId = upload.id;
        await this.videosService.markProcessing(videoId);
        await this.queue.add(
          'process-video',
          { videoId },
          { jobId: videoId, ...PROCESS_VIDEO_JOB_OPTIONS },
        );
        return {};
      },
    });
  }

  private verifyBearerToken(req: Request): JwtPayload {
    const authHeader = req.headers.get('authorization');
    if (!authHeader?.startsWith(BEARER_PREFIX)) {
      throw jsonError(401, 'UNAUTHORIZED', 'Missing or malformed access token');
    }
    const token = authHeader.slice(BEARER_PREFIX.length);
    try {
      return this.jwtService.verify<JwtPayload>(token);
    } catch {
      throw jsonError(401, 'UNAUTHORIZED', 'Invalid or expired access token');
    }
  }

  async handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    return this.server.handle(req, res);
  }
}
