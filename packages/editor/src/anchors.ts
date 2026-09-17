import * as Y from 'yjs';
import type { Editor } from '@tiptap/core';
import type { EditorState } from '@tiptap/pm/state';
import { absolutePositionToRelativePosition, relativePositionToAbsolutePosition, ySyncPluginKey } from '@tiptap/y-tiptap';
import type { CommentAnchor } from './types';

interface YSyncState {
  type: Y.XmlFragment;
  binding: { mapping: Map<unknown, unknown> } | null;
  doc?: Y.Doc;
}

function ySync(state: EditorState): YSyncState | null {
  const s = ySyncPluginKey.getState(state) as YSyncState | undefined;
  if (!s || !s.binding) return null;
  return s;
}

function toB64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function encodeRelativePositionAt(state: EditorState, pos: number): string | null {
  const s = ySync(state);
  if (!s) return null;
  const rel = absolutePositionToRelativePosition(pos, s.type, s.binding!.mapping as never) as Y.RelativePosition;
  return toB64(Y.encodeRelativePosition(rel));
}

export function blockIdAt(state: EditorState, pos: number): string | null {
  const $pos = state.doc.resolve(Math.max(0, Math.min(pos, state.doc.content.size)));
  if ($pos.depth < 1) {
    const idx = $pos.index(0);
    const node = state.doc.maybeChild(idx);
    return (node?.attrs.blockId as string | undefined) ?? null;
  }
  return ($pos.node(1).attrs.blockId as string | undefined) ?? null;
}

/** Encode the current selection as stable CRDT anchors for a comment. */
export function anchorFromSelection(editor: Editor): CommentAnchor | null {
  const { state } = editor;
  const { from, to } = state.selection;
  const anchorFrom = encodeRelativePositionAt(state, from);
  const anchorTo = encodeRelativePositionAt(state, to);
  if (!anchorFrom || !anchorTo) return null;
  return { anchorFrom, anchorTo, blockId: blockIdAt(state, from) ?? '' };
}

/** Resolve stored anchors back to absolute positions; null when the anchored text no longer exists. */
export function resolveAnchor(
  editor: Editor,
  anchor: { anchorFrom: string | null; anchorTo: string | null },
): { from: number; to: number } | null {
  if (!anchor.anchorFrom || !anchor.anchorTo) return null;
  const s = ySync(editor.state);
  if (!s) return null;
  const ydoc = s.type.doc;
  if (!ydoc) return null;
  try {
    const relFrom = Y.decodeRelativePosition(fromB64(anchor.anchorFrom));
    const relTo = Y.decodeRelativePosition(fromB64(anchor.anchorTo));
    const from = relativePositionToAbsolutePosition(ydoc, s.type, relFrom, s.binding!.mapping as never);
    const to = relativePositionToAbsolutePosition(ydoc, s.type, relTo, s.binding!.mapping as never);
    if (from === null || to === null) return null;
    const size = editor.state.doc.content.size;
    const a = Math.max(0, Math.min(from, size));
    const b = Math.max(0, Math.min(to, size));
    return { from: Math.min(a, b), to: Math.max(a, b) };
  } catch {
    return null;
  }
}

/** Find the absolute range of a top-level block by id (fallback when anchors no longer resolve). */
export function blockRange(editor: Editor, blockId: string): { from: number; to: number } | null {
  let found: { from: number; to: number } | null = null;
  editor.state.doc.forEach((node, offset) => {
    if (!found && node.attrs.blockId === blockId) found = { from: offset + 1, to: offset + node.nodeSize - 1 };
  });
  return found;
}
