import { describe, expect, it } from 'vitest';
import { MemoryKeyValue } from '@confluo/adapters';
import { LockService, type LockChanged } from './lock-service.js';
import type { Connection } from '../ws/connection.js';
import type { Room } from '../sync/room.js';

function fakeRoom(): Room {
  const connections = new Set<Connection>();
  return {
    docId: 'doc1',
    connections,
    connectionsOf(userId: string) {
      return [...connections].filter((c) => c.userId === userId);
    },
  } as unknown as Room;
}

function fakeConn(room: Room, userId: string, clientId: string): Connection {
  const c = {
    userId,
    docId: room.docId,
    clientId,
    name: userId,
    color: '#000',
    role: 'editor',
    locks: new Set<string>(),
    closed: false,
    room,
  } as unknown as Connection;
  room.connections.add(c);
  return c;
}

describe('LockService', () => {
  it('grants one holder and refuses a second user', async () => {
    const kv = new MemoryKeyValue();
    const events: LockChanged[] = [];
    const svc = new LockService(kv, async (_d, ch) => void events.push(ch));
    const room = fakeRoom();
    const a = fakeConn(room, 'u1', 'c1');
    const b = fakeConn(room, 'u2', 'c2');
    const g1 = await svc.acquire(a, 'blk');
    expect(g1.granted).toBe(true);
    expect(a.locks.has('blk')).toBe(true);
    const g2 = await svc.acquire(b, 'blk');
    expect(g2.granted).toBe(false);
    expect(g2.holder.userId).toBe('u1');
    expect(g2.holder.name).toBe('u1');
    expect(events).toHaveLength(1);
    expect(events[0]?.holder?.userId).toBe('u1');
    await kv.close();
  });

  it('same user second tab refreshes and takes over bookkeeping', async () => {
    const kv = new MemoryKeyValue();
    const svc = new LockService(kv, async () => undefined);
    const room = fakeRoom();
    const a1 = fakeConn(room, 'u1', 'c1');
    const a2 = fakeConn(room, 'u1', 'c2');
    await svc.acquire(a1, 'blk');
    const g = await svc.acquire(a2, 'blk');
    expect(g.granted).toBe(true);
    expect(g.holder.clientId).toBe('c2');
    expect(a1.locks.has('blk')).toBe(false);
    expect(a2.locks.has('blk')).toBe(true);
    await kv.close();
  });

  it('heartbeat renews own locks and reports lost ones', async () => {
    const kv = new MemoryKeyValue();
    const svc = new LockService(kv, async () => undefined);
    const room = fakeRoom();
    const a = fakeConn(room, 'u1', 'c1');
    await svc.acquire(a, 'blk');
    const r1 = await svc.heartbeat(a, ['blk', 'other']);
    expect(r1.renewed).toEqual(['blk']);
    expect(r1.lost).toEqual(['other']);
    await kv.del('lock:doc1:blk'); // simulate expiry
    const r2 = await svc.heartbeat(a, ['blk']);
    expect(r2.lost).toEqual(['blk']);
    expect(a.locks.has('blk')).toBe(false);
    await kv.close();
  });

  it('release only by holder; releaseAll hands over to another tab', async () => {
    const kv = new MemoryKeyValue();
    const events: LockChanged[] = [];
    const svc = new LockService(kv, async (_d, ch) => void events.push(ch));
    const room = fakeRoom();
    const a = fakeConn(room, 'u1', 'c1');
    const b = fakeConn(room, 'u2', 'c2');
    await svc.acquire(a, 'blk');
    expect(await svc.release(b, 'blk')).toBe(false);
    expect(await kv.get('lock:doc1:blk')).toBe('u1|c1');

    const a2 = fakeConn(room, 'u1', 'c9');
    await svc.releaseAll(room, a);
    expect(await kv.get('lock:doc1:blk')).toBe('u1|c9');
    expect(a2.locks.has('blk')).toBe(true);

    room.connections.delete(a);
    await svc.releaseAll(room, a2);
    expect(await kv.get('lock:doc1:blk')).toBeNull();
    expect((await svc.list('doc1')).length).toBe(0);
    expect(events.at(-1)?.holder).toBeNull();
    await kv.close();
  });

  it('sweep drops hash entries whose lease is gone', async () => {
    const kv = new MemoryKeyValue();
    const events: LockChanged[] = [];
    const svc = new LockService(kv, async (_d, ch) => void events.push(ch));
    const room = fakeRoom();
    const a = fakeConn(room, 'u1', 'c1');
    await svc.acquire(a, 'blk');
    await kv.del('lock:doc1:blk');
    await svc.sweep(room);
    expect(await svc.list('doc1')).toEqual([]);
    expect(a.locks.has('blk')).toBe(false);
    expect(events.at(-1)).toMatchObject({ blockId: 'blk', holder: null });
    await kv.close();
  });
});
