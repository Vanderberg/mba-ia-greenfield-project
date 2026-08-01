import * as crypto from 'crypto';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import {
  UploadForbiddenException,
  UploadMetadataInvalidException,
  VideoNotFoundException,
  VideoNotReadyException,
  VideoNotVisibleException,
} from '../common/exceptions/domain.exception';
import { Video } from './entities/video.entity';

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly channelsService: ChannelsService,
  ) {}

  /**
   * Pre-registers a draft for the authenticated user's channel. Every
   * registered user has exactly one channel (created at signup, Phase 02) —
   * a missing channel here is an unexpected invariant violation, not a
   * cataloged domain error, so it propagates as an unhandled error.
   */
  async createDraftForUser(userId: string): Promise<Video> {
    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) {
      throw new Error(`No channel found for user ${userId}`);
    }
    return this.createDraft(channel.id);
  }

  async createDraft(channelId: string): Promise<Video> {
    const id = crypto.randomUUID();
    const video = this.videoRepository.create({
      id,
      channel_id: channelId,
      // @tus/s3-store always writes the finished object under the bare
      // tus resource id (per its `create()`/`getUpload()` internals) —
      // there is no hook to namespace this key. Since `namingFunction`
      // (TusUploadService) forces the tus resource id to equal this
      // video's id, storage_key must match that exact key, not a
      // `videos/{id}/...`-prefixed path.
      storage_key: id,
    });
    return this.videoRepository.save(video);
  }

  /**
   * Loads a video, enforcing the visibility rule (per the Authorization
   * Matrix): the owning channel's user may see any status; anyone else may
   * only see it once it is `ready`.
   */
  async findVisibleById(id: string, requesterUserId?: string): Promise<Video> {
    const video = await this.videoRepository.findOne({
      where: { id },
      relations: ['channel'],
    });
    if (!video) {
      throw new VideoNotFoundException();
    }

    const isOwner =
      requesterUserId !== undefined &&
      video.channel.user_id === requesterUserId;

    if (video.status !== 'ready' && !isOwner) {
      throw new VideoNotVisibleException();
    }

    return video;
  }

  /**
   * Loads a video by id, requiring it to exist, be in `status: draft`, and
   * be owned by `userId` — the gate for starting a NEW `tus` upload session
   * against it (per `phase-03-videos/TD-04`'s Validation Rules).
   */
  async assertOwnedDraft(videoId: string, userId: string): Promise<Video> {
    const video = await this.videoRepository.findOne({
      where: { id: videoId },
      relations: ['channel'],
    });
    if (!video || video.status !== 'draft') {
      throw new UploadMetadataInvalidException(
        `videoId '${videoId}' does not reference an existing draft video`,
      );
    }
    if (video.channel.user_id !== userId) {
      throw new UploadForbiddenException();
    }
    return video;
  }

  /**
   * Loads a video by id, requiring only that it exists and is owned by
   * `userId` — the gate for CONTINUING an already-open `tus` upload session
   * (`PATCH`/`HEAD`/`DELETE`), where the video may have already moved past
   * `draft` if a previous chunk already finished the upload.
   */
  async assertOwnership(videoId: string, userId: string): Promise<Video> {
    const video = await this.videoRepository.findOne({
      where: { id: videoId },
      relations: ['channel'],
    });
    if (!video) {
      throw new UploadMetadataInvalidException(
        `No video found for id '${videoId}'`,
      );
    }
    if (video.channel.user_id !== userId) {
      throw new UploadForbiddenException();
    }
    return video;
  }

  /**
   * Loads a video for delivery (stream/download), requiring only that it
   * exists and is `status: 'ready'` — per the Authorization Matrix, these
   * endpoints are open to any requester (anonymous included) once a video
   * is ready; no ownership/visibility check applies here.
   */
  async findReadyById(id: string): Promise<Video> {
    const video = await this.videoRepository.findOneBy({ id });
    if (!video) {
      throw new VideoNotFoundException();
    }
    if (video.status !== 'ready') {
      throw new VideoNotReadyException();
    }
    return video;
  }

  async markProcessing(videoId: string): Promise<void> {
    await this.videoRepository.update(
      { id: videoId },
      { status: 'processing' },
    );
  }
}
