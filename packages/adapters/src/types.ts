import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import type { Schema } from '@confluo/shared/db';

export type Db = PgDatabase<PgQueryResultHKT, Schema>;

export interface KeyValue {
  get(key: string): Promise<string | null>;
  /** Returns false when `nx` is set and the key already exists. */
  set(key: string, value: string, opts?: { pxMs?: number; nx?: boolean }): Promise<boolean>;
  getdel(key: string): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
  pexpire(key: string, ms: number): Promise<boolean>;
  pttl(key: string): Promise<number>;
  /** Increment; sets TTL only when the key is created. */
  incr(key: string, pxMs?: number): Promise<number>;
  decr(key: string): Promise<number>;
  hset(key: string, field: string, value: string): Promise<void>;
  hget(key: string, field: string): Promise<string | null>;
  hdel(key: string, field: string): Promise<void>;
  hgetall(key: string): Promise<Record<string, string>>;
  /**
   * Atomic soft-lock acquire. Value format is `${ownerId}|${extra}`.
   * Succeeds if the key is absent or currently owned by `ownerId` (refreshes TTL and value).
   */
  acquireLock(
    key: string,
    ownerId: string,
    value: string,
    ttlMs: number,
  ): Promise<{ ok: boolean; current: string | null }>;
  close(): Promise<void>;
}

export type PubSubHandler = (data: Uint8Array | string) => void;

export interface PubSub {
  publish(channel: string, data: Uint8Array | string): Promise<void>;
  subscribe(channel: string, handler: PubSubHandler): Promise<() => Promise<void>>;
  close(): Promise<void>;
}

export interface PresignedPut {
  url: string;
  headers: Record<string, string>;
}

export interface ObjectStorage {
  readonly kind: 'local' | 's3';
  presignPut(
    key: string,
    opts: { contentType: string; contentLength: number; expiresSeconds: number },
  ): Promise<PresignedPut>;
  head(key: string): Promise<{ size: number; contentType: string | null } | null>;
  getRange(key: string, start: number, endInclusive: number): Promise<Uint8Array>;
  getObject(key: string): Promise<Uint8Array>;
  presignGet(key: string, opts: { expiresSeconds: number; contentType?: string }): Promise<string>;
  delete(key: string): Promise<void>;
}

export interface Adapters {
  mode: 'local' | 'cloud';
  db: Db;
  kv: KeyValue;
  pubsub: PubSub;
  storage: ObjectStorage;
  close(): Promise<void>;
}
