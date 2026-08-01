import { DataSource, Repository } from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { Video } from './video.entity';

const ALL_ENTITIES = [User, Channel, Video];

describe('Video (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createChannel(): Promise<Channel> {
    const user = await userRepository.save(
      userRepository.create({
        email: `video_entity_${++counter}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: `channel${counter}`,
        nickname: `channel${counter}`,
        user_id: user.id,
      }),
    );
  }

  it('persists a video with default status "draft" when not provided', async () => {
    const channel = await createChannel();

    const video = await videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        storage_key: `videos/${counter}/original`,
      }),
    );

    expect(video.id).toBeDefined();
    expect(video.status).toBe('draft');
    expect(video.title).toBeNull();
    expect(video.thumbnail_key).toBeNull();
    expect(video.duration_seconds).toBeNull();
  });

  it('rejects two videos with the same storage_key', async () => {
    const channel = await createChannel();
    const storageKey = `videos/${counter}/original`;

    await videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        storage_key: storageKey,
      }),
    );

    await expect(
      videoRepository.save(
        videoRepository.create({
          channel_id: channel.id,
          storage_key: storageKey,
        }),
      ),
    ).rejects.toThrow();
  });

  it('rejects a video referencing a non-existent channel', async () => {
    await expect(
      videoRepository.save(
        videoRepository.create({
          channel_id: '00000000-0000-0000-0000-000000000000',
          storage_key: `videos/${++counter}/original`,
        }),
      ),
    ).rejects.toThrow();
  });

  it('loads the owning channel via the channel relation', async () => {
    const channel = await createChannel();
    const video = await videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        storage_key: `videos/${counter}/original`,
      }),
    );

    const found = await videoRepository.findOne({
      where: { id: video.id },
      relations: ['channel'],
    });

    expect(found?.channel.id).toBe(channel.id);
  });
});
