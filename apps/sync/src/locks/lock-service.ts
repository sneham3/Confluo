import type { KeyValue } from '@confluo/adapters';
import { LOCK_TTL_MS, type LockHolder } from '@confluo/shared';
import type { Connection } from '../ws/connection.js';
import type { Room } from '../sync/room.js';

export interface LockChanged {
  blockId: string;
  holder: LockHolder | null;
  expiresAt: number | null;
}

export type PublishLockChanged = (docId: string, change: LockChanged) => Promise<void>;

const lockKey = (docId: string, blockId: string) => `lock:${docId}:${blockId}`;
const hashKey = (docId: string) => `locks:${docId}`;

function parseCurrent(cur: string | null): { userId: string; clientId: string } | null {
  if (!cur) return null;
  const i = cur.indexOf('|');
  if (i < 0) return { userId: cur, clientId: '' };
  return { userId: cur.slice(0, i), clientId: cur.slice(i + 1) };
}

/** Server-arbitrated soft locks (common doc §10). Same-user tabs share a lock (keyed by userId). */
export class LockService {
  constructor(
    private readonly kv: KeyValue,
    private readonly publish: PublishLockChanged,
  ) {}

  async acquire(
    conn: Connection,
    blockId: string,
  ): Promise<{ granted: boolean; holder: LockHolder; expiresAt: number }> {
    const key = lockKey(conn.docId, blockId);
    const value = `${conn.userId}|${conn.clientId}`;
    const res = await this.kv.acquireLock(key, conn.userId, value, LOCK_TTL_MS);
    if (res.ok) {
      const holder: LockHolder = {
        userId: conn.userId,
        clientId: conn.clientId,
        name: conn.name,
        color: conn.color,
        expiresAt: Date.now() + LOCK_TTL_MS,
      };
      await this.kv.hset(hashKey(conn.docId), blockId, JSON.stringify(holder));
      // Move bookkeeping to this connection (same user may have held it from another tab).
      for (const other of conn.room.connectionsOf(conn.userId)) other.locks.delete(blockId);
      conn.locks.add(blockId);
      await this.publish(conn.docId, { blockId, holder, expiresAt: holder.expiresAt });
      return { granted: true, holder, expiresAt: holder.expiresAt };
    }
    const cur = parseCurrent(res.current);
    const holder = await this.holderInfo(conn.docId, blockId, cur);
    return { granted: false, holder, expiresAt: holder.expiresAt };
  }

  private async holderInfo(
    docId: string,
    blockId: string,
    cur: { userId: string; clientId: string } | null,
  ): Promise<LockHolder> {
    const raw = await this.kv.hget(hashKey(docId), blockId);
    if (raw) {
      try {
        const h = JSON.parse(raw) as LockHolder;
        if (!cur || h.userId === cur.userId) return h;
      } catch {
        /* fallthrough */
      }
    }
    const ttl = await this.kv.pttl(lockKey(docId, blockId));
    return {
      userId: cur?.userId ?? 'unknown',
      clientId: cur?.clientId ?? '',
      name: '',
      color: '#888888',
      expiresAt: Date.now() + Math.max(0, ttl),
    };
  }

  async heartbeat(conn: Connection, blockIds: string[]): Promise<{ renewed: string[]; lost: string[] }> {
    const renewed: string[] = [];
    const lost: string[] = [];
    for (const blockId of blockIds) {
      const cur = parseCurrent(await this.kv.get(lockKey(conn.docId, blockId)));
      if (cur && cur.userId === conn.userId) {
        await this.kv.pexpire(lockKey(conn.docId, blockId), LOCK_TTL_MS);
        const raw = await this.kv.hget(hashKey(conn.docId), blockId);
        if (raw) {
          try {
            const h = JSON.parse(raw) as LockHolder;
            h.expiresAt = Date.now() + LOCK_TTL_MS;
            await this.kv.hset(hashKey(conn.docId), blockId, JSON.stringify(h));
          } catch {
            /* ignore */
          }
        }
        renewed.push(blockId);
      } else {
        conn.locks.delete(blockId);
        lost.push(blockId);
      }
    }
    return { renewed, lost };
  }

  async release(conn: Connection, blockId: string): Promise<boolean> {
    const key = lockKey(conn.docId, blockId);
    const cur = parseCurrent(await this.kv.get(key));
    conn.locks.delete(blockId);
    if (!cur || cur.userId !== conn.userId) return false;
    await this.kv.del(key);
    await this.kv.hdel(hashKey(conn.docId), blockId);
    await this.publish(conn.docId, { blockId, holder: null, expiresAt: null });
    return true;
  }

  /**
   * On disconnect / role downgrade. If the same user still has another live connection in this
   * room, locks are handed over to it instead of being released.
   */
  async releaseAll(room: Room, conn: Connection, opts?: { handover?: boolean }): Promise<void> {
    const held = [...conn.locks];
    conn.locks.clear();
    if (held.length === 0) return;
    const handover = opts?.handover !== false;
    const other = handover
      ? room.connectionsOf(conn.userId).find((c) => c !== conn && !c.closed)
      : undefined;
    for (const blockId of held) {
      const key = lockKey(conn.docId, blockId);
      const cur = parseCurrent(await this.kv.get(key));
      if (!cur || cur.userId !== conn.userId) continue;
      if (other) {
        const value = `${conn.userId}|${other.clientId}`;
        const res = await this.kv.acquireLock(key, conn.userId, value, LOCK_TTL_MS);
        if (res.ok) {
          const holder: LockHolder = {
            userId: conn.userId,
            clientId: other.clientId,
            name: other.name,
            color: other.color,
            expiresAt: Date.now() + LOCK_TTL_MS,
          };
          await this.kv.hset(hashKey(conn.docId), blockId, JSON.stringify(holder));
          other.locks.add(blockId);
          await this.publish(conn.docId, { blockId, holder, expiresAt: holder.expiresAt });
          continue;
        }
      }
      await this.kv.del(key);
      await this.kv.hdel(hashKey(conn.docId), blockId);
      await this.publish(conn.docId, { blockId, holder: null, expiresAt: null });
    }
  }

  async list(docId: string): Promise<Array<LockHolder & { blockId: string }>> {
    const all = await this.kv.hgetall(hashKey(docId));
    const out: Array<LockHolder & { blockId: string }> = [];
    for (const [blockId, raw] of Object.entries(all)) {
      try {
        out.push({ blockId, ...(JSON.parse(raw) as LockHolder) });
      } catch {
        /* skip corrupt */
      }
    }
    return out;
  }

  /** Remove hash entries whose lease key expired; publish releases. */
  async sweep(room: Room): Promise<void> {
    const all = await this.kv.hgetall(hashKey(room.docId));
    for (const blockId of Object.keys(all)) {
      const cur = await this.kv.get(lockKey(room.docId, blockId));
      if (cur) continue;
      await this.kv.hdel(hashKey(room.docId), blockId);
      for (const c of room.connections) c.locks.delete(blockId);
      await this.publish(room.docId, { blockId, holder: null, expiresAt: null });
    }
  }
}
