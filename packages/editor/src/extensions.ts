import type { Extensions } from '@tiptap/core';
import { Extension } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import Collaboration from '@tiptap/extension-collaboration';
import { CollaborationCaret } from '@tiptap/extension-collaboration-caret';
import type * as Y from 'yjs';
import type { Awareness } from 'y-protocols/awareness';
import { ConfluoImage, createSchemaExtensions } from '@confluo/editor-schema';
import { CONTENT_FIELD } from '@confluo/shared';
import { ImageNodeView, type ImageNodeViewOptions } from './image-node-view';
import { LockManager, softLockPlugin } from './soft-lock';
import type { CollabUser } from './types';

export interface CollabExtensionOptions {
  ydoc: Y.Doc;
  /** Anything with an `awareness` field (our TicketedWebsocketProvider.provider or a bare {awareness}). */
  provider: { awareness: Awareness };
  user: CollabUser;
  lockManager?: LockManager;
  image?: Partial<ImageNodeViewOptions>;
  /** Skip the caret extension (e.g. local demos). */
  carets?: boolean;
}

const SoftLockExtension = Extension.create<{ manager: LockManager | null }>({
  name: 'confluoSoftLock',
  // Above the keymap extensions so the Enter escape hatch runs before the default split handler.
  priority: 1000,
  addOptions() {
    return { manager: null };
  },
  addProseMirrorPlugins() {
    return this.options.manager ? [softLockPlugin(this.options.manager)] : [];
  },
});

/** Schema extensions + Collaboration + CollaborationCaret + SoftLock + React image node view. */
export function createCollabEditorExtensions(opts: CollabExtensionOptions): Extensions {
  const base = createSchemaExtensions().filter((e) => e.name !== 'image');
  const image = ConfluoImage.extend<Partial<ImageNodeViewOptions>>({
    addOptions() {
      return {
        resolveUrl: async (_assetId, src) => src,
        getProgress: () => null,
        isUploader: () => false,
        retry: () => undefined,
        subscribe: () => () => undefined,
        ...opts.image,
      };
    },
    addNodeView() {
      return ReactNodeViewRenderer(ImageNodeView, { as: 'div', className: 'confluo-image-wrapper' });
    },
  });
  const list: Extensions = [
    ...base,
    image,
    Collaboration.configure({ document: opts.ydoc, field: CONTENT_FIELD }),
  ];
  if (opts.carets !== false) {
    list.push(
      CollaborationCaret.configure({
        provider: opts.provider,
        user: { name: opts.user.name, color: opts.user.color, id: opts.user.id },
      }),
    );
  }
  if (opts.lockManager) list.push(SoftLockExtension.configure({ manager: opts.lockManager }));
  return list;
}
