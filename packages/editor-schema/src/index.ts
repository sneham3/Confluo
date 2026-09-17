import type { Extensions } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import Heading from '@tiptap/extension-heading';
import Bold from '@tiptap/extension-bold';
import Italic from '@tiptap/extension-italic';
import HardBreak from '@tiptap/extension-hard-break';
import { BulletList, ListItem, ListKeymap, OrderedList } from '@tiptap/extension-list';
import { Dropcursor, Gapcursor } from '@tiptap/extensions';
import { ConfluoImage } from './image';
import { BlockId } from './block-id';

export { ConfluoImage, type ImageAttrs, type ImageStatus } from './image';
export { BlockId, BLOCK_TYPES, blockIdPluginKey } from './block-id';

export const schemaVersion = 1;

/**
 * Server-safe extension set (no DOM access at import time). Shared by the browser editor,
 * the server-side renderer and the landing-page demos. History is deliberately excluded:
 * collaboration provides undo/redo via Y.UndoManager.
 */
export function createSchemaExtensions(): Extensions {
  return [
    Document,
    Paragraph,
    Text,
    Heading.configure({ levels: [1, 2, 3] }),
    Bold,
    Italic,
    HardBreak,
    BulletList,
    OrderedList,
    ListItem,
    ListKeymap,
    Dropcursor,
    Gapcursor,
    ConfluoImage,
    BlockId,
  ];
}

export const extensions: Extensions = createSchemaExtensions();
