import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { IndexeddbPersistence, clearDocument } from 'y-indexeddb';
import { Editor } from '@tiptap/core';
import {
  AWARENESS_THROTTLE_MS,
  can,
  type AwarenessState,
  type LockHolder,
  type Role,
} from '@confluo/shared';
import { TicketedWebsocketProvider } from './provider';
import { LockManager } from './soft-lock';
import { SaveController } from './save-controller';
import { UploadManager } from './upload-manager';
import { createCollabEditorExtensions } from './extensions';
import { anchorFromSelection, blockRange, resolveAnchor } from './anchors';
import type {
  CollabDocOptions,
  CollabSnapshot,
  CommentAnchor,
  ConnectionLogEntry,
  ConnectionState,
  DeniedReason,
  Peer,
  ServerEvent,
} from './types';

const IDLE_AFTER_MS = 60_000;
const MAX_LOG = 50;

export interface CollabDocHandle {
  readonly docId: string;
  readonly ydoc: Y.Doc;
  readonly awareness: Awareness;
  readonly provider: TicketedWebsocketProvider;
  readonly uploads: UploadManager;
  readonly titleSave: SaveController<string, { title: string; version: number }>;
  readonly locks: LockManager;
  get editor(): Editor | null;
  getSnapshot(): CollabSnapshot;
  subscribe(listener: () => void): () => void;
  onEvent(listener: (e: ServerEvent) => void): () => void;
  rpc<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  setTitle(title: string): void;
  comments: {
    anchorFromSelection(): CommentAnchor | null;
    resolveAnchor(a: { anchorFrom: string | null; anchorTo: string | null }): { from: number; to: number } | null;
    blockRange(blockId: string): { from: number; to: number } | null;
  };
  destroy(): void;
}

class CollabDoc implements CollabDocHandle {
  readonly docId: string;
  readonly ydoc: Y.Doc;
  readonly awareness: Awareness;
  readonly provider: TicketedWebsocketProvider;
  readonly uploads: UploadManager;
  readonly titleSave: SaveController<string, { title: string; version: number }>;
  readonly locks: LockManager;
  private _editor: Editor | null = null;
  private idb: IndexeddbPersistence | null = null;
  private role: Role;
  private ready = false;
  private connectionState: ConnectionState = 'connecting';
  private deniedReason?: DeniedReason;
  private unsynced = 0;
  private log: ConnectionLogEntry[] = [];
  private peers: Peer[] = [];
  private title: string;
  private titleState: CollabSnapshot['titleState'] = 'idle';
  private snapshot: CollabSnapshot;
  private readonly listeners = new Set<() => void>();
  private readonly eventListeners = new Set<(e: ServerEvent) => void>();
  private awarenessTimer: ReturnType<typeof setTimeout> | null = null;
  private awarenessDirty: Partial<AwarenessState> = {};
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;
  private readonly activityHandler = () => this.markActive();

  constructor(private readonly opts: CollabDocOptions) {
    this.docId = opts.docId;
    this.role = opts.role;
    this.title = opts.title?.value ?? '';
    this.ydoc = new Y.Doc({ guid: opts.docId, gc: true });
    this.awareness = new Awareness(this.ydoc);
    this.awareness.setLocalState({
      user: opts.user,
      role: opts.role,
      cursor: null,
      lock: null,
      status: 'active',
      clientTs: Date.now(),
    } satisfies AwarenessState);

    this.provider = new TicketedWebsocketProvider({
      docId: opts.docId,
      ydoc: this.ydoc,
      awareness: this.awareness,
      syncUrl: opts.syncUrl,
      getTicket: opts.getTicket,
      onStateChange: (state, denied) => {
        this.connectionState = state;
        this.deniedReason = denied;
        if (state === 'denied' && (denied === 'revoked' || denied === 'deleted')) {
          void clearDocument(`confluo-doc-${opts.docId}`).catch(() => undefined);
        }
        if (state === 'denied') this.editor?.setEditable(false);
        this.emit();
      },
      onEvent: (e) => this.handleEvent(e),
      onLog: (entry) => {
        this.log = [...this.log.slice(-(MAX_LOG - 1)), entry];
        this.emit();
      },
      onSynced: () => {
        this.unsynced = 0;
        this.emit();
      },
    });

    this.locks = new LockManager({
      userId: opts.user.id,
      canLock: () => can(this.role, 'ws.lock'),
      rpc: () =>
        this.provider.open
          ? {
              acquire: (blockId) => this.provider.rpc('lock.acquire', { blockId }),
              release: (blockId) => this.provider.rpc('lock.release', { blockId }).then(() => undefined),
              heartbeat: (blockIds) => this.provider.rpc('lock.heartbeat', { blockIds }),
            }
          : null,
      onBlocked: (holder) => opts.onBlocked?.(holder),
      onChange: () => this.emit(),
      setAwarenessLock: (lock) => this.setAwareness({ lock }),
    });

    this.uploads = new UploadManager({
      docId: opts.docId,
      api: opts.api,
      getEditor: () => this._editor,
      onChange: () => this.emit(),
      onError: (m) => this.pushLog('warn', m),
    });

    this.titleSave = new SaveController<string, { title: string; version: number }>({
      takeSnapshot: () => this.title,
      initialVersion: opts.title?.version ?? 1,
      save: async (title, { signal, version, keepalive }) => {
        const doc = await opts.api.patch<{ doc: { title: string; version: number } }>(
          `/docs/${opts.docId}`,
          { title },
          { signal, keepalive, headers: { 'If-Match': `"${version}"` } },
        );
        return { version: doc.doc.version, resource: doc.doc };
      },
      onAdopt: (current) => {
        this.title = current.title;
        opts.onTitleAdopted?.(current);
        this.emit();
      },
      onStateChange: (state) => {
        this.titleState = state;
        this.emit();
      },
    });

    this.ydoc.on('update', (_u: Uint8Array, origin: unknown) => {
      if (origin === this.provider.provider) return;
      if (!(this.provider.connected && this.provider.synced)) this.unsynced++;
      this.emit();
    });
    this.awareness.on('change', () => this.recomputePeers());

    this.snapshot = this.buildSnapshot();
    void this.boot();
  }

  get editor(): Editor | null {
    return this._editor;
  }

  private async boot(): Promise<void> {
    this.provider.connect();
    if (typeof indexedDB !== 'undefined') {
      this.idb = new IndexeddbPersistence(`confluo-doc-${this.docId}`, this.ydoc);
      try {
        await this.idb.whenSynced;
      } catch {
        this.pushLog('warn', 'Local storage unavailable; changes are kept in memory only');
      }
    }
    if (this.destroyed) return;
    this.createEditor();
    this.ready = true;
    if (typeof window !== 'undefined') {
      for (const ev of ['keydown', 'pointerdown', 'mousemove']) window.addEventListener(ev, this.activityHandler, { passive: true });
      this.markActive();
    }
    this.emit();
  }

  private createEditor(): void {
    const editable = can(this.role, 'doc.edit');
    const extensions = createCollabEditorExtensions({
      ydoc: this.ydoc,
      provider: this.provider.provider,
      user: this.opts.user,
      lockManager: this.locks,
      image: {
        resolveUrl: async (assetId, src) => {
          if (!assetId) return src && !src.startsWith('blob:') ? src : null;
          try {
            const r = await this.opts.api.get<{ url: string }>(`/assets/${assetId}?json=1`);
            return r.url;
          } catch {
            return null;
          }
        },
        getProgress: (id) => this.uploads.progressOf(id),
        isUploader: (id) => this.uploads.isUploader(id),
        retry: (id) => this.uploads.retry(id),
        subscribe: (l) => this.subscribe(l),
      },
    });
    const element = typeof document !== 'undefined' ? document.createElement('div') : null;
    this._editor = new Editor({
      element,
      extensions,
      editable,
      editorProps: { attributes: { class: 'confluo-editor', role: 'textbox', 'aria-multiline': 'true' } },
    });
    this.uploads.bindEditor(this._editor);
  }

  private handleEvent(e: ServerEvent): void {
    switch (e.type) {
      case 'lock.changed':
        this.locks.applyLockChanged(e.payload as { blockId: string; holder: LockHolder | null; expiresAt?: number });
        break;
      case 'role.changed': {
        const role = (e.payload as { role: Role }).role;
        this.role = role;
        this.editor?.setEditable(can(role, 'doc.edit'));
        if (!can(role, 'ws.lock')) this.locks.releaseAll();
        this.setAwareness({ role });
        break;
      }
      case 'kicked':
      case 'doc.deleted':
        this.editor?.setEditable(false);
        break;
      case 'doc.updated': {
        const doc = (e.payload as { doc?: { title: string; version: number } }).doc;
        if (doc && this.titleState === 'idle' && doc.version > this.titleSave.currentVersion) {
          this.title = doc.title;
          this.titleSave.markPersisted(doc.version);
          this.opts.onTitleAdopted?.(doc);
        }
        break;
      }
      default:
        break;
    }
    this.opts.onEvent?.(e);
    for (const l of this.eventListeners) l(e);
    this.emit();
  }

  private setAwareness(patch: Partial<AwarenessState>): void {
    Object.assign(this.awarenessDirty, patch);
    if (this.awarenessTimer) return;
    this.awarenessTimer = setTimeout(() => {
      this.awarenessTimer = null;
      const patchNow = { ...this.awarenessDirty, clientTs: Date.now() };
      this.awarenessDirty = {};
      for (const [k, v] of Object.entries(patchNow)) this.awareness.setLocalStateField(k, v);
    }, AWARENESS_THROTTLE_MS);
  }

  private markActive(): void {
    const local = this.awareness.getLocalState() as AwarenessState | null;
    if (local && local.status !== 'active') this.setAwareness({ status: 'active' });
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.setAwareness({ status: 'idle' }), IDLE_AFTER_MS);
  }

  private recomputePeers(): void {
    const self = this.ydoc.clientID;
    const peers: Peer[] = [];
    for (const [clientId, raw] of this.awareness.getStates()) {
      if (clientId === self) continue;
      const s = raw as Partial<AwarenessState>;
      if (!s.user) continue;
      peers.push({
        clientId,
        user: s.user,
        role: s.role ?? 'viewer',
        status: s.status ?? 'active',
        lock: s.lock ?? null,
        hasCursor: !!s.cursor,
      });
    }
    peers.sort((a, b) => a.user.name.localeCompare(b.user.name) || a.clientId - b.clientId);
    this.peers = peers;
    this.emit();
  }

  private pushLog(level: ConnectionLogEntry['level'], message: string): void {
    this.log = [...this.log.slice(-(MAX_LOG - 1)), { ts: Date.now(), level, message }];
    this.emit();
  }

  private buildSnapshot(): CollabSnapshot {
    const uploadProgress = new Map<string, number>();
    for (const [id, j] of this.uploads.jobs) uploadProgress.set(id, j.progress);
    return {
      editor: this._editor,
      ready: this.ready,
      connectionState: this.connectionState,
      deniedReason: this.deniedReason,
      unsyncedChanges: this.unsynced > 0,
      peers: this.peers,
      locks: new Map(this.locks.others),
      role: this.role,
      log: this.log,
      uploadsPending: this.uploads.pending,
      uploadProgress,
      titleState: this.titleState,
      title: this.title,
    };
  }

  getSnapshot(): CollabSnapshot {
    return this.snapshot;
  }

  private emit(): void {
    if (this.destroyed) return;
    this.snapshot = this.buildSnapshot();
    for (const l of this.listeners) l();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onEvent(listener: (e: ServerEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  rpc<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return this.provider.rpc<T>(method, params);
  }

  setTitle(title: string): void {
    this.title = title;
    this.emit();
    this.titleSave.schedule();
  }

  readonly comments = {
    anchorFromSelection: () => (this._editor ? anchorFromSelection(this._editor) : null),
    resolveAnchor: (a: { anchorFrom: string | null; anchorTo: string | null }) => (this._editor ? resolveAnchor(this._editor, a) : null),
    blockRange: (blockId: string) => (this._editor ? blockRange(this._editor, blockId) : null),
  };

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (typeof window !== 'undefined') {
      for (const ev of ['keydown', 'pointerdown', 'mousemove']) window.removeEventListener(ev, this.activityHandler);
    }
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.awarenessTimer) clearTimeout(this.awarenessTimer);
    void this.titleSave.flush({ keepalive: true });
    this.titleSave.destroy();
    this.uploads.destroy();
    this.locks.destroy();
    this._editor?.destroy();
    this._editor = null;
    this.provider.destroy();
    this.idb?.destroy();
    this.awareness.destroy();
    this.ydoc.destroy();
    this.listeners.clear();
    this.eventListeners.clear();
  }
}

// ---- Ref-counted registry (survives React StrictMode double mount) ----------------

interface RegistryEntry {
  handle: CollabDoc;
  refs: number;
  timer: ReturnType<typeof setTimeout> | null;
}
const registry = new Map<string, RegistryEntry>();

/** Create (or reuse) the collaboration handle for a document. Call the returned `release` when done. */
export function acquireCollabDoc(opts: CollabDocOptions): { handle: CollabDocHandle; release: () => void } {
  let entry = registry.get(opts.docId);
  if (!entry) {
    entry = { handle: new CollabDoc(opts), refs: 0, timer: null };
    registry.set(opts.docId, entry);
  }
  if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }
  entry.refs++;
  const e = entry;
  let released = false;
  return {
    handle: e.handle,
    release: () => {
      if (released) return;
      released = true;
      e.refs--;
      if (e.refs <= 0) {
        e.timer = setTimeout(() => {
          if (e.refs <= 0) {
            registry.delete(opts.docId);
            e.handle.destroy();
          }
        }, 100);
      }
    },
  };
}

/** Framework-free factory (one owner; destroy() when done). */
export function createCollabDoc(opts: CollabDocOptions): CollabDocHandle {
  return new CollabDoc(opts);
}
