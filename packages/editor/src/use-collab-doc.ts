import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { acquireCollabDoc, type CollabDocHandle } from './collab-doc';
import type { CollabDocOptions, CollabSnapshot, ServerEvent } from './types';

export interface UseCollabDocResult extends CollabSnapshot {
  handle: CollabDocHandle | null;
  uploads: CollabDocHandle['uploads'] | null;
  titleSave: CollabDocHandle['titleSave'] | null;
  comments: CollabDocHandle['comments'] | null;
  setTitle: (title: string) => void;
  rpc: <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>;
  destroy: () => void;
}

const emptySnapshot: CollabSnapshot = {
  editor: null,
  ready: false,
  connectionState: 'connecting',
  unsyncedChanges: false,
  peers: [],
  locks: new Map(),
  role: 'viewer',
  log: [],
  uploadsPending: 0,
  uploadProgress: new Map(),
  titleState: 'idle',
  title: '',
};

/**
 * React hook over `acquireCollabDoc`. The handle is acquired in an effect and released on unmount;
 * the registry is ref-counted with a short grace period so StrictMode double-mounts reuse providers.
 */
export function useCollabDoc(opts: CollabDocOptions | null): UseCollabDocResult {
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const docId = opts?.docId ?? null;
  const [handle, setHandle] = useState<CollabDocHandle | null>(null);
  const releaseRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!docId || !optsRef.current) {
      setHandle(null);
      return;
    }
    const acq = acquireCollabDoc(optsRef.current);
    releaseRef.current = acq.release;
    setHandle(acq.handle);
    return () => {
      acq.release();
      releaseRef.current = null;
    };
  }, [docId]);

  const subscribe = useMemo(() => (l: () => void) => (handle ? handle.subscribe(l) : () => undefined), [handle]);
  const getSnapshot = useMemo(() => () => (handle ? handle.getSnapshot() : emptySnapshot), [handle]);
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    if (!handle) return;
    return handle.onEvent((e: ServerEvent) => optsRef.current?.onEvent?.(e));
  }, [handle]);

  return {
    ...snap,
    handle,
    uploads: handle?.uploads ?? null,
    titleSave: handle?.titleSave ?? null,
    comments: handle?.comments ?? null,
    setTitle: (t) => handle?.setTitle(t),
    rpc: (m, p) => (handle ? handle.rpc(m, p) : Promise.reject(new Error('Not connected'))),
    destroy: () => releaseRef.current?.(),
  };
}
