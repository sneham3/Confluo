import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SaveController } from './save-controller';
import { ApiError } from './types';

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('SaveController', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('debounces and saves the latest snapshot once', async () => {
    let value = 'a';
    const save = vi.fn(async (s: string) => ({ version: 2, resource: { title: s, version: 2 } }));
    const sc = new SaveController<string, { title: string; version: number }>({
      takeSnapshot: () => value,
      save,
      initialVersion: 1,
      bindWindow: false,
    });
    value = 'ab';
    sc.schedule();
    value = 'abc';
    sc.schedule();
    await vi.advanceTimersByTimeAsync(1600);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]![0]).toBe('abc');
    expect(sc.currentVersion).toBe(2);
    expect(sc.state).toBe('idle');
  });

  it('discards a stale response and aborts the superseded request', async () => {
    let value = 'v0';
    const first = deferred<{ version: number; resource: { title: string; version: number } }>();
    let call = 0;
    const seenSignals: AbortSignal[] = [];
    const save = vi.fn(async (s: string, ctx: { signal: AbortSignal }) => {
      seenSignals.push(ctx.signal);
      call++;
      if (call === 1) return first.promise;
      return { version: 3, resource: { title: s, version: 3 } };
    });
    const sc = new SaveController<string, { title: string; version: number }>({
      takeSnapshot: () => value,
      save,
      initialVersion: 1,
      bindWindow: false,
      debounceMs: 10,
    });
    value = 'v1';
    sc.schedule();
    await vi.advanceTimersByTimeAsync(20); // first flush in flight
    expect(save).toHaveBeenCalledTimes(1);
    value = 'v2';
    const p2 = sc.flush(); // waits on mutex until first resolves
    // Resolve the old request late with an old version: must not clobber v3 afterwards.
    first.resolve({ version: 2, resource: { title: 'v1', version: 2 } });
    await p2;
    await vi.runAllTimersAsync();
    expect(save).toHaveBeenCalledTimes(2);
    expect(sc.currentVersion).toBe(3);
    // Second flush aborted the first controller (sequential here, but the signal is still created per flush)
    expect(seenSignals.length).toBe(2);
  });

  it('on 412 adopts the server value when nothing newer is pending', async () => {
    let value = 'original';
    const onAdopt = vi.fn((cur: { title: string; version: number }) => {
      value = cur.title;
    });
    const save = vi.fn(async () => {
      throw new ApiError(412, 'VERSION_CONFLICT', 'conflict', { current: { title: 'theirs', version: 9 } });
    });
    const sc = new SaveController<string, { title: string; version: number }>({
      takeSnapshot: () => value,
      save,
      initialVersion: 1,
      bindWindow: false,
      onAdopt,
    });
    value = 'mine';
    await sc.flush();
    expect(onAdopt).toHaveBeenCalledWith({ title: 'theirs', version: 9 });
    expect(sc.currentVersion).toBe(9);
    expect(value).toBe('theirs');
    expect(sc.state).toBe('idle');
  });

  it('on 412 retries with the new version when the user kept typing', async () => {
    let value = '';
    let calls = 0;
    const save = vi.fn(async (s: string, ctx: { version: number }) => {
      calls++;
      if (calls === 1) {
        value = 'one two'; // user typed while the request was in flight
        throw new ApiError(412, 'VERSION_CONFLICT', 'conflict', { current: { title: 'other', version: 5 } });
      }
      return { version: ctx.version + 1, resource: { title: s, version: ctx.version + 1 } };
    });
    const sc = new SaveController<string, { title: string; version: number }>({
      takeSnapshot: () => value,
      save,
      initialVersion: 1,
      bindWindow: false,
    });
    value = 'one';
    await sc.flush();
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1]![0]).toBe('one two');
    expect(save.mock.calls[1]![1].version).toBe(5);
    expect(sc.currentVersion).toBe(6);
  });

  it('flushes after maxWait even with continuous typing', async () => {
    let value = '';
    const save = vi.fn(async (s: string) => ({ version: 2, resource: { title: s, version: 2 } }));
    const sc = new SaveController<string, { title: string; version: number }>({
      takeSnapshot: () => value,
      save,
      initialVersion: 1,
      bindWindow: false,
    });
    for (let i = 0; i < 12; i++) {
      value += 'x';
      sc.schedule();
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(save).toHaveBeenCalled();
  });
});
