import {
  Injectable,
  NestMiddleware,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { NextFunction, Request, Response } from 'express';
import { BEARER_PREFIX } from '../auth/auth.constants';
import type { JwtPayload } from '../auth/auth.types';
import { VideosService } from '../videos/videos.service';
import { TusUploadService } from './tus-upload.service';

/**
 * Runs BEFORE the `tus` server for every method on `/uploads*`, including
 * `HEAD` — which `@tus/server`'s own `onIncomingRequest` hook does NOT fire
 * for. This is the single place that guarantees every method (POST, HEAD,
 * PATCH, DELETE) is authenticated, per the Authorization Matrix.
 *
 * Ownership (per `phase-03-videos/TD-03`) is additionally checked here for
 * requests that target an existing resource (`/uploads/:id` — HEAD/PATCH/
 * DELETE), since the tus resource id equals our `videoId` (see
 * `TusUploadService`'s `namingFunction`). `POST /uploads` (create) has no id
 * in the URL yet — its ownership check happens inside `onUploadCreate`,
 * once `Upload-Metadata.videoId` has been parsed.
 */
@Injectable()
export class TusUploadMiddleware implements NestMiddleware {
  constructor(
    private readonly jwtService: JwtService,
    private readonly videosService: VideosService,
    private readonly tusUploadService: TusUploadService,
  ) {}

  async use(req: Request, res: Response, next: NextFunction): Promise<void> {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith(BEARER_PREFIX)) {
      return next(new UnauthorizedException());
    }

    const token = authHeader.slice(BEARER_PREFIX.length);
    let user: JwtPayload;
    try {
      user = this.jwtService.verify<JwtPayload>(token);
    } catch {
      return next(new UnauthorizedException());
    }

    const uploadId = req.path.split('/').filter(Boolean)[0];
    if (uploadId && req.method !== 'POST') {
      try {
        await this.videosService.assertOwnership(uploadId, user.sub);
      } catch (err) {
        return next(err);
      }
    }

    await this.tusUploadService.handle(req, res);
  }
}
