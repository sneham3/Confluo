import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { Editor } from '@tiptap/core';
import { Awareness } from 'y-protocols/awareness';
import { createCollabEditorExtensions } from './extensions';
import { UploadManager } from './upload-manager';
import type { ApiClient } from './types';

function makeEditor() {
  const ydoc = new Y.Doc();
  const awareness = new Awareness(ydoc);
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: createCollabEditorExtensions({
      ydoc,
      provider: { awareness },
      user: { id: 'u', name: 'U', color: '#000' },
      carets: false,
    }),
  });
  editor.commands.setContent('<p>hello</p>');
  return editor;
}

function findImage(editor: Editor) {
  let found: { pos: number; attrs: Record<string, unknown> } | null = null;
  editor.state.doc.descendants((n, pos) => {
    if (n.type.name === 'image' && !found) found = { pos, attrs: n.attrs };
    return !found;
  });
  return found as { pos: number; attrs: Record<string, unknown> } | null;
}

describe('UploadManager', () => {
  it('inserts a placeholder, uploads, and patches the node by uploadId despite intervening edits', async () => {
    const editor = makeEditor();
    let resolvePut!: () => void;
    const putPromise = new Promise<void>((r) => (resolvePut = r));
    const api: ApiClient = {
      get: vi.fn(),
      post: vi.fn(async (path: string) => {
        if (path.endsWith('/presign')) return { assetId: 'asset1', uploadUrl: 'http://x/put', method: 'PUT', headers: {}, expiresAt: '' };
        if (path.endsWith('/complete')) return { asset: { id: 'asset1', url: '/v1/assets/asset1', width: 10, height: 10 } };
        throw new Error('unexpected');
      }) as ApiClient['post'],
      patch: vi.fn(),
      delete: vi.fn(async () => undefined) as ApiClient['delete'],
    };
    const um = new UploadManager({
      docId: 'd',
      api,
      getEditor: () => editor,
      put: async (_u, _h, _f, _s, onProgress) => {
        onProgress(0.5);
        await putPromise;
      },
    });
    um.bindEditor(editor);
    const file = new File([new Uint8Array([1, 2, 3])], 'a.png', { type: 'image/png' });
    editor.commands.setTextSelection(6);
    const id = um.enqueue(file);
    expect(id).toBeTruthy();
    let img = findImage(editor)!;
    expect(img.attrs.status).toBe('uploading');
    expect(img.attrs.uploadId).toBe(id);
    expect(um.pending).toBe(1);
    // Intervening edit before the image shifts positions.
    editor.chain().setTextSelection(1).insertContent('PREFIX ').run();
    const before = findImage(editor)!;
    expect(before.pos).toBeGreaterThan(img.pos);
    resolvePut();
    await vi.waitFor(() => expect(um.pending).toBe(0));
    img = findImage(editor)!;
    expect(img.attrs.status).toBe('ready');
    expect(img.attrs.assetId).toBe('asset1');
    expect(img.attrs.src).toBe('/v1/assets/asset1');
    expect(api.delete).not.toHaveBeenCalled();
  });

  it('aborts and cleans up when the placeholder is deleted mid-upload', async () => {
    const editor = makeEditor();
    let signalSeen: AbortSignal | null = null;
    const api: ApiClient = {
      get: vi.fn(),
      post: vi.fn(async (path: string) => {
        if (path.endsWith('/presign')) return { assetId: 'asset2', uploadUrl: 'http://x/put', method: 'PUT', headers: {}, expiresAt: '' };
        return { asset: { id: 'asset2', url: '/v1/assets/asset2', width: null, height: null } };
      }) as ApiClient['post'],
      patch: vi.fn(),
      delete: vi.fn(async () => undefined) as ApiClient['delete'],
    };
    const um = new UploadManager({
      docId: 'd',
      api,
      getEditor: () => editor,
      put: (_u, _h, _f, signal) =>
        new Promise<void>((_res, rej) => {
          signalSeen = signal;
          signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        }),
    });
    um.bindEditor(editor);
    const file = new File([new Uint8Array([1])], 'b.png', { type: 'image/png' });
    um.enqueue(file);
    await vi.waitFor(() => expect(signalSeen).not.toBeNull());
    // Delete the placeholder node.
    const img = findImage(editor)!;
    editor.view.dispatch(editor.state.tr.delete(img.pos, img.pos + 1));
    await vi.waitFor(() => expect(um.pending).toBe(0));
    expect(signalSeen!.aborted).toBe(true);
    await vi.waitFor(() => expect(api.delete).toHaveBeenCalledWith('/assets/asset2'));
    expect(api.post).toHaveBeenCalledTimes(1); // no complete call
  });

  it('rejects unsupported mime types', () => {
    const editor = makeEditor();
    const onError = vi.fn();
    const um = new UploadManager({ docId: 'd', api: {} as ApiClient, getEditor: () => editor, onError });
    expect(um.enqueue(new File([new Uint8Array([1])], 'x.txt', { type: 'text/plain' }))).toBeNull();
    expect(onError).toHaveBeenCalled();
  });
});
