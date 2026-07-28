import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import storageConfig from '../config/storage.config';

export interface GetPresignedUrlOptions {
  download?: boolean;
  expiresIn?: number;
}

const DEFAULT_EXPIRES_IN_SECONDS = 900;

@Injectable()
export class StorageService {
  private readonly internalClient: S3Client;
  private readonly publicClient: S3Client;
  private readonly bucket: string;

  constructor(
    @Inject(storageConfig.KEY)
    config: ConfigType<typeof storageConfig>,
  ) {
    this.bucket = config.bucket;
    const credentials = {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    };
    this.internalClient = new S3Client({
      endpoint: config.internalEndpoint,
      forcePathStyle: true,
      region: config.region,
      // MinIO rejects the AWS SDK v3 default request-checksum headers on
      // some operations with "NotImplemented" — only compute when required.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      credentials,
    });
    this.publicClient = new S3Client({
      endpoint: config.publicEndpoint,
      forcePathStyle: true,
      region: config.region,
      requestChecksumCalculation: 'WHEN_REQUIRED',
      credentials,
    });
  }

  async putObject(key: string, body: Buffer | Uint8Array): Promise<void> {
    await this.internalClient.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body }),
    );
  }

  async objectExists(key: string): Promise<boolean> {
    try {
      await this.internalClient.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return true;
    } catch (error) {
      const statusCode = (error as { $metadata?: { httpStatusCode?: number } })
        .$metadata?.httpStatusCode;
      if (statusCode === 404) {
        return false;
      }
      throw error;
    }
  }

  async getPresignedUrl(
    key: string,
    options: GetPresignedUrlOptions = {},
  ): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ...(options.download && {
        ResponseContentDisposition: `attachment; filename="${key.split('/').pop()}"`,
      }),
    });
    return getSignedUrl(this.publicClient, command, {
      expiresIn: options.expiresIn ?? DEFAULT_EXPIRES_IN_SECONDS,
    });
  }
}
