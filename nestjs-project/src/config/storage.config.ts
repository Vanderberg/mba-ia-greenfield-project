import { registerAs } from '@nestjs/config';

export default registerAs('storage', () => ({
  internalEndpoint: process.env.S3_INTERNAL_ENDPOINT || 'http://minio:9000',
  publicEndpoint: process.env.S3_PUBLIC_ENDPOINT || 'http://localhost:9000',
  region: process.env.S3_REGION || 'us-east-1',
  accessKeyId: process.env.S3_ACCESS_KEY_ID || '',
  secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || '',
  bucket: process.env.S3_BUCKET || 'streamtube-videos',
}));
