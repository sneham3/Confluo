import * as Y from 'yjs';
import { and, eq, isNull } from 'drizzle-orm';
import { documentPermissions, documentSnapshots, documents, users } from '@confluo/shared/db';
import { createInitialDoc, encodeSnapshot } from '@confluo/doc-render';
import { CONTENT_FIELD } from '@confluo/shared';
import type { ApiDeps } from './types.js';
import { AuthService } from './services/auth.js';

const PASSWORD = 'password123!';

/** Idempotent demo seed: alice (owner) + bob (editor) sharing "Welcome to Confluo". */
export async function seedDemo(deps: ApiDeps): Promise<{ users: { email: string; password: string }[]; docId: string }> {
  const { db } = deps.adapters;
  const auth = new AuthService(deps);
  await auth.init();

  const ensureUser = async (email: string, displayName: string) => {
    const [existing] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (existing) return existing;
    return auth.register({ email, password: PASSWORD, displayName });
  };
  const alice = await ensureUser('alice@confluo.dev', 'Alice Rivera');
  const bob = await ensureUser('bob@confluo.dev', 'Bob Okafor');

  const [existingDoc] = await db
    .select()
    .from(documents)
    .where(and(eq(documents.ownerId, alice.id), eq(documents.title, 'Welcome to Confluo'), isNull(documents.deletedAt)))
    .limit(1);
  let docId = existingDoc?.id;
  if (!docId) {
    docId = await db.transaction(async (tx) => {
      const [d] = await tx.insert(documents).values({ title: 'Welcome to Confluo', ownerId: alice.id }).returning();
      await tx.insert(documentPermissions).values({ documentId: d!.id, userId: alice.id, role: 'owner', grantedBy: alice.id });
      const ydoc = createInitialDoc(d!.id);
      const frag = ydoc.getXmlFragment(CONTENT_FIELD);
      const p = frag.get(0) as Y.XmlElement;
      p.insert(0, [
        new Y.XmlText(
          'Welcome to Confluo. Open this document in two browsers, sign in as Alice and Bob, and type in different paragraphs to see live collaboration, cursors and soft locks.',
        ),
      ]);
      const snap = encodeSnapshot(ydoc);
      await tx.insert(documentSnapshots).values({
        documentId: d!.id,
        uptoUpdateId: 0,
        state: snap.state,
        stateVector: snap.stateVector,
        byteSize: snap.byteSize,
        charCount: snap.charCount,
      });
      return d!.id;
    });
  }
  await db
    .insert(documentPermissions)
    .values({ documentId: docId, userId: bob.id, role: 'editor', grantedBy: alice.id })
    .onConflictDoNothing();

  return {
    users: [
      { email: 'alice@confluo.dev', password: PASSWORD },
      { email: 'bob@confluo.dev', password: PASSWORD },
    ],
    docId,
  };
}
