import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as syncProtocol from 'y-protocols/sync';
import { pino } from 'pino';
import { count, eq } from 'drizzle-orm';
import { createAdapters, type Adapters } from '@confluo/adapters';
import {
  CLOSE_FORBIDDEN,
  MESSAGE_RPC,
  MESSAGE_RPC_RESULT,
  MESSAGE_SERVER_EVENT,
  MESSAGE_SYNC,
  SYNC_STEP2,
  type Role,
  type RpcResult,
  type ServerEvent,
} from '@confluo/shared';
import { documentPermissions, documentSnapshots, documentUpdates, documents, users } from '@confluo/shared/db';
import { createInitialDoc, encodeSnapshot, loadYDoc, toProseMirrorJSON, toText } from '@confluo/doc-render';
import { createSyncServer, type SyncServer } from './server.js';
import { encodeSyncStep1, encodeUpdate } from './ws/codec.js';

let tmp: string;
let adapters: Adapters;
let sync: SyncServer;
let http: Server;
let port = 0;
let docId = '';
let blockId = '';
const ids = { owner: '', editor: '', viewer: '' };

function buf(u: Uint8Array): Buffer {
  return Buffer.from(u.buffer, u.byteOffset, u.byteLength);
}

async function ticket(userId: string, role: Role, forDoc = docId): Promise<string> {
  const t = randomBytes(16).toString('base64url');
  await adapters.kv.set(
    `ticket:${t}`,
    JSON.stringify({ userId, docId: forDoc, role, name: `user-${role}`, color: '#123456', iat: Date.now() }),
    { pxMs: 60_000 },
  );
  return t;
}

class Client {
  readonly ws: WebSocket;
  readonly ydoc = new Y.Doc();
  readonly events: ServerEvent[] = [];
  readonly opened: Promise<void>;
  readonly closed: Promise<number>;
  readonly synced: Promise<void>;
  private readonly waiters = new Map<string, (r: RpcResult) => void>();
  private readonly eventWaiters: Array<{ type: string; resolve: (e: ServerEvent) => void }> = [];
  private n = 0;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    let resolveSynced!: () => void;
    this.synced = new Promise<void>((r) => (resolveSynced = r));
    this.opened = new Promise<void>((res, rej) => {
      this.ws.once('open', () => res());
      this.ws.once('error', (e) => rej(e));
      this.ws.once('unexpected-response', (_req, r) => rej(new Error(`HTTP ${r.statusCode}`)));
    });
    this.closed = new Promise<number>((res) => this.ws.once('close', (code) => res(code)));
    this.ws.on('message', (data: Buffer) => {
      const dec = decoding.createDecoder(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      const type = decoding.readVarUint(dec);
      if (type === MESSAGE_SYNC) {
        const enc = encoding.createEncoder();
        encoding.writeVarUint(enc, MESSAGE_SYNC);
        const mt = syncProtocol.readSyncMessage(dec, enc, this.ydoc, 'server');
        if (encoding.length(enc) > 1) this.ws.send(buf(encoding.toUint8Array(enc)));
        if (mt === SYNC_STEP2) resolveSynced();
      } else if (type === MESSAGE_RPC_RESULT) {
        const r = JSON.parse(decoding.readVarString(dec)) as RpcResult;
        this.waiters.get(r.id)?.(r);
        this.waiters.delete(r.id);
      } else if (type === MESSAGE_SERVER_EVENT) {
        const e = JSON.parse(decoding.readVarString(dec)) as ServerEvent;
        this.events.push(e);
        for (const w of this.eventWaiters.splice(0)) {
          if (w.type === e.type) w.resolve(e);
          else this.eventWaiters.push(w);
        }
      }
    });
    this.ydoc.on('update', (u: Uint8Array, origin: unknown) => {
      if (origin !== 'server' && this.ws.readyState === WebSocket.OPEN) this.ws.send(buf(encodeUpdate(u)));
    });
  }

  async connect(): Promise<this> {
    await this.opened;
    this.ws.send(buf(encodeSyncStep1(this.ydoc)));
    await this.synced;
    return this;
  }

  rpc(method: string, params: Record<string, unknown> = {}): Promise<RpcResult> {
    const id = `r${++this.n}`;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MESSAGE_RPC);
    encoding.writeVarString(enc, JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(`rpc ${method} timed out`)), 5000);
      this.waiters.set(id, (r) => {
        clearTimeout(t);
        res(r);
      });
      this.ws.send(buf(encoding.toUint8Array(enc)));
    });
  }

  waitEvent(type: string, timeoutMs = 3000): Promise<ServerEvent> {
    const existing = this.events.find((e) => e.type === type);
    if (existing) return Promise.resolve(existing);
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(`no ${type} event`)), timeoutMs);
      this.eventWaiters.push({
        type,
        resolve: (e) => {
          clearTimeout(t);
          res(e);
        },
      });
    });
  }

  insertText(text: string, at?: number) {
    const frag = this.ydoc.getXmlFragment('content');
    const p = frag.get(0) as Y.XmlElement;
    p.insert(at ?? p.length, [new Y.XmlText(text)]);
  }

  text() {
    return toText(this.ydoc);
  }

  close() {
    this.ws.close();
    return this.closed;
  }
}

async function until(pred: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('condition not met');
    await new Promise((r) => setTimeout(r, 25));
  }
}

const url = (t: string, d = docId) => `ws://127.0.0.1:${port}/v1/docs/${d}?ticket=${t}`;

beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'confluo-sync-'));
  adapters = await createAdapters({
    CONFLUO_MODE: 'local',
    DATA_DIR: tmp,
    API_URL: 'http://localhost:4000',
    SERVICE_TOKEN: 'test-service-token',
  });
  const db = adapters.db;
  const mk = async (email: string) =>
    (await db.insert(users).values({ email, passwordHash: 'x', displayName: email, color: '#000000' }).returning({ id: users.id }))[0]!.id;
  ids.owner = await mk('owner@test');
  ids.editor = await mk('editor@test');
  ids.viewer = await mk('viewer@test');
  docId = (await db.insert(documents).values({ title: 'T', ownerId: ids.owner }).returning({ id: documents.id }))[0]!.id;
  await db.insert(documentPermissions).values([
    { documentId: docId, userId: ids.owner, role: 'owner', grantedBy: ids.owner },
    { documentId: docId, userId: ids.editor, role: 'editor', grantedBy: ids.owner },
    { documentId: docId, userId: ids.viewer, role: 'viewer', grantedBy: ids.owner },
  ]);
  const initial = createInitialDoc(docId);
  blockId = toProseMirrorJSON(initial).content![0]!.attrs!.blockId as string;
  const snap = encodeSnapshot(initial);
  await db.insert(documentSnapshots).values({
    documentId: docId,
    uptoUpdateId: 0,
    state: buf(snap.state) as unknown as Uint8Array,
    stateVector: buf(snap.stateVector) as unknown as Uint8Array,
    byteSize: snap.byteSize,
    charCount: 0,
  });

  sync = await createSyncServer({
    adapters,
    logger: pino({ level: 'silent' }),
    config: { nodeId: 'test-node', webUrl: 'http://localhost:3000', pathPrefix: '', maxRssMb: 4096 },
  });
  http = createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  http.on('upgrade', (req, socket, head) => {
    if (!sync.handleUpgrade(req, socket, head)) socket.destroy();
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', () => r()));
  port = (http.address() as { port: number }).port;
}, 60_000);

afterAll(async () => {
  await sync?.close();
  await new Promise<void>((r) => http?.close(() => r()));
  await adapters?.close();
  await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
}, 30_000);

describe('sync server', () => {
  it('rejects a bad ticket with 401', async () => {
    await expect(new Client(url('nope')).connect()).rejects.toThrow('HTTP 401');
  });

  it('rejects a ticket for another doc with 403', async () => {
    const t = await ticket(ids.editor, 'editor', '00000000-0000-0000-0000-000000000000');
    await expect(new Client(url(t)).connect()).rejects.toThrow('HTTP 403');
  });

  it('rejects a replayed ticket', async () => {
    const t = await ticket(ids.editor, 'editor');
    const a = await new Client(url(t)).connect();
    await expect(new Client(url(t)).connect()).rejects.toThrow('HTTP 401');
    await a.close();
  });

  it('syncs editor updates, drops viewer updates, arbitrates locks, persists and compacts, revokes', async () => {
    const owner = await new Client(url(await ticket(ids.owner, 'owner'))).connect();
    const editor = await new Client(url(await ticket(ids.editor, 'editor'))).connect();
    const viewer = await new Client(url(await ticket(ids.viewer, 'viewer'))).connect();
    await owner.waitEvent('connected');

    // editor → everyone
    editor.insertText('hello');
    await until(() => owner.text().includes('hello'));
    await until(() => viewer.text().includes('hello'));

    // viewer update is dropped and gets FORBIDDEN_EDIT
    viewer.insertText('HACK');
    const err = await viewer.waitEvent('error');
    expect((err.payload as { code: string }).code).toBe('FORBIDDEN_EDIT');
    await new Promise((r) => setTimeout(r, 300));
    expect(owner.text()).not.toContain('HACK');
    expect(editor.text()).not.toContain('HACK');

    // locks: owner acquires, editor is refused, viewer forbidden
    const l1 = await owner.rpc('lock.acquire', { blockId });
    expect(l1.ok && (l1.result as { granted: boolean }).granted).toBe(true);
    const l2 = await editor.rpc('lock.acquire', { blockId });
    expect(l2.ok).toBe(true);
    expect((l2 as { result: { granted: boolean; holder: { userId: string } } }).result.granted).toBe(false);
    expect((l2 as { result: { holder: { userId: string } } }).result.holder.userId).toBe(ids.owner);
    const l3 = await viewer.rpc('lock.acquire', { blockId });
    expect(l3.ok).toBe(false);
    expect(!l3.ok && l3.error.code).toBe('FORBIDDEN');
    const changed = await editor.waitEvent('lock.changed');
    expect((changed.payload as { blockId: string }).blockId).toBe(blockId);
    const rel = await owner.rpc('lock.release', { blockId });
    expect(rel.ok && (rel.result as { released: boolean }).released).toBe(true);

    // ping
    const p = await editor.rpc('ping', { t: 42 });
    expect(p.ok && (p.result as { t: number }).t).toBe(42);

    // persisted within the flush window
    await new Promise((r) => setTimeout(r, 450));
    const loaded = await loadYDoc(adapters.db, docId);
    expect(toText(loaded.ydoc)).toContain('hello');
    expect(loaded.updatesSinceSnapshot).toBeGreaterThan(0);

    // forceSnapshot compacts: one more snapshot, zero trailing updates
    const snapBefore = (await adapters.db.select({ n: count() }).from(documentSnapshots).where(eq(documentSnapshots.documentId, docId)))[0]!.n;
    const fs = await owner.rpc('admin.forceSnapshot');
    expect(fs.ok).toBe(true);
    const snapAfter = (await adapters.db.select({ n: count() }).from(documentSnapshots).where(eq(documentSnapshots.documentId, docId)))[0]!.n;
    expect(Number(snapAfter)).toBe(Number(snapBefore) + 1);
    const remaining = (await adapters.db.select({ n: count() }).from(documentUpdates).where(eq(documentUpdates.documentId, docId)))[0]!.n;
    expect(Number(remaining)).toBe(0);
    const reloaded = await loadYDoc(adapters.db, docId);
    expect(toText(reloaded.ydoc)).toContain('hello');

    // editor cannot use admin rpc
    const k = await editor.rpc('admin.broadcast', { message: 'x' });
    expect(!k.ok && k.error.code).toBe('FORBIDDEN');

    // revoke editor via the events channel → closed with 4003
    await adapters.pubsub.publish(
      `doc:${docId}:events`,
      JSON.stringify({ type: 'permission.changed', payload: { userId: ids.editor, role: null }, ts: Date.now() }),
    );
    expect(await editor.closed).toBe(CLOSE_FORBIDDEN);

    // promote the viewer on the live socket → role.changed arrives. The dropped 'HACK' update
    // consumed this client's Yjs clocks 0..n, so later structs from the same Y.Doc would stay pending
    // on the server (Yjs' causal ordering) — a real client never edits as a viewer. Write from a
    // fresh connection for the same (now editor) user instead.
    await adapters.pubsub.publish(
      `doc:${docId}:events`,
      JSON.stringify({ type: 'permission.changed', payload: { userId: ids.viewer, role: 'editor' }, ts: Date.now() }),
    );
    const rc = await viewer.waitEvent('role.changed');
    expect((rc.payload as { role: string }).role).toBe('editor');
    const promoted = await new Client(url(await ticket(ids.viewer, 'editor'))).connect();
    promoted.insertText(' promoted');
    await until(() => owner.text().includes('promoted'));
    await promoted.close();

    await Promise.all([owner.close(), viewer.close()]);
  }, 20_000);
});
