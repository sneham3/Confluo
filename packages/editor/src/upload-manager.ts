import type { Editor } from '@tiptap/core';
import { newUploadId, type PresignResponse } from '@confluo/shared';
import type { ApiClient } from './types';

export interface UploadManagerOptions {
  docId: string;
  api: ApiClient;
  getEditor: () => Editor | null;
  maxConcurrent?: number;
  onChange?: () => void;
  onError?: (message: string) => void;
  /** Test hook: custom PUT implementation. */
  put?: (url: string, headers: Record<string, string>, file: Blob, signal: AbortSignal, onProgress: (p: number) => void) => Promise<void>;
}

interface Job {
  uploadId: string;
  file: File;
  objectUrl: string;
  assetId: string | null;
  ctrl: AbortController;
  status: 'queued' | 'uploading' | 'done' | 'failed' | 'aborted';
  progress: number;
}

const ALLOWED = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const MAX_BYTES = 10 * 1024 * 1024;

/**
 * Background image uploads that never block typing (common doc §12.3).
 * Placeholder nodes are located by their `uploadId` attribute, never by DOM reference or position.
 */
export class UploadManager {
  readonly jobs = new Map<string, Job>();
  private running = 0;
  private readonly maxConcurrent: number;
  private destroyed = false;
  private readonly updateHandler = () => this.checkDeletedNodes();

  constructor(private readonly opts: UploadManagerOptions) {
    this.maxConcurrent = opts.maxConcurrent ?? 3;
  }

  /** Call once the editor exists so deleted placeholders abort their uploads. */
  bindEditor(editor: Editor): void {
    editor.on('update', this.updateHandler);
  }

  get pending(): number {
    let n = 0;
    for (const j of this.jobs.values()) if (j.status === 'queued' || j.status === 'uploading') n++;
    return n;
  }

  hasPending(): boolean {
    return this.pending > 0;
  }

  progressOf(uploadId: string): number | null {
    return this.jobs.get(uploadId)?.progress ?? null;
  }

  isUploader(uploadId: string): boolean {
    return this.jobs.has(uploadId);
  }

  /** Insert a placeholder and start uploading. Returns the uploadId or null if rejected. */
  enqueue(file: File, at?: number): string | null {
    const editor = this.opts.getEditor();
    if (!editor || this.destroyed) return null;
    if (!ALLOWED.has(file.type)) {
      this.opts.onError?.('Only PNG, JPEG, WebP and GIF images are supported');
      return null;
    }
    if (file.size > MAX_BYTES) {
      this.opts.onError?.('Images must be 10 MB or smaller');
      return null;
    }
    const uploadId = newUploadId();
    const objectUrl = URL.createObjectURL(file);
    const attrs = { src: objectUrl, alt: file.name, uploadId, assetId: null, status: 'uploading' as const, width: null };
    // Commands return true even when the soft-lock filter drops the transaction, so verify by
    // looking the placeholder up afterwards.
    if (typeof at === 'number') {
      editor.chain().insertContentAt(at, { type: 'image', attrs }).run();
    } else {
      editor.chain().focus().insertContent({ type: 'image', attrs }).run();
    }
    let inserted = this.nodeExists(uploadId, false);
    if (!inserted) {
      // Selection sits in a block locked by someone else: insert after the current block instead.
      const $from = editor.state.selection.$from;
      const after = $from.depth >= 1 ? $from.after(1) : editor.state.doc.content.size;
      editor.chain().insertContentAt(after, { type: 'image', attrs }).run();
      inserted = this.nodeExists(uploadId, false);
    }
    if (!inserted) {
      URL.revokeObjectURL(objectUrl);
      this.opts.onError?.('Could not insert the image here');
      return null;
    }
    const job: Job = { uploadId, file, objectUrl, assetId: null, ctrl: new AbortController(), status: 'queued', progress: 0 };
    this.jobs.set(uploadId, job);
    this.opts.onChange?.();
    this.pump();
    return uploadId;
  }

  retry(uploadId: string): void {
    const job = this.jobs.get(uploadId);
    if (!job || job.status !== 'failed') return;
    job.ctrl = new AbortController();
    job.status = 'queued';
    job.progress = 0;
    this.setNodeAttrs(uploadId, { status: 'uploading' });
    this.opts.onChange?.();
    this.pump();
  }

  private pump(): void {
    if (this.destroyed) return;
    for (const job of this.jobs.values()) {
      if (this.running >= this.maxConcurrent) break;
      if (job.status !== 'queued') continue;
      job.status = 'uploading';
      this.running++;
      void this.run(job).finally(() => {
        this.running--;
        this.pump();
      });
    }
  }

  private async run(job: Job): Promise<void> {
    const { api, docId } = this.opts;
    try {
      const presign = await api.post<PresignResponse>(
        `/docs/${docId}/assets/presign`,
        { mime: job.file.type, byteSize: job.file.size, filename: job.file.name },
        { signal: job.ctrl.signal },
      );
      job.assetId = presign.assetId;
      await (this.opts.put ?? xhrPut)(presign.uploadUrl, presign.headers, job.file, job.ctrl.signal, (p) => {
        job.progress = p;
        this.opts.onChange?.();
      });
      const done = await api.post<{ asset: { id: string; url: string; width: number | null; height: number | null } }>(
        `/docs/${docId}/assets/${presign.assetId}/complete`,
        undefined,
        { signal: job.ctrl.signal },
      );
      job.status = 'done';
      job.progress = 1;
      const replaced = this.setNodeAttrs(job.uploadId, {
        src: done.asset.url,
        assetId: done.asset.id,
        status: 'ready',
        width: done.asset.width,
      });
      if (!replaced) {
        // Node was deleted meanwhile: clean up the orphan.
        api.delete(`/assets/${done.asset.id}`).catch(() => undefined);
      }
      setTimeout(() => URL.revokeObjectURL(job.objectUrl), 5_000);
    } catch (e) {
      if (job.ctrl.signal.aborted || job.status === 'aborted') {
        job.status = 'aborted';
        if (job.assetId) api.delete(`/assets/${job.assetId}`).catch(() => undefined);
        return;
      }
      job.status = 'failed';
      this.setNodeAttrs(job.uploadId, { status: 'failed' });
      this.opts.onError?.(`Upload failed: ${(e as Error).message}`);
    } finally {
      this.opts.onChange?.();
    }
  }

  /** Locate the placeholder by uploadId and patch its attrs. Returns false if the node is gone. */
  setNodeAttrs(uploadId: string, attrs: Record<string, unknown>): boolean {
    const editor = this.opts.getEditor();
    if (!editor || editor.isDestroyed) return false;
    let pos: number | null = null;
    let found: import('@tiptap/pm/model').Node | null = null;
    editor.state.doc.descendants((node, p) => {
      if (pos !== null) return false;
      if (node.type.name === 'image' && node.attrs.uploadId === uploadId) {
        pos = p;
        found = node;
        return false;
      }
      return true;
    });
    if (pos === null || !found) return false;
    const node = found as import('@tiptap/pm/model').Node;
    const tr = editor.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...attrs }, node.marks);
    tr.setMeta('confluoUpload', true);
    tr.setMeta('addToHistory', false);
    editor.view.dispatch(tr);
    return true;
  }

  private nodeExists(uploadId: string, unknownResult = true): boolean {
    const editor = this.opts.getEditor();
    if (!editor || editor.isDestroyed) return unknownResult; // unknown: don't abort
    let exists = false;
    editor.state.doc.descendants((node) => {
      if (exists) return false;
      if (node.type.name === 'image' && node.attrs.uploadId === uploadId) exists = true;
      return !exists;
    });
    return exists;
  }

  private checkDeletedNodes(): void {
    for (const job of this.jobs.values()) {
      if ((job.status === 'queued' || job.status === 'uploading') && !this.nodeExists(job.uploadId)) {
        job.status = 'aborted';
        job.ctrl.abort();
        if (job.assetId) this.opts.api.delete(`/assets/${job.assetId}`).catch(() => undefined);
        this.opts.onChange?.();
      }
    }
  }

  abortAll(): void {
    for (const job of this.jobs.values()) {
      if (job.status === 'queued' || job.status === 'uploading') {
        job.status = 'aborted';
        job.ctrl.abort();
      }
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.abortAll();
    const editor = this.opts.getEditor();
    editor?.off('update', this.updateHandler);
    for (const job of this.jobs.values()) URL.revokeObjectURL(job.objectUrl);
  }
}

function xhrPut(
  url: string,
  headers: Record<string, string>,
  file: Blob,
  signal: AbortSignal,
  onProgress: (p: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url, true);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`Upload failed (${xhr.status})`)));
    xhr.onerror = () => reject(new Error('Network error during upload'));
    xhr.onabort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    signal.addEventListener('abort', () => xhr.abort());
    xhr.send(file);
  });
}
