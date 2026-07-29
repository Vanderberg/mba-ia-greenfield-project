import {
  VideoNotFoundException,
  VideoNotVisibleException,
} from '../common/exceptions/domain.exception';
import { Video } from './entities/video.entity';
import { VideosService } from './videos.service';

describe('VideosService', () => {
  let service: VideosService;
  let videoRepository: {
    create: jest.Mock;
    save: jest.Mock;
    findOne: jest.Mock;
  };
  let channelsService: { findByUserId: jest.Mock };

  beforeEach(() => {
    videoRepository = {
      create: jest.fn((v: Partial<Video>) => v),
      save: jest.fn((v: Partial<Video>) => Promise.resolve(v)),
      findOne: jest.fn(),
    };
    channelsService = { findByUserId: jest.fn() };
    service = new VideosService(
      videoRepository as never,
      channelsService as never,
    );
  });

  describe('createDraft', () => {
    it('derives storage_key deterministically from the generated id', async () => {
      const video = await service.createDraft('channel-1');

      expect(video.id).toBeDefined();
      expect(video.storage_key).toBe(`videos/${video.id}/original`);
      expect(video.channel_id).toBe('channel-1');
    });
  });

  describe('createDraftForUser', () => {
    it('creates a draft for the channel owned by the given user', async () => {
      channelsService.findByUserId.mockResolvedValue({ id: 'channel-42' });

      const video = await service.createDraftForUser('user-1');

      expect(channelsService.findByUserId).toHaveBeenCalledWith('user-1');
      expect(video.channel_id).toBe('channel-42');
    });

    it('throws when the user has no channel', async () => {
      channelsService.findByUserId.mockResolvedValue(null);

      await expect(service.createDraftForUser('orphan-user')).rejects.toThrow(
        'No channel found for user orphan-user',
      );
    });
  });

  describe('findVisibleById', () => {
    it('throws VideoNotFoundException when the video does not exist', async () => {
      videoRepository.findOne.mockResolvedValue(null);

      await expect(service.findVisibleById('missing')).rejects.toThrow(
        VideoNotFoundException,
      );
    });

    it('returns a ready video to an anonymous requester', async () => {
      videoRepository.findOne.mockResolvedValue({
        id: 'v1',
        status: 'ready',
        channel: { user_id: 'owner-1' },
      });

      const video = await service.findVisibleById('v1');
      expect(video.id).toBe('v1');
    });

    it('returns a draft video to its owner', async () => {
      videoRepository.findOne.mockResolvedValue({
        id: 'v1',
        status: 'draft',
        channel: { user_id: 'owner-1' },
      });

      const video = await service.findVisibleById('v1', 'owner-1');
      expect(video.id).toBe('v1');
    });

    it('throws VideoNotVisibleException for a draft video seen by a non-owner', async () => {
      videoRepository.findOne.mockResolvedValue({
        id: 'v1',
        status: 'draft',
        channel: { user_id: 'owner-1' },
      });

      await expect(
        service.findVisibleById('v1', 'someone-else'),
      ).rejects.toThrow(VideoNotVisibleException);
    });

    it('throws VideoNotVisibleException for a draft video seen anonymously', async () => {
      videoRepository.findOne.mockResolvedValue({
        id: 'v1',
        status: 'draft',
        channel: { user_id: 'owner-1' },
      });

      await expect(service.findVisibleById('v1')).rejects.toThrow(
        VideoNotVisibleException,
      );
    });
  });
});
