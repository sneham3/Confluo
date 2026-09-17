import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import { ySyncPluginKey } from '@tiptap/y-tiptap';
import { LOCK_HEARTBEAT_MS, LOCK_TTL_MS, type LockHolder } from '@confluo/shared';

export const softLockKey = new PluginKey<SoftLockPluginState>('confluoSoftLock');

/**
 * A lock follows *activity*, not caret position: it is released after this long without a local
 * edit or caret move, and re-acquired (optimistically) on the next one. Without this, a user who
 * merely has a document open holds its first paragraph forever and nobody else can type there.
 */
export const LOCK_IDLE_RELEASE_MS = 4_000;

export interface SoftLockPluginState {
  decorations: DecorationSet;
}

export interface LockRpc {
  acquire(blockId: string): Promise<{ granted: boolean; holder: LockHolder | null; expiresAt: number }>;
  release(blockId: string): Promise<void>;
  heartbeat(blockIds: string[]): Promise<{ renewed: string[]; lost: string[] }>;
}

export interface LockManagerOptions {
  userId: string;
  canLock: () => boolean;
  rpc: () => LockRpc | null;
  onBlocked?: (holder: LockHolder) => void;
  onChange?: () => void;
  /** Mirror our held lock into awareness for peers' rendering. */
  setAwarenessLock?: (lock: { blockId: string; expiresAt: number } | null) => void;
  now?: () => number;
}

/**
 * Client side of the soft-lock protocol (common doc §10). Tracks which blocks this user holds,
 * which are held by others, and enforces read-only-ness of foreign blocks via `filterTransaction`.
 */
export class LockManager {
  readonly held = new Set<string>();
  readonly pending = new Set<string>();
  readonly others = new Map<string, LockHolder>();
  private wanted = new Set<string>();
  private rafScheduled = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private blurTimer: ReturnType<typeof setTimeout> | null = null;
  private hiddenTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private lastActivityAt = 0;
  private view: EditorView | null = null;
  private destroyed = false;
  private readonly now: () => number;
  private readonly unloadHandler = () => this.releaseAll();
  private readonly visibilityHandler = () => {
    if (typeof document === 'undefined') return;
    if (document.visibilityState === 'hidden') {
      this.hiddenTimer = setTimeout(() => this.releaseAll(), 30_000);
    } else if (this.hiddenTimer) {
      clearTimeout(this.hiddenTimer);
      this.hiddenTimer = null;
    }
  };

  constructor(private readonly opts: LockManagerOptions) {
    this.now = opts.now ?? (() => Date.now());
    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', this.unloadHandler);
      document.addEventListener('visibilitychange', this.visibilityHandler);
    }
    this.heartbeatTimer = setInterval(() => void this.heartbeat(), LOCK_HEARTBEAT_MS);
    // Unref in Node test environments.
    (this.heartbeatTimer as { unref?: () => void }).unref?.();
  }

  attachView(view: EditorView): void {
    this.view = view;
  }

  /** The local user typed, moved the caret or focused the editor: keep (or re-take) the claim. */
  markActivity(): void {
    if (this.destroyed) return;
    this.lastActivityAt = this.now();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      this.wanted = new Set();
      void this.reconcile();
    }, LOCK_IDLE_RELEASE_MS);
    (this.idleTimer as { unref?: () => void }).unref?.();
  }

  /** True while the local user has been active recently enough to hold locks. */
  isActive(): boolean {
    return this.lastActivityAt > 0 && this.now() - this.lastActivityAt < LOCK_IDLE_RELEASE_MS;
  }

  isLockedByOther(blockId: string): boolean {
    const h = this.others.get(blockId);
    if (!h) return false;
    if (h.expiresAt && h.expiresAt < this.now()) {
      this.others.delete(blockId);
      return false;
    }
    return true;
  }

  /** Apply a `lock.changed` server event. */
  applyLockChanged(payload: { blockId: string; holder: LockHolder | null; expiresAt?: number }): void {
    const { blockId, holder } = payload;
    if (!holder) {
      this.others.delete(blockId);
      if (this.held.has(blockId) && !this.wanted.has(blockId)) this.held.delete(blockId);
    } else if (holder.userId === this.opts.userId) {
      this.others.delete(blockId);
      if (this.wanted.has(blockId)) this.held.add(blockId);
    } else {
      this.others.set(blockId, { ...holder, expiresAt: holder.expiresAt ?? payload.expiresAt ?? this.now() + LOCK_TTL_MS });
      if (this.held.has(blockId)) this.held.delete(blockId);
      this.pending.delete(blockId);
    }
    this.notify();
  }

  /** Replace the full set of foreign locks (from `lock.list`). */
  setLocks(locks: LockHolder[] & { blockId?: string }[] | Array<LockHolder & { blockId: string }>): void {
    this.others.clear();
    for (const l of locks as Array<LockHolder & { blockId: string }>) {
      if (l.userId !== this.opts.userId) this.others.set(l.blockId, l);
    }
    this.notify();
  }

  /** Called on every selection change with the ids of the top-level blocks the selection touches. */
  setSelectionBlocks(blockIds: Iterable<string>): void {
    if (this.destroyed) return;
    const next = new Set(blockIds);
    if (setsEqual(next, this.wanted)) return;
    this.wanted = next;
    if (this.blurTimer) {
      clearTimeout(this.blurTimer);
      this.blurTimer = null;
    }
    if (!this.rafScheduled) {
      this.rafScheduled = true;
      const run = () => {
        this.rafScheduled = false;
        void this.reconcile();
      };
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
      else setTimeout(run, 16);
    }
  }

  onBlur(): void {
    if (this.blurTimer) clearTimeout(this.blurTimer);
    this.blurTimer = setTimeout(() => {
      this.blurTimer = null;
      this.wanted = new Set();
      void this.reconcile();
    }, 5_000);
  }

  onFocus(): void {
    if (this.blurTimer) {
      clearTimeout(this.blurTimer);
      this.blurTimer = null;
    }
  }

  private async reconcile(): Promise<void> {
    const rpc = this.opts.rpc();
    if (!this.opts.canLock()) {
      return;
    }
    // Release exited blocks.
    for (const id of [...this.held, ...this.pending]) {
      if (!this.wanted.has(id)) {
        this.held.delete(id);
        this.pending.delete(id);
        this.notify();
        if (rpc) rpc.release(id).catch(() => undefined);
      }
    }
    // Acquire newly entered blocks.
    for (const id of this.wanted) {
      if (this.held.has(id) || this.pending.has(id) || this.isLockedByOther(id)) continue;
      this.pending.add(id);
      this.notify();
      if (!rpc) continue;
      try {
        const res = await rpc.acquire(id);
        if (!this.wanted.has(id)) {
          if (res.granted) rpc.release(id).catch(() => undefined);
          continue;
        }
        if (res.granted) {
          this.held.add(id);
          this.others.delete(id);
        } else if (res.holder && res.holder.userId !== this.opts.userId) {
          this.others.set(id, { ...res.holder, expiresAt: res.expiresAt ?? this.now() + LOCK_TTL_MS });
          this.opts.onBlocked?.(res.holder);
        }
      } catch {
        /* not connected: stay optimistic; retry on next selection change */
      } finally {
        this.pending.delete(id);
        this.notify();
      }
    }
    this.publishAwareness();
  }

  private async heartbeat(): Promise<void> {
    if (this.held.size === 0) return;
    const rpc = this.opts.rpc();
    if (!rpc) return;
    try {
      const { lost } = await rpc.heartbeat([...this.held]);
      for (const id of lost) this.held.delete(id);
      if (lost.length) {
        this.notify();
        // Try to re-acquire what we still want.
        void this.reconcile();
      }
    } catch {
      /* offline; locks expire server-side */
    }
  }

  releaseAll(): void {
    const rpc = this.opts.rpc();
    for (const id of this.held) rpc?.release(id).catch(() => undefined);
    this.held.clear();
    this.pending.clear();
    this.wanted = new Set();
    this.lastActivityAt = 0;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.publishAwareness();
    this.notify();
  }

  private publishAwareness(): void {
    const first = [...this.held][0];
    this.opts.setAwarenessLock?.(first ? { blockId: first, expiresAt: this.now() + LOCK_TTL_MS } : null);
  }

  /** Surface a blocked edit attempt to the UI (toast). */
  notifyBlocked(blockId: string): void {
    const holder = this.others.get(blockId);
    if (holder) this.opts.onBlocked?.(holder);
  }

  refreshDecorations(): void {
    const view = this.view;
    if (!view || (view as { isDestroyed?: boolean }).isDestroyed) return;
    try {
      view.dispatch(view.state.tr.setMeta(softLockKey, { refresh: true }));
    } catch {
      /* view gone */
    }
  }

  private notify(): void {
    this.refreshDecorations();
    this.opts.onChange?.();
  }

  destroy(): void {
    this.destroyed = true;
    this.releaseAll();
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.blurTimer) clearTimeout(this.blurTimer);
    if (this.hiddenTimer) clearTimeout(this.hiddenTimer);
    if (typeof window !== 'undefined') {
      window.removeEventListener('beforeunload', this.unloadHandler);
      document.removeEventListener('visibilitychange', this.visibilityHandler);
    }
    this.view = null;
  }
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

/** Ids of the top-level blocks between two absolute positions (inclusive). */
export function blocksInRange(doc: PMNode, from: number, to: number): string[] {
  const ids: string[] = [];
  const empty = from === to;
  doc.forEach((node, offset) => {
    const end = offset + node.nodeSize;
    const hit = empty ? from > offset && from < end : from < end && to > offset;
    if (hit && typeof node.attrs.blockId === 'string') ids.push(node.attrs.blockId);
  });
  return ids;
}

export function selectionBlocks(state: EditorState): string[] {
  const { from, to } = state.selection;
  return blocksInRange(state.doc, from, to);
}

/** Blocks a transaction touches, evaluated against the doc each step applied to. */
export function transactionBlocks(tr: Transaction): Set<string> {
  const touched = new Set<string>();
  tr.steps.forEach((step, i) => {
    const doc = tr.docs[i];
    if (!doc) return;
    const ranges: Array<[number, number]> = [];
    step.getMap().forEach((oldStart, oldEnd) => ranges.push([oldStart, oldEnd]));
    if (ranges.length === 0) {
      const s = step as unknown as { from?: number; to?: number; pos?: number };
      if (typeof s.from === 'number' && typeof s.to === 'number') ranges.push([s.from, s.to]);
      else if (typeof s.pos === 'number') ranges.push([s.pos, s.pos + 1]);
    }
    for (const [f, t] of ranges) for (const id of blocksInRange(doc, f, t)) touched.add(id);
  });
  return touched;
}

export function isRemoteTransaction(tr: Transaction): boolean {
  return !!tr.getMeta(ySyncPluginKey) || !!tr.getMeta('y-sync$');
}

function buildDecorations(doc: PMNode, manager: LockManager): DecorationSet {
  const decos: Decoration[] = [];
  doc.forEach((node, offset) => {
    const id = node.attrs.blockId as string | undefined;
    if (!id || !manager.isLockedByOther(id)) return;
    const holder = manager.others.get(id)!;
    decos.push(
      Decoration.node(offset, offset + node.nodeSize, {
        class: 'is-locked',
        'data-lock-name': holder.name,
        style: `--lock-color: ${holder.color}`,
      }),
    );
  });
  return DecorationSet.create(doc, decos);
}

export function softLockPlugin(manager: LockManager): Plugin<SoftLockPluginState> {
  return new Plugin<SoftLockPluginState>({
    key: softLockKey,
    state: {
      init: (_config, state) => ({ decorations: buildDecorations(state.doc, manager) }),
      apply: (tr, value, _old, newState) => {
        // Local edits and caret moves count as activity; remote updates and our own bookkeeping do not.
        if (
          (tr.docChanged || tr.selectionSet) &&
          !isRemoteTransaction(tr) &&
          !tr.getMeta(softLockKey) &&
          !tr.getMeta('confluoBlockId')
        ) {
          manager.markActivity();
        }
        if (tr.getMeta(softLockKey) || tr.docChanged) return { decorations: buildDecorations(newState.doc, manager) };
        return value;
      },
    },
    filterTransaction: (tr) => {
      if (!tr.docChanged) return true;
      if (isRemoteTransaction(tr)) return true;
      if (tr.getMeta('confluoUpload') || tr.getMeta('confluoBlockId')) return true;
      if (manager.others.size === 0) return true;
      for (const id of transactionBlocks(tr)) {
        if (manager.isLockedByOther(id)) {
          manager.notifyBlocked(id);
          return false;
        }
      }
      return true;
    },
    props: {
      decorations: (state) => softLockKey.getState(state)?.decorations ?? DecorationSet.empty,
      /**
       * Escape hatch: Enter inside a paragraph someone else holds starts a new paragraph *below*
       * it instead of splitting it. The insertion sits on the block boundary, so it touches no
       * locked block, and the user always has somewhere to write.
       */
      handleKeyDown: (view, event) => {
        if (event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return false;
        if (!view.editable) return false;
        const { state } = view;
        const { $from } = state.selection;
        if ($from.depth < 1) return false;
        const id = $from.node(1).attrs.blockId as string | undefined;
        if (typeof id !== 'string' || !manager.isLockedByOther(id)) return false;
        const paragraph = state.schema.nodes.paragraph?.createAndFill();
        if (!paragraph) return false;
        const after = $from.after(1);
        const tr = state.tr.insert(after, paragraph);
        tr.setSelection(TextSelection.create(tr.doc, after + 1)).scrollIntoView();
        view.dispatch(tr);
        return true;
      },
    },
    view: (view) => {
      manager.attachView(view);
      const dom = view.dom as HTMLElement;
      const onBlur = () => manager.onBlur();
      const onFocus = () => {
        manager.onFocus();
        if (!view.editable) return;
        manager.markActivity();
        manager.setSelectionBlocks(selectionBlocks(view.state));
      };
      dom.addEventListener('blur', onBlur);
      dom.addEventListener('focus', onFocus);
      // Never claim a lock just because the document is open: only when the user is in the editor.
      if (view.editable && view.hasFocus()) {
        manager.markActivity();
        manager.setSelectionBlocks(selectionBlocks(view.state));
      }
      return {
        update: (v, prev) => {
          if (prev.selection.eq(v.state.selection) && prev.doc.eq(v.state.doc)) return;
          if (!v.editable) return;
          // Remote edits also land here; only a focused, recently active user holds locks.
          if (!v.hasFocus() || !manager.isActive()) return;
          manager.setSelectionBlocks(selectionBlocks(v.state));
        },
        destroy: () => {
          dom.removeEventListener('blur', onBlur);
          dom.removeEventListener('focus', onFocus);
        },
      };
    },
  });
}
