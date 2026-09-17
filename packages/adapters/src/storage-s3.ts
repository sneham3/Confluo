import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { ObjectStorage, PresignedPut } from './types.js';

export interface S3Config {
  endpoint?: string;
  region: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  forcePathStyle?: boolean;
}

export class S3ObjectStorage implements ObjectStorage {
  readonly kind = 's3' as const;
  private readonly client: S3Client;

  constructor(private readonly cfg: S3Config) {
    this.client = new S3Client({
      region: cfg.region,
      endpoint: cfg.endpoint,
      forcePathStyle: cfg.forcePathStyle ?? true,
      credentials: { accessKeyId: cfg.accessKey, secretAccessKey: cfg.secretKey },
    });
  }

  async presignPut(
    key: string,
    opts: { contentType: string; contentLength: number; expiresSeconds: number },
  ): Promise<PresignedPut> {
    const cmd = new PutObjectCommand({
      Bucket: this.cfg.bucket,
      Key: key,
      ContentType: opts.contentType,
      ContentLength: opts.contentLength,
    });
    const url = await getSignedUrl(this.client, cmd, { expiresIn: opts.expiresSeconds });
    return { url, headers: { 'Content-Type': opts.contentType } };
  }

  async head(key: string) {
    try {
      const r = await this.client.send(new HeadObjectCommand({ Bucket: this.cfg.bucket, Key: key }));
      return { size: r.ContentLength ?? 0, contentType: r.ContentType ?? null };
    } catch {
      return null;
    }
  }

  async getRange(key: string, start: number, endInclusive: number) {
    const r = await this.client.send(
      new GetObjectCommand({ Bucket: this.cfg.bucket, Key: key, Range: `bytes=${start}-${endInclusive}` }),
    );
    return r.Body ? await r.Body.transformToByteArray() : new Uint8Array();
  }

  async getObject(key: string) {
    const r = await this.client.send(new GetObjectCommand({ Bucket: this.cfg.bucket, Key: key }));
    return r.Body ? await r.Body.transformToByteArray() : new Uint8Array();
  }

  async presignGet(key: string, opts: { expiresSeconds: number; contentType?: string }) {
    const cmd = new GetObjectCommand({
      Bucket: this.cfg.bucket,
      Key: key,
      ResponseContentDisposition: 'inline',
      ResponseContentType: opts.contentType,
    });
    return getSignedUrl(this.client, cmd, { expiresIn: opts.expiresSeconds });
  }

  async delete(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.cfg.bucket, Key: key }));
  }
}
