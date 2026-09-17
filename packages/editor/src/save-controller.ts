import { Mutex } from 'async-mutex';
import { isApiError } from './types';

export type SaveState = 'idle' | 'pending' | 'saving' | 'error';

export interface SaveControllerOptions<TSnapshot, TResource> {
  /** Synchronous, immutable snapshot of what should be persisted (never the live DOM). */
  takeSnapshot: () => TSnapshot;
  /** Perform the HTTP save. Must throw `ApiError` (status 412 with `details.current`) on conflicts. */
  save: (
    snapshot: TSnapshot,
    ctx: { signal: AbortSignal; version: number; keepalive?: boolean },
  ) => Promise<{ version: number; resource: TResource }>;
  initialVersion: number;
  /** Called when a conflict was resolved by adopting the server's copy. */
  onAdopt?: (current: TResource & { version: number }) => void;
  onSaved?: (resource: TResource) => void;
  onStateChange?: (state: SaveState, error?: Error) => void;
  isEqual?: (a: TSnapshot, b: TSnapshot) => boolean;
  debounceMs?: number;
  maxWaitMs?: number;
  /** Attach blur / visibilitychange / beforeunload listeners (browser only). Default true. */
  bindWindow?: boolean;
}

function defaultEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/**
 * Snapshot-based, debounced, mutex-guarded, abortable, sequence-checked saver (common doc §12.2).
 */
export class SaveController<TSnapshot, TResource = unknown> {
  state: SaveState = 'idle';
  lastError?: Error;
  currentVersion: number;
  private readonly mutex = new Mutex();
  private lastScheduledSeq = 0;
  private lastAppliedSeq = 0;
  private lastPersisted: TSnapshot | undefined;
  private inflight: AbortController | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private maxWaitTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly debounceMs: number;
  private readonly maxWaitMs: number;
  private destroyed = false;
  private readonly eq: (a: TSnapshot, b: TSnapshot) => boolean;
  private readonly blurHandler = () => void this.flush();
  private readonly visibilityHandler = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') void this.flush({ keepalive: true });
  };
  private readonly unloadHandler = () => void this.flush({ keepalive: true });

  constructor(private readonly opts: SaveControllerOptions<TSnapshot, TResource>) {
    this.currentVersion = opts.initialVersion;
    this.debounceMs = opts.debounceMs ?? 1500;
    this.maxWaitMs = opts.maxWaitMs ?? 10_000;
    this.eq = opts.isEqual ?? defaultEqual;
    this.lastPersisted = opts.takeSnapshot();
    if ((opts.bindWindow ?? true) && typeof window !== 'undefined') {
      window.addEventListener('blur', this.blurHandler);
      document.addEventListener('visibilitychange', this.visibilityHandler);
      window.addEventListener('beforeunload', this.unloadHandler);
    }
  }

  /** Mark the current snapshot as already persisted (e.g. after adopting a server value). */
  markPersisted(version?: number): void {
    this.lastPersisted = this.opts.takeSnapshot();
    if (version !== undefined) this.currentVersion = version;
    this.clearTimers();
    this.setState('idle');
  }

  get hasPendingChanges(): boolean {
    return this.state === 'pending' || this.state === 'saving' || !this.eq(this.opts.takeSnapshot(), this.lastPersisted as TSnapshot);
  }

  schedule(): void {
    if (this.destroyed) return;
    this.setState('pending');
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.flush();
    }, this.debounceMs);
    if (!this.maxWaitTimer) {
      this.maxWaitTimer = setTimeout(() => {
        this.maxWaitTimer = null;
        void this.flush();
      }, this.maxWaitMs);
    }
  }

  async flush(opts: { keepalive?: boolean } = {}): Promise<void> {
    if (this.destroyed) return;
    this.clearTimers();
    const release = await this.mutex.acquire();
    try {
      const seq = ++this.lastScheduledSeq;
      const snapshot = this.opts.takeSnapshot();
      if (this.eq(snapshot, this.lastPersisted as TSnapshot)) {
        if (this.state !== 'error') this.setState('idle');
        return;
      }
      this.inflight?.abort();
      const ctrl = new AbortController();
      this.inflight = ctrl;
      this.setState('saving');
      let res: { version: number; resource: TResource };
      try {
        res = await this.opts.save(snapshot, { signal: ctrl.signal, version: this.currentVersion, keepalive: opts.keepalive });
      } catch (e) {
        if ((e as Error)?.name === 'AbortError' || ctrl.signal.aborted) return; // superseded
        if (isApiError(e) && e.status === 412) {
          const current = (e.details as { current?: TResource & { version: number } } | undefined)?.current;
          if (current && typeof current.version === 'number') this.currentVersion = current.version;
          const newerLocal = !this.eq(this.opts.takeSnapshot(), snapshot);
          if (newerLocal) {
            // User kept editing: retry with the fresh version.
            release();
            return this.flush(opts);
          }
          if (current) this.opts.onAdopt?.(current);
          this.lastPersisted = this.opts.takeSnapshot();
          this.setState('idle');
          return;
        }
        this.lastError = e as Error;
        this.setState('error', e as Error);
        return;
      } finally {
        if (this.inflight === ctrl) this.inflight = null;
      }
      if (seq < this.lastAppliedSeq) return; // stale response: discard
      this.lastAppliedSeq = seq;
      this.currentVersion = res.version;
      this.lastPersisted = snapshot;
      this.opts.onSaved?.(res.resource);
      this.setState(this.eq(this.opts.takeSnapshot(), snapshot) ? 'idle' : 'pending');
    } finally {
      release();
    }
  }

  private clearTimers(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.maxWaitTimer) clearTimeout(this.maxWaitTimer);
    this.debounceTimer = null;
    this.maxWaitTimer = null;
  }

  private setState(state: SaveState, error?: Error): void {
    this.state = state;
    if (state !== 'error') this.lastError = undefined;
    this.opts.onStateChange?.(state, error);
  }

  destroy(): void {
    this.destroyed = true;
    this.clearTimers();
    this.inflight?.abort();
    if (typeof window !== 'undefined') {
      window.removeEventListener('blur', this.blurHandler);
      document.removeEventListener('visibilitychange', this.visibilityHandler);
      window.removeEventListener('beforeunload', this.unloadHandler);
    }
  }
}
