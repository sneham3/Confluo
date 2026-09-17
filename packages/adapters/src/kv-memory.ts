import type { KeyValue } from './types.js';

interface Entry {
  value: string;
  expiresAt: number | null;
}

/** In-process KeyValue with TTL semantics matching the Redis subset we use. */
export class MemoryKeyValue implements KeyValue {
  private readonly strings = new Map<string, Entry>();
  private readonly hashes = new Map<string, Map<string, string>>();
  private readonly sweeper: NodeJS.Timeout;

  constructor() {
    this.sweeper = setInterval(() => this.sweep(), 1000);
    this.sweeper.unref?.();
  }

  private live(key: string): Entry | null {
    const e = this.strings.get(key);
    if (!e) return null;
    if (e.expiresAt !== null && e.expiresAt <= Date.now()) {
      this.strings.delete(key);
      return null;
    }
    return e;
  }

  private sweep() {
    const now = Date.now();
    for (const [k, e] of this.strings) if (e.expiresAt !== null && e.expiresAt <= now) this.strings.delete(k);
  }

  async get(key: string) {
    return this.live(key)?.value ?? null;
  }

  async set(key: string, value: string, opts?: { pxMs?: number; nx?: boolean }) {
    if (opts?.nx && this.live(key)) return false;
    this.strings.set(key, { value, expiresAt: opts?.pxMs ? Date.now() + opts.pxMs : null });
    return true;
  }

  async getdel(key: string) {
    const e = this.live(key);
    this.strings.delete(key);
    return e?.value ?? null;
  }

  async del(...keys: string[]) {
    let n = 0;
    for (const k of keys) {
      if (this.strings.delete(k)) n++;
      if (this.hashes.delete(k)) n++;
    }
    return n;
  }

  async pexpire(key: string, ms: number) {
    const e = this.live(key);
    if (!e) return false;
    e.expiresAt = Date.now() + ms;
    return true;
  }

  async pttl(key: string) {
    const e = this.live(key);
    if (!e) return -2;
    if (e.expiresAt === null) return -1;
    return Math.max(0, e.expiresAt - Date.now());
  }

  async incr(key: string, pxMs?: number) {
    const e = this.live(key);
    if (!e) {
      this.strings.set(key, { value: '1', expiresAt: pxMs ? Date.now() + pxMs : null });
      return 1;
    }
    const n = (parseInt(e.value, 10) || 0) + 1;
    e.value = String(n);
    return n;
  }

  async decr(key: string) {
    const e = this.live(key);
    if (!e) {
      this.strings.set(key, { value: '-1', expiresAt: null });
      return -1;
    }
    const n = (parseInt(e.value, 10) || 0) - 1;
    e.value = String(n);
    return n;
  }

  async hset(key: string, field: string, value: string) {
    let h = this.hashes.get(key);
    if (!h) {
      h = new Map();
      this.hashes.set(key, h);
    }
    h.set(field, value);
  }

  async hget(key: string, field: string) {
    return this.hashes.get(key)?.get(field) ?? null;
  }

  async hdel(key: string, field: string) {
    const h = this.hashes.get(key);
    h?.delete(field);
    if (h && h.size === 0) this.hashes.delete(key);
  }

  async hgetall(key: string) {
    const h = this.hashes.get(key);
    return h ? Object.fromEntries(h) : {};
  }

  async acquireLock(key: string, ownerId: string, value: string, ttlMs: number) {
    const e = this.live(key);
    if (!e) {
      this.strings.set(key, { value, expiresAt: Date.now() + ttlMs });
      return { ok: true, current: value };
    }
    const owner = e.value.split('|')[0];
    if (owner === ownerId) {
      e.value = value;
      e.expiresAt = Date.now() + ttlMs;
      return { ok: true, current: value };
    }
    return { ok: false, current: e.value };
  }

  async close() {
    clearInterval(this.sweeper);
  }
}
