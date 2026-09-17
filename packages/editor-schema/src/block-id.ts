import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { newBlockId } from '@confluo/shared';

export const BLOCK_TYPES = ['paragraph', 'heading', 'bulletList', 'orderedList', 'image'] as const;
export const blockIdPluginKey = new PluginKey('confluoBlockId');

/**
 * Global `blockId` attribute on every top-level block (common doc §6.2).
 * Assigned locally when missing or duplicated (split/paste). Remote (y-sync) transactions are never
 * touched: their blocks already carry ids.
 */
export const BlockId = Extension.create({
  name: 'blockId',

  addGlobalAttributes() {
    return [
      {
        types: [...BLOCK_TYPES],
        attributes: {
          blockId: {
            default: null,
            keepOnSplit: false,
            parseHTML: (el) => (el as HTMLElement).getAttribute('data-block-id'),
            renderHTML: (attrs) => (attrs.blockId ? { 'data-block-id': attrs.blockId } : {}),
          },
        },
      },
    ];
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: blockIdPluginKey,
        appendTransaction: (transactions, _old, newState) => {
          if (!transactions.some((tr) => tr.docChanged)) return null;
          // Only remote changes → nothing to do (ids arrive with the content).
          if (transactions.every((tr) => tr.getMeta('y-sync$'))) return null;
          const seen = new Set<string>();
          let tr = newState.tr;
          let changed = false;
          newState.doc.forEach((node, offset) => {
            if (!(BLOCK_TYPES as readonly string[]).includes(node.type.name)) return;
            const id = node.attrs.blockId as string | null;
            if (!id || seen.has(id)) {
              const next = newBlockId();
              seen.add(next);
              tr = tr.setNodeMarkup(offset, undefined, { ...node.attrs, blockId: next }, node.marks);
              changed = true;
            } else {
              seen.add(id);
            }
          });
          if (!changed) return null;
          tr.setMeta('addToHistory', false);
          tr.setMeta('confluoBlockId', true);
          return tr;
        },
      }),
    ];
  },
});
