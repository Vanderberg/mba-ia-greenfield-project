import { DataSource, Repository } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { DraftCleanupProcessor } from './draft-cleanup.processor';

const ALL_ENTITIES = [User, Channel, Video];
const FORTY_NINE_HOURS_MS = 49 * 60 * 60 * 1000;
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

describe('DraftCleanupProcessor (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;
  let processor: DraftCleanupProcessor;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
    processor = new DraftCleanupProcessor(videoRepository);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createVideo(
    status: VideoStatus,
    ageMs: number,
  ): Promise<Video> {
    const user = await userRepository.save(
      userRepository.create({
        email: `draft_cleanup_${++counter}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await channelRepository.save(
      channelRepository.create({
        name: `channel${counter}`,
        nickname: `channel${counter}`,
        user_id: user.id,
      }),
    );
    const video = await videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        storage_key: `videos/draft-cleanup-${counter}/original`,
        status,
      }),
    );
    await dataSource.query('UPDATE videos SET created_at = $1 WHERE id = $2', [
      new Date(Date.now() - ageMs),
      video.id,
    ]);
    return video;
  }

  it('removes a draft video older than the 48h TTL', async () => {
    const oldDraft = await createVideo('draft', FORTY_NINE_HOURS_MS);

    await processor.process();

    expect(await videoRepository.findOneBy({ id: oldDraft.id })).toBeNull();
  });

  it('preserves a draft video younger than the 48h TTL', async () => {
    const recentDraft = await createVideo('draft', TWENTY_FOUR_HOURS_MS);

    await processor.process();

    expect(
      await videoRepository.findOneBy({ id: recentDraft.id }),
    ).not.toBeNull();
  });

  it.each<[VideoStatus]>([['processing'], ['ready'], ['failed']])(
    'preserves a %s video regardless of age',
    async (status) => {
      const oldNonDraft = await createVideo(status, FORTY_NINE_HOURS_MS);

      await processor.process();

      expect(
        await videoRepository.findOneBy({ id: oldNonDraft.id }),
      ).not.toBeNull();
    },
  );
});
