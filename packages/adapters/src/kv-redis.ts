import { Redis } from 'ioredis';
import type { KeyValue } from './types.js';

const ACQUIRE_LUA = `
local cur = redis.call('GET', KEYS[1])
if not cur then
  redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3])
  return {1, ARGV[2]}
end
local owner = string.match(cur, '^(.-)|')
if owner == ARGV[1] then
  redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3])
  return {1, ARGV[2]}
end
return {0, cur}
`;

export class RedisKeyValue implements KeyValue {
  private readonly redis: Redis;

  constructor(url: string) {
    this.redis = new Redis(url, { lazyConnect: false, maxRetriesPerRequest: 3 });
    this.redis.defineCommand('confluoAcquireLock', { numberOfKeys: 1, lua: ACQUIRE_LUA });
  }

  get(key: string) {
    return this.redis.get(key);
  }

  async set(key: string, value: string, opts?: { pxMs?: number; nx?: boolean }) {
    const args: (string | number)[] = [];
    if (opts?.pxMs) args.push('PX', opts.pxMs);
    if (opts?.nx) args.push('NX');
    // ioredis typing for variadic args is awkward; cast through unknown.
    const res = await (this.redis.set as unknown as (...a: unknown[]) => Promise<string | null>)(
      key,
      value,
      ...args,
    );
    return res === 'OK';
  }

  getdel(key: string) {
    return this.redis.getdel(key);
  }

  del(...keys: string[]) {
    return keys.length ? this.redis.del(...keys) : Promise.resolve(0);
  }

  async pexpire(key: string, ms: number) {
    return (await this.redis.pexpire(key, ms)) === 1;
  }

  pttl(key: string) {
    return this.redis.pttl(key);
  }

  async incr(key: string, pxMs?: number) {
    const n = await this.redis.incr(key);
    if (n === 1 && pxMs) await this.redis.pexpire(key, pxMs);
    return n;
  }

  decr(key: string) {
    return this.redis.decr(key);
  }

  async hset(key: string, field: string, value: string) {
    await this.redis.hset(key, field, value);
  }

  hget(key: string, field: string) {
    return this.redis.hget(key, field);
  }

  async hdel(key: string, field: string) {
    await this.redis.hdel(key, field);
  }

  hgetall(key: string) {
    return this.redis.hgetall(key);
  }

  async acquireLock(key: string, ownerId: string, value: string, ttlMs: number) {
    const r = (this.redis as unknown as {
      confluoAcquireLock: (k: string, o: string, v: string, t: number) => Promise<[number, string]>;
    }).confluoAcquireLock;
    const [ok, current] = await r.call(this.redis, key, ownerId, value, ttlMs);
    return { ok: ok === 1, current };
  }

  async close() {
    await this.redis.quit();
  }
}
