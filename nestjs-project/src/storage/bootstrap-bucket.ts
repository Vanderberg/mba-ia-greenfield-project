import 'dotenv/config';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import storageConfig from '../config/storage.config';

export async function bootstrapBucket(): Promise<void> {
  const config = storageConfig();
  const client = new S3Client({
    endpoint: config.internalEndpoint,
    forcePathStyle: true,
    region: config.region,
    // MinIO rejects the AWS SDK v3 default request-checksum headers on
    // bucket-level operations (CORS/lifecycle) with "NotImplemented" —
    // only compute checksums when the API actually requires one.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });

  try {
    await client.send(new CreateBucketCommand({ Bucket: config.bucket }));
  } catch (error) {
    const code =
      (error as { Code?: string; name?: string }).Code ??
      (error as { name?: string }).name;
    if (code !== 'BucketAlreadyOwnedByYou' && code !== 'BucketAlreadyExists') {
      throw error;
    }
  }

  // Bucket has no anonymous-read policy applied (per phase-03-videos/TD-01):
  // private by default, every read goes through StorageService's presigned URLs.

  // CORS: MinIO does not implement the S3 PutBucketCors REST API (bucket-level
  // CORS) — it rejects the request with "NotImplemented". MinIO's CORS is
  // configured server-wide via the MINIO_API_CORS_ALLOW_ORIGIN env var on the
  // minio service itself (see nestjs-project/compose.yaml), not per-bucket here.

  // Incomplete-multipart-upload lifecycle rule (per phase-03-videos/TD-03's
  // Context) is INTENTIONALLY NOT configured here: this MinIO release
  // (RELEASE.2025-09-07) silently drops the AbortIncompleteMultipartUpload
  // element from any PutBucketLifecycleConfiguration request — confirmed via
  // both the AWS SDK and MinIO's own `mc ilm import`, and by reading the rule
  // back afterward (the action is simply absent from the stored config, no
  // error surfaced). This is a server-side limitation of this MinIO version,
  // not a client bug. Tracked as a known gap — revisit if/when the MinIO
  // image is upgraded to a release that honors this lifecycle action.
}

if (require.main === module) {
  void bootstrapBucket().then(() => {
    console.log(
      'MinIO bucket bootstrapped: private policy. CORS is configured server-wide via MINIO_API_CORS_ALLOW_ORIGIN in compose.yaml. Incomplete-multipart-upload lifecycle rule NOT set — unsupported by this MinIO release (see code comment).',
    );
  });
}
