import type { Comment, Doc, User, UserPublic } from '@confluo/shared';
import type { comments, documents, users } from '@confluo/shared/db';

type UserRow = typeof users.$inferSelect;
type DocRow = typeof documents.$inferSelect;
type CommentRow = typeof comments.$inferSelect;

export function iso(d: Date | string | null | undefined): string {
  if (!d) return new Date(0).toISOString();
  return typeof d === 'string' ? new Date(d).toISOString() : d.toISOString();
}

export function toUserPublic(u: Pick<UserRow, 'id' | 'displayName' | 'color' | 'avatarUrl'>): UserPublic {
  return { id: u.id, name: u.displayName, color: u.color, avatarUrl: u.avatarUrl ?? null };
}

export function toUser(u: UserRow): User {
  return { ...toUserPublic(u), email: u.email, createdAt: iso(u.createdAt) };
}

export function toDoc(d: DocRow): Doc {
  return {
    id: d.id,
    title: d.title,
    version: Number(d.version),
    ownerId: d.ownerId,
    createdAt: iso(d.createdAt),
    updatedAt: iso(d.updatedAt),
  };
}

export function bytesToB64(b: Uint8Array | null | undefined): string | null {
  if (!b) return null;
  return Buffer.from(b).toString('base64');
}

export function b64ToBytes(s: string | undefined | null): Uint8Array | null {
  if (!s) return null;
  const buf = Buffer.from(s, 'base64');
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

export function toComment(c: CommentRow, author: UserPublic): Comment {
  return {
    id: c.id,
    documentId: c.documentId,
    author,
    parentId: c.parentId ?? null,
    anchorFrom: bytesToB64(c.anchorFrom),
    anchorTo: bytesToB64(c.anchorTo),
    blockId: c.blockId ?? null,
    body: c.body,
    resolvedAt: c.resolvedAt ? iso(c.resolvedAt) : null,
    createdAt: iso(c.createdAt),
    updatedAt: iso(c.updatedAt),
  };
}
