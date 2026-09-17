import * as Y from 'yjs';
import { and, asc, desc, eq, gt } from 'drizzle-orm';
import { getSchema, type JSONContent } from '@tiptap/core';
import { generateHTML } from '@tiptap/html';
import { prosemirrorJSONToYDoc, yDocToProsemirrorJSON } from '@tiptap/y-tiptap';
import { createSchemaExtensions } from '@confluo/editor-schema';
import { CONTENT_FIELD, newBlockId } from '@confluo/shared';
import { documentSnapshots, documentUpdates } from '@confluo/shared/db';
import type { Db } from '@confluo/adapters';

const extensions = createSchemaExtensions();
const pmSchema = getSchema(extensions);

export interface LoadedDoc {
  ydoc: Y.Doc;
  /** Highest document_updates.id folded into `ydoc` (0 when none). */
  lastUpdateId: number;
  /** upto_update_id of the snapshot used as the baseline (0 when none). */
  snapshotUptoId: number;
  updatesSinceSnapshot: number;
  bytesSinceSnapshot: number;
}

/** Load a document's authoritative state: newest snapshot + trailing updates (common doc §11.1). */
export async function loadYDoc(db: Db, docId: string): Promise<LoadedDoc> {
  const ydoc = new Y.Doc({ guid: docId, gc: true });
  const [snap] = await db
    .select()
    .from(documentSnapshots)
    .where(eq(documentSnapshots.documentId, docId))
    .orderBy(desc(documentSnapshots.id))
    .limit(1);

  let lastUpdateId = 0;
  let snapshotUptoId = 0;
  if (snap) {
    Y.applyUpdateV2(ydoc, snap.state, 'load');
    snapshotUptoId = Number(snap.uptoUpdateId);
    lastUpdateId = snapshotUptoId;
  }

  const rows = await db
    .select({ id: documentUpdates.id, update: documentUpdates.update, byteSize: documentUpdates.byteSize })
    .from(documentUpdates)
    .where(and(eq(documentUpdates.documentId, docId), gt(documentUpdates.id, snapshotUptoId)))
    .orderBy(asc(documentUpdates.id));

  let bytes = 0;
  const CHUNK = 256;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const merged = chunk.length === 1 ? chunk[0]!.update : Y.mergeUpdates(chunk.map((r) => r.update));
    Y.applyUpdate(ydoc, merged, 'load');
  }
  for (const r of rows) {
    bytes += r.byteSize;
    lastUpdateId = Math.max(lastUpdateId, Number(r.id));
  }
  return {
    ydoc,
    lastUpdateId,
    snapshotUptoId,
    updatesSinceSnapshot: rows.length,
    bytesSinceSnapshot: bytes,
  };
}

export function toProseMirrorJSON(ydoc: Y.Doc): JSONContent {
  return yDocToProsemirrorJSON(ydoc, CONTENT_FIELD) as JSONContent;
}

const ALLOWED_TAGS = new Set([
  'p', 'h1', 'h2', 'h3', 'ul', 'ol', 'li', 'strong', 'em', 'br', 'figure', 'img',
]);

/** Allowlist sanitizer over the schema-generated HTML (defense in depth; the schema has no raw HTML). */
export function sanitizeHTML(html: string): string {
  return html.replace(/<\/?([a-zA-Z0-9]+)([^>]*)>/g, (m, tag: string, attrs: string) => {
    const t = tag.toLowerCase();
    if (!ALLOWED_TAGS.has(t)) return '';
    const cleanAttrs = (attrs || '')
      .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
      .replace(/\s(href|srcdoc)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
      .replace(/\ssrc\s*=\s*"(javascript:|data:text)[^"]*"/gi, '');
    return m.startsWith('</') ? `</${t}>` : `<${t}${cleanAttrs}>`;
  });
}

export function toHTML(ydoc: Y.Doc): string {
  return sanitizeHTML(generateHTML(toProseMirrorJSON(ydoc), extensions));
}

function collectText(node: JSONContent, out: string[]): void {
  if (node.type === 'text') {
    out.push(node.text ?? '');
    return;
  }
  if (node.type === 'hardBreak') {
    out.push('\n');
    return;
  }
  const isBlock = node.type !== 'doc' && node.type !== 'listItem';
  for (const child of node.content ?? []) collectText(child, out);
  if (isBlock) out.push('\n');
}

export function toText(ydoc: Y.Doc): string {
  const out: string[] = [];
  collectText(toProseMirrorJSON(ydoc), out);
  return out.join('').replace(/\n{3,}/g, '\n\n').trim();
}

export function stats(ydoc: Y.Doc): { chars: number; blocks: number; encodedV2Bytes: number; clients: number } {
  const json = toProseMirrorJSON(ydoc);
  return {
    chars: toText(ydoc).length,
    blocks: json.content?.length ?? 0,
    encodedV2Bytes: Y.encodeStateAsUpdateV2(ydoc).byteLength,
    clients: ydoc.store.clients.size,
  };
}

/** Initial content for a brand-new document: one empty paragraph with a block id. */
export function createInitialDoc(docId: string): Y.Doc {
  const json: JSONContent = {
    type: 'doc',
    content: [{ type: 'paragraph', attrs: { blockId: newBlockId() } }],
  };
  const ydoc = prosemirrorJSONToYDoc(pmSchema, json, CONTENT_FIELD);
  // prosemirrorJSONToYDoc creates its own Y.Doc; re-encode into one with the right guid.
  const out = new Y.Doc({ guid: docId, gc: true });
  Y.applyUpdate(out, Y.encodeStateAsUpdate(ydoc));
  return out;
}

export function encodeSnapshot(ydoc: Y.Doc): { state: Uint8Array; stateVector: Uint8Array; byteSize: number; charCount: number } {
  const state = Y.encodeStateAsUpdateV2(ydoc);
  return {
    state,
    stateVector: Y.encodeStateVector(ydoc),
    byteSize: state.byteLength,
    charCount: toText(ydoc).length,
  };
}

/** Collect every uploaded assetId referenced by image nodes (used by the orphan sweeper). */
export function referencedAssetIds(ydoc: Y.Doc): Set<string> {
  const ids = new Set<string>();
  const walk = (n: JSONContent) => {
    if (n.type === 'image' && typeof n.attrs?.assetId === 'string') ids.add(n.attrs.assetId);
    for (const c of n.content ?? []) walk(c);
  };
  walk(toProseMirrorJSON(ydoc));
  return ids;
}
