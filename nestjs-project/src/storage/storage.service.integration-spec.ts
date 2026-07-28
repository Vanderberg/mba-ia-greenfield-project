import { bootstrapBucket } from './bootstrap-bucket';
import { StorageService } from './storage.service';
import storageConfig from '../config/storage.config';

describe('StorageService (integration)', () => {
  let storageService: StorageService;

  beforeAll(async () => {
    await bootstrapBucket();
    // The real S3_PUBLIC_ENDPOINT (e.g. http://localhost:9000) is reachable
    // from a browser on the Docker host, but NOT from this test process,
    // which itself runs inside the nestjs-api container — a Docker-network
    // sibling of `minio`, not the host. From this vantage point the
    // container-reachable stand-in for "public" is the `minio` service
    // hostname itself; the signing/serving mechanics under test
    // (SigV4 presigned GetObject, Range support, Content-Disposition) are
    // identical regardless of which reachable host is used.
    storageService = new StorageService({
      ...storageConfig(),
      publicEndpoint: storageConfig().internalEndpoint,
    });
  }, 30000);

  it('round-trips bytes through a presigned GetObject URL', async () => {
    const key = `test/${Date.now()}-roundtrip.txt`;
    const content = 'streamtube integration test payload';

    await storageService.putObject(key, Buffer.from(content));

    const url = await storageService.getPresignedUrl(key);
    const response = await fetch(url);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(content);
  });

  it('honors Range requests against the presigned streaming URL', async () => {
    const key = `test/${Date.now()}-range.txt`;
    const content = '0123456789';

    await storageService.putObject(key, Buffer.from(content));

    const url = await storageService.getPresignedUrl(key);
    const response = await fetch(url, { headers: { Range: 'bytes=2-5' } });

    expect(response.status).toBe(206);
    expect(await response.text()).toBe('2345');
  });

  it('sets Content-Disposition: attachment when download is requested', async () => {
    const key = `test/${Date.now()}-download.txt`;
    await storageService.putObject(key, Buffer.from('download me'));

    const url = await storageService.getPresignedUrl(key, { download: true });
    const response = await fetch(url);

    expect(response.headers.get('content-disposition')).toContain('attachment');
  });

  it('reports objectExists correctly for present and absent keys', async () => {
    const key = `test/${Date.now()}-exists.txt`;
    await storageService.putObject(key, Buffer.from('x'));

    expect(await storageService.objectExists(key)).toBe(true);
    expect(await storageService.objectExists(`${key}-missing`)).toBe(false);
  });
});
