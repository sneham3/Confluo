import { mergeAttributes, Node } from '@tiptap/core';

export type ImageStatus = 'uploading' | 'ready' | 'failed';

export interface ImageAttrs {
  src: string | null;
  alt: string;
  assetId: string | null;
  uploadId: string | null;
  status: ImageStatus;
  width: number | null;
  blockId?: string | null;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    confluoImage: {
      insertImage: (attrs: Partial<ImageAttrs>) => ReturnType;
    };
  }
}

/**
 * Block-level atom image. `status` and `uploadId` drive the background-upload flow
 * (common doc §12.3). Node views live in @confluo/editor; the schema is DOM-free.
 */
export const ConfluoImage = Node.create({
  name: 'image',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      src: {
        default: null,
        parseHTML: (el) => (el as HTMLElement).querySelector('img')?.getAttribute('src') ?? (el as HTMLElement).getAttribute('src'),
      },
      alt: {
        default: '',
        parseHTML: (el) => (el as HTMLElement).querySelector('img')?.getAttribute('alt') ?? (el as HTMLElement).getAttribute('alt') ?? '',
      },
      assetId: { default: null, parseHTML: (el) => (el as HTMLElement).getAttribute('data-asset-id') },
      uploadId: { default: null, rendered: false },
      status: {
        default: 'ready',
        parseHTML: (el) => (el as HTMLElement).getAttribute('data-status') ?? 'ready',
      },
      width: {
        default: null,
        parseHTML: (el) => {
          const w = (el as HTMLElement).querySelector('img')?.getAttribute('width');
          return w ? parseInt(w, 10) : null;
        },
      },
    };
  },

  parseHTML() {
    return [{ tag: 'figure[data-type="image"]' }, { tag: 'img[src]' }];
  },

  renderHTML({ HTMLAttributes, node }) {
    const { src, alt, width, assetId, status, blockId } = node.attrs as ImageAttrs;
    // Never emit blob: object URLs into persisted/rendered HTML.
    const safeSrc = src && !src.startsWith('blob:') ? src : null;
    const figureAttrs = mergeAttributes(
      { 'data-type': 'image', 'data-status': status },
      assetId ? { 'data-asset-id': assetId } : {},
      blockId ? { 'data-block-id': blockId } : {},
      HTMLAttributes,
      { src: null, alt: null, width: null, assetId: null, uploadId: null, status: null },
    );
    const imgAttrs: Record<string, string | number> = { alt: alt ?? '' };
    if (safeSrc) imgAttrs.src = safeSrc;
    if (width) imgAttrs.width = width;
    return ['figure', figureAttrs, ['img', imgAttrs]];
  },

  addCommands() {
    return {
      insertImage:
        (attrs) =>
        ({ commands }) =>
          commands.insertContent({
            type: this.name,
            attrs: { alt: '', status: 'ready', ...attrs },
          }),
    };
  },
});
