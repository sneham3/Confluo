import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile, open } from 'node:fs/promises';
import path from 'node:path';
import type { ObjectStorage, PresignedPut } from './types.js';

export interface LocalStorageToken {
  op: 'put' | 'get';
  key: string;
  exp: number;
  contentType?: string;
  contentLength?: number;
}

function b64url(s: string | Buffer) {
  return Buffer.from(s).toString('base64url');
}

/**
 * Disk-backed storage for local mode. "Presigned" URLs point at the API's
 * /v1/local-storage/:token routes, which call back into this adapter.
 */
export class LocalObjectStorage implements ObjectStorage {
  readonly kind = 'local' as const;

  constructor(
    private readonly rootDir: string,
    private readonly baseUrl: string,
    private readonly secret: string,
  ) {}

  private filePath(key: string) {
    const safe = path.normalize(key).replace(/^(\.\.[/\\])+/, '');
    return path.join(this.rootDir, safe);
  }

  private sign(payload: string) {
    return createHmac('sha256', this.secret).update(payload).digest('base64url');
  }

  makeToken(t: LocalStorageToken): string {
    const payload = b64url(JSON.stringify(t));
    return `${payload}.${this.sign(payload)}`;
  }

  verifyToken(token: string): LocalStorageToken | null {
    const [payload, sig] = token.split('.');
    if (!payload || !sig) return null;
    const expected = this.sign(payload);
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    try {
      const t = JSON.parse(Buffer.from(payload, 'base64url').toString()) as LocalStorageToken;
      if (t.exp < Date.now()) return null;
      return t;
    } catch {
      return null;
    }
  }

  async presignPut(
    key: string,
    opts: { contentType: string; contentLength: number; expiresSeconds: number },
  ): Promise<PresignedPut> {
    const token = this.makeToken({
      op: 'put',
      key,
      exp: Date.now() + opts.expiresSeconds * 1000,
      contentType: opts.contentType,
      contentLength: opts.contentLength,
    });
    return {
      url: `${this.baseUrl}/v1/local-storage/${token}`,
      headers: { 'Content-Type': opts.contentType },
    };
  }

  async put(key: string, bytes: Uint8Array, contentType: string) {
    const p = this.filePath(key);
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, bytes);
    await writeFile(`${p}.meta.json`, JSON.stringify({ contentType }));
  }

  async head(key: string) {
    try {
      const p = this.filePath(key);
      const s = await stat(p);
      let contentType: string | null = null;
      try {
        contentType = (JSON.parse(await readFile(`${p}.meta.json`, 'utf8')) as { contentType: string })
          .contentType;
      } catch {
        /* no meta */
      }
      return { size: s.size, contentType };
    } catch {
      return null;
    }
  }

  async getRange(key: string, start: number, endInclusive: number) {
    const fh = await open(this.filePath(key), 'r');
    try {
      const len = endInclusive - start + 1;
      const buf = Buffer.alloc(len);
      const { bytesRead } = await fh.read(buf, 0, len, start);
      return new Uint8Array(buf.buffer, buf.byteOffset, bytesRead);
    } finally {
      await fh.close();
    }
  }

  async getObject(key: string) {
    const b = await readFile(this.filePath(key));
    return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  }

  async presignGet(key: string, opts: { expiresSeconds: number; contentType?: string }) {
    const token = this.makeToken({
      op: 'get',
      key,
      exp: Date.now() + opts.expiresSeconds * 1000,
      contentType: opts.contentType,
    });
    return `${this.baseUrl}/v1/local-storage/${token}`;
  }

  async delete(key: string) {
    const p = this.filePath(key);
    await rm(p, { force: true });
    await rm(`${p}.meta.json`, { force: true });
  }
}
