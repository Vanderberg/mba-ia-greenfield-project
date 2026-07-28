import * as crypto from 'crypto';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import {
  VideoNotFoundException,
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
      storage_key: `videos/${id}/original`,
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
}
