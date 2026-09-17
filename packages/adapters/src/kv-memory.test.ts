import { describe, expect, it } from 'vitest';
import { MemoryKeyValue } from './kv-memory.js';

describe('MemoryKeyValue', () => {
  it('set nx and getdel', async () => {
    const kv = new MemoryKeyValue();
    expect(await kv.set('a', '1', { nx: true })).toBe(true);
    expect(await kv.set('a', '2', { nx: true })).toBe(false);
    expect(await kv.getdel('a')).toBe('1');
    expect(await kv.get('a')).toBeNull();
    await kv.close();
  });

  it('expires keys', async () => {
    const kv = new MemoryKeyValue();
    await kv.set('t', 'x', { pxMs: 5 });
    await new Promise((r) => setTimeout(r, 15));
    expect(await kv.get('t')).toBeNull();
    await kv.close();
  });

  it('acquireLock semantics', async () => {
    const kv = new MemoryKeyValue();
    const a = await kv.acquireLock('lock:d:b', 'u1', 'u1|c1', 1000);
    expect(a.ok).toBe(true);
    const b = await kv.acquireLock('lock:d:b', 'u2', 'u2|c2', 1000);
    expect(b.ok).toBe(false);
    expect(b.current).toBe('u1|c1');
    const c = await kv.acquireLock('lock:d:b', 'u1', 'u1|c9', 1000);
    expect(c.ok).toBe(true);
    expect(await kv.get('lock:d:b')).toBe('u1|c9');
    await kv.close();
  });
});
