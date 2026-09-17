import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { exportPKCS8, exportSPKI, generateKeyPair } from 'jose';
import type { FastifyInstance } from 'fastify';
import { createAdapters, type Adapters } from '@confluo/adapters';
import { buildApi } from './app.js';
import { seedDemo } from './seed.js';
import type { ApiDeps } from './types.js';

process.env.CONFLUO_DISABLE_RATE_LIMIT = '1';
process.env.REFRESH_REUSE_GRACE_MS = '0'; // strict reuse detection in tests

const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

let adapters: Adapters;
let app: FastifyInstance;
let deps: ApiDeps;

interface Session {
  token: string;
  cookie: string;
  user: { id: string; name: string; email: string };
}

async function register(email: string, name: string): Promise<Session> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email, password: 'password123!', displayName: name },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json() as { user: Session['user']; accessToken: string };
  const cookie = res.cookies.find((c) => c.name === 'confluo_refresh')!;
  return { token: body.accessToken, cookie: `${cookie.name}=${cookie.value}`, user: body.user };
}

const auth = (s: Session) => ({ authorization: `Bearer ${s.token}` });

beforeAll(async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'confluo-api-'));
  adapters = await createAdapters({
    CONFLUO_MODE: 'local',
    DATA_DIR: dir,
    API_URL: 'http://localhost:4000',
    SERVICE_TOKEN: 'test-service-token-123',
  } as NodeJS.ProcessEnv);
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
  deps = {
    adapters,
    logger: pino({ level: 'silent' }),
    config: {
      webUrl: 'http://localhost:3000',
      apiUrl: 'http://localhost:4000',
      syncUrl: 'ws://localhost:4000/sync',
      jwtPrivateKeyPem: await exportPKCS8(privateKey),
      jwtPublicKeyPem: await exportSPKI(publicKey),
      serviceToken: 'test-service-token-123',
      isProd: false,
    },
  };
  app = await buildApi(deps);
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app.close();
  await adapters.close();
});

describe('auth', () => {
  it('register → login → me, refresh rotation and reuse detection', async () => {
    const s = await register('carol@test.dev', 'Carol');
    const me = await app.inject({ method: 'GET', url: '/v1/me', headers: auth(s) });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.email).toBe('carol@test.dev');

    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'CAROL@test.dev', password: 'password123!' },
    });
    expect(login.statusCode).toBe(200);
    const bad = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'carol@test.dev', password: 'nope-nope-nope' } });
    expect(bad.statusCode).toBe(401);
    expect(bad.json().error.code).toBe('UNAUTHENTICATED');
    const unknown = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'nobody@test.dev', password: 'nope-nope-nope' } });
    expect(unknown.statusCode).toBe(401);

    // refresh rotates
    const r1 = await app.inject({ method: 'POST', url: '/v1/auth/refresh', headers: { cookie: s.cookie, origin: 'http://localhost:3000' } });
    expect(r1.statusCode).toBe(200);
    expect(typeof r1.json().accessToken).toBe('string');
    const c2 = r1.cookies.find((c) => c.name === 'confluo_refresh')!;
    expect(c2.value).not.toBe(s.cookie.split('=')[1]);

    // reuse of the old token revokes the family
    const reuse = await app.inject({ method: 'POST', url: '/v1/auth/refresh', headers: { cookie: s.cookie } });
    expect(reuse.statusCode).toBe(401);
    const afterReuse = await app.inject({ method: 'POST', url: '/v1/auth/refresh', headers: { cookie: `confluo_refresh=${c2.value}` } });
    expect(afterReuse.statusCode).toBe(401);

    // wrong origin rejected
    const s2 = await register('dave@test.dev', 'Dave');
    const badOrigin = await app.inject({ method: 'POST', url: '/v1/auth/refresh', headers: { cookie: s2.cookie, origin: 'http://evil.example' } });
    expect(badOrigin.statusCode).toBe(403);

    const noAuth = await app.inject({ method: 'GET', url: '/v1/me' });
    expect(noAuth.statusCode).toBe(401);
  });
});

describe('docs, permissions, sharing', () => {
  let alice: Session;
  let bob: Session;
  let viewer: Session;
  let docId: string;

  beforeAll(async () => {
    alice = await register('alice2@test.dev', 'Alice');
    bob = await register('bob2@test.dev', 'Bob');
    viewer = await register('vic@test.dev', 'Vic');
  });

  it('creates, lists, gets and renders a document', async () => {
    const created = await app.inject({ method: 'POST', url: '/v1/docs', headers: auth(alice), payload: { title: 'Spec' } });
    expect(created.statusCode).toBe(201);
    docId = created.json().doc.id;
    expect(created.json().doc.version).toBe(1);

    const list = await app.inject({ method: 'GET', url: '/v1/docs', headers: auth(alice) });
    expect(list.statusCode).toBe(200);
    expect(list.json().items.some((d: { id: string; role: string }) => d.id === docId && d.role === 'owner')).toBe(true);

    const get = await app.inject({ method: 'GET', url: `/v1/docs/${docId}`, headers: auth(alice) });
    expect(get.statusCode).toBe(200);
    expect(get.json().role).toBe('owner');
    expect(get.json().collaborators).toHaveLength(1);

    const json = await app.inject({ method: 'GET', url: `/v1/docs/${docId}/content?format=json`, headers: auth(alice) });
    expect(json.statusCode).toBe(200);
    expect(json.json().content.type).toBe('doc');
    expect(json.json().content.content[0].type).toBe('paragraph');
    expect(json.headers.etag).toBe('"0"');
    const html = await app.inject({ method: 'GET', url: `/v1/docs/${docId}/content?format=html`, headers: auth(alice) });
    expect(html.json().content).toContain('data-block-id=');

    // bob has no access → 404 (existence hidden)
    const nope = await app.inject({ method: 'GET', url: `/v1/docs/${docId}`, headers: auth(bob) });
    expect(nope.statusCode).toBe(404);
  });

  it('PATCH requires If-Match and detects stale versions', async () => {
    const noHeader = await app.inject({ method: 'PATCH', url: `/v1/docs/${docId}`, headers: auth(alice), payload: { title: 'X' } });
    expect(noHeader.statusCode).toBe(428);
    expect(noHeader.json().error.code).toBe('PRECONDITION_REQUIRED');

    const ok = await app.inject({ method: 'PATCH', url: `/v1/docs/${docId}`, headers: { ...auth(alice), 'if-match': '"1"' }, payload: { title: 'Spec v2' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().doc.version).toBe(2);

    const stale = await app.inject({ method: 'PATCH', url: `/v1/docs/${docId}`, headers: { ...auth(alice), 'if-match': '"1"' }, payload: { title: 'Spec v3' } });
    expect(stale.statusCode).toBe(412);
    expect(stale.json().error.code).toBe('VERSION_CONFLICT');
    expect(stale.json().error.details.current.title).toBe('Spec v2');
  });

  it('owner manages permissions; roles flow into tickets; viewers cannot edit', async () => {
    const put = await app.inject({ method: 'PUT', url: `/v1/docs/${docId}/permissions/${bob.user.id}`, headers: auth(alice), payload: { role: 'editor' } });
    expect(put.statusCode).toBe(200);
    expect(put.json().item.role).toBe('editor');

    const putViewer = await app.inject({ method: 'PUT', url: `/v1/docs/${docId}/permissions/${viewer.user.id}`, headers: auth(alice), payload: { role: 'viewer' } });
    expect(putViewer.statusCode).toBe(200);

    // owner cannot touch own row
    const self = await app.inject({ method: 'PUT', url: `/v1/docs/${docId}/permissions/${alice.user.id}`, headers: auth(alice), payload: { role: 'viewer' } });
    expect(self.statusCode).toBe(400);
    // cannot assign owner role (schema rejects)
    const ownerRole = await app.inject({ method: 'PUT', url: `/v1/docs/${docId}/permissions/${bob.user.id}`, headers: auth(alice), payload: { role: 'owner' } });
    expect(ownerRole.statusCode).toBe(400);
    // editor cannot manage permissions
    const bobManage = await app.inject({ method: 'GET', url: `/v1/docs/${docId}/permissions`, headers: auth(bob) });
    expect(bobManage.statusCode).toBe(403);

    const ticket = await app.inject({ method: 'POST', url: `/v1/docs/${docId}/socket-ticket`, headers: auth(bob) });
    expect(ticket.statusCode).toBe(200);
    expect(ticket.json().role).toBe('editor');
    expect(ticket.json().wsUrl).toBe('ws://localhost:4000/sync');
    // single use: stored in kv; getdel consumes it
    const stored = await adapters.kv.getdel(`ticket:${ticket.json().ticket}`);
    expect(JSON.parse(stored!)).toMatchObject({ userId: bob.user.id, docId, role: 'editor' });
    expect(await adapters.kv.get(`ticket:${ticket.json().ticket}`)).toBeNull();

    const viewerPatch = await app.inject({ method: 'PATCH', url: `/v1/docs/${docId}`, headers: { ...auth(viewer), 'if-match': '"2"' }, payload: { title: 'nope' } });
    expect(viewerPatch.statusCode).toBe(403);
    const viewerGet = await app.inject({ method: 'GET', url: `/v1/docs/${docId}/content?format=text`, headers: auth(viewer) });
    expect(viewerGet.statusCode).toBe(200);

    const list = await app.inject({ method: 'GET', url: `/v1/docs/${docId}`, headers: auth(alice) });
    expect(list.json().collaborators.map((c: { role: string }) => c.role)).toEqual(['owner', 'editor', 'viewer']);

    const lookup = await app.inject({ method: 'GET', url: '/v1/users/lookup?email=bob2@test.dev', headers: auth(alice) });
    expect(lookup.statusCode).toBe(200);
    expect(lookup.json().user.id).toBe(bob.user.id);
  });

  it('share links grant access and never downgrade', async () => {
    const link = await app.inject({ method: 'POST', url: `/v1/docs/${docId}/share-links`, headers: auth(alice), payload: { role: 'viewer' } });
    expect(link.statusCode).toBe(201);
    const token = (link.json().url as string).split('/share/')[1]!;

    // bob is editor; accepting a viewer link keeps editor
    const acceptBob = await app.inject({ method: 'POST', url: `/v1/share/${token}/accept`, headers: auth(bob) });
    expect(acceptBob.statusCode).toBe(200);
    expect(acceptBob.json().role).toBe('editor');

    // a new user gains viewer
    const erin = await register('erin@test.dev', 'Erin');
    const acceptErin = await app.inject({ method: 'POST', url: `/v1/share/${token}/accept`, headers: auth(erin) });
    expect(acceptErin.json()).toEqual({ docId, role: 'viewer' });

    const links = await app.inject({ method: 'GET', url: `/v1/docs/${docId}/share-links`, headers: auth(alice) });
    expect(links.json().items).toHaveLength(1);
    const revoke = await app.inject({ method: 'DELETE', url: `/v1/docs/${docId}/share-links/${link.json().id}`, headers: auth(alice) });
    expect(revoke.statusCode).toBe(204);
    const afterRevoke = await app.inject({ method: 'POST', url: `/v1/share/${token}/accept`, headers: auth(erin) });
    expect(afterRevoke.statusCode).toBe(404);
  });

  it('comments follow the matrix', async () => {
    const asViewer = await app.inject({ method: 'POST', url: `/v1/docs/${docId}/comments`, headers: auth(viewer), payload: { body: 'hi' } });
    expect(asViewer.statusCode).toBe(403);

    const anchor = Buffer.from([1, 2, 3, 4]).toString('base64');
    const created = await app.inject({
      method: 'POST',
      url: `/v1/docs/${docId}/comments`,
      headers: auth(bob),
      payload: { body: 'Looks good', anchorFrom: anchor, anchorTo: anchor, blockId: 'abc' },
    });
    expect(created.statusCode).toBe(201);
    const commentId = created.json().comment.id;
    expect(created.json().comment.anchorFrom).toBe(anchor);
    expect(created.json().comment.author.name).toBe('Bob');

    const tooBig = await app.inject({
      method: 'POST',
      url: `/v1/docs/${docId}/comments`,
      headers: auth(bob),
      payload: { body: 'x', anchorFrom: Buffer.alloc(300).toString('base64') },
    });
    expect(tooBig.statusCode).toBe(400);

    const reply = await app.inject({ method: 'POST', url: `/v1/docs/${docId}/comments`, headers: auth(alice), payload: { body: 'Thanks', parentId: commentId } });
    expect(reply.statusCode).toBe(201);

    const list = await app.inject({ method: 'GET', url: `/v1/docs/${docId}/comments`, headers: auth(viewer) });
    expect(list.statusCode).toBe(200);
    expect(list.json().items).toHaveLength(2);

    // viewer cannot resolve; owner can; author can edit body; viewer cannot edit body
    const viewerResolve = await app.inject({ method: 'PATCH', url: `/v1/comments/${commentId}`, headers: auth(viewer), payload: { resolved: true } });
    expect(viewerResolve.statusCode).toBe(403);
    const viewerEdit = await app.inject({ method: 'PATCH', url: `/v1/comments/${commentId}`, headers: auth(viewer), payload: { body: 'hack' } });
    expect(viewerEdit.statusCode).toBe(403);
    const authorEdit = await app.inject({ method: 'PATCH', url: `/v1/comments/${commentId}`, headers: auth(bob), payload: { body: 'Looks great' } });
    expect(authorEdit.statusCode).toBe(200);
    expect(authorEdit.json().comment.body).toBe('Looks great');
    const ownerResolve = await app.inject({ method: 'PATCH', url: `/v1/comments/${commentId}`, headers: auth(alice), payload: { resolved: true } });
    expect(ownerResolve.statusCode).toBe(200);
    expect(ownerResolve.json().comment.resolvedAt).not.toBeNull();

    const unresolvedOnly = await app.inject({ method: 'GET', url: `/v1/docs/${docId}/comments`, headers: auth(viewer) });
    expect(unresolvedOnly.json().items).toHaveLength(1);
    const withResolved = await app.inject({ method: 'GET', url: `/v1/docs/${docId}/comments?includeResolved=true`, headers: auth(viewer) });
    expect(withResolved.json().items).toHaveLength(2);

    const viewerDelete = await app.inject({ method: 'DELETE', url: `/v1/comments/${commentId}`, headers: auth(viewer) });
    expect(viewerDelete.statusCode).toBe(403);
    const authorDelete = await app.inject({ method: 'DELETE', url: `/v1/comments/${commentId}`, headers: auth(bob) });
    expect(authorDelete.statusCode).toBe(204);
  });

  it('uploads images through presign → local PUT → complete, and rejects spoofed types', async () => {
    const presign = await app.inject({
      method: 'POST',
      url: `/v1/docs/${docId}/assets/presign`,
      headers: auth(bob),
      payload: { mime: 'image/png', byteSize: PNG_1x1.byteLength, filename: 'dot.png' },
    });
    expect(presign.statusCode).toBe(200);
    const { assetId, uploadUrl } = presign.json() as { assetId: string; uploadUrl: string };
    expect(uploadUrl.startsWith('http://localhost:4000/v1/local-storage/')).toBe(true);

    const put = await app.inject({
      method: 'PUT',
      url: uploadUrl.replace('http://localhost:4000', ''),
      headers: { 'content-type': 'image/png' },
      payload: PNG_1x1,
    });
    expect(put.statusCode).toBe(204);

    const complete = await app.inject({ method: 'POST', url: `/v1/docs/${docId}/assets/${assetId}/complete`, headers: auth(bob) });
    expect(complete.statusCode).toBe(200);
    expect(complete.json().asset).toMatchObject({ id: assetId, width: 1, height: 1 });

    const getJson = await app.inject({ method: 'GET', url: `/v1/assets/${assetId}?json=1`, headers: auth(viewer) });
    expect(getJson.statusCode).toBe(200);
    const signed = getJson.json().url as string;
    const fetched = await app.inject({ method: 'GET', url: signed.replace('http://localhost:4000', '') });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.headers['content-type']).toContain('image/png');
    expect(fetched.rawPayload.equals(PNG_1x1)).toBe(true);

    const redirect = await app.inject({ method: 'GET', url: `/v1/assets/${assetId}`, headers: auth(viewer) });
    expect(redirect.statusCode).toBe(302);

    // viewer cannot presign
    const viewerPresign = await app.inject({
      method: 'POST',
      url: `/v1/docs/${docId}/assets/presign`,
      headers: auth(viewer),
      payload: { mime: 'image/png', byteSize: 10, filename: 'x.png' },
    });
    expect(viewerPresign.statusCode).toBe(403);

    // spoofed: claims jpeg, uploads png bytes
    const spoof = await app.inject({
      method: 'POST',
      url: `/v1/docs/${docId}/assets/presign`,
      headers: auth(bob),
      payload: { mime: 'image/jpeg', byteSize: PNG_1x1.byteLength, filename: 'fake.jpg' },
    });
    const spoofPut = await app.inject({
      method: 'PUT',
      url: (spoof.json().uploadUrl as string).replace('http://localhost:4000', ''),
      headers: { 'content-type': 'image/jpeg' },
      payload: PNG_1x1,
    });
    expect(spoofPut.statusCode).toBe(204);
    const spoofComplete = await app.inject({ method: 'POST', url: `/v1/docs/${docId}/assets/${spoof.json().assetId}/complete`, headers: auth(bob) });
    expect(spoofComplete.statusCode).toBe(415);
    expect(spoofComplete.json().error.code).toBe('UNSUPPORTED_MEDIA');
  });

  it('deletes documents and closes access', async () => {
    const created = await app.inject({ method: 'POST', url: '/v1/docs', headers: auth(alice), payload: {} });
    const id = created.json().doc.id;
    expect(created.json().doc.title).toBe('Untitled');
    const bobDelete = await app.inject({ method: 'DELETE', url: `/v1/docs/${id}`, headers: auth(bob) });
    expect(bobDelete.statusCode).toBe(404);
    const del = await app.inject({ method: 'DELETE', url: `/v1/docs/${id}`, headers: auth(alice) });
    expect(del.statusCode).toBe(204);
    const after = await app.inject({ method: 'GET', url: `/v1/docs/${id}`, headers: auth(alice) });
    expect(after.statusCode).toBe(404);
    const ticket = await app.inject({ method: 'POST', url: `/v1/docs/${id}/socket-ticket`, headers: auth(alice) });
    expect(ticket.statusCode).toBe(404);
  });

  it('internal routes need the service token', async () => {
    const noToken = await app.inject({ method: 'POST', url: '/v1/internal/tickets', payload: { userId: bob.user.id, docId } });
    expect(noToken.statusCode).toBe(401);
    const ok = await app.inject({
      method: 'POST',
      url: '/v1/internal/tickets',
      headers: { 'x-service-token': 'test-service-token-123' },
      payload: { userId: bob.user.id, docId },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().role).toBe('editor');
    const role = await app.inject({
      method: 'GET',
      url: `/v1/internal/docs/${docId}/role/${viewer.user.id}`,
      headers: { 'x-service-token': 'test-service-token-123' },
    });
    expect(role.json()).toEqual({ role: 'viewer' });
  });

  it('health endpoints and validation errors', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/healthz' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/v1/readyz' })).json()).toMatchObject({ ok: true, mode: 'local' });
    const bad = await app.inject({ method: 'POST', url: '/v1/auth/register', payload: { email: 'nope', password: 'short', displayName: '' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('VALIDATION_FAILED');
    expect(bad.headers['x-request-id']).toBeTruthy();
    const missing = await app.inject({ method: 'GET', url: '/v1/nothing-here' });
    expect(missing.statusCode).toBe(404);
  });
});

describe('seed', () => {
  it('is idempotent and produces alice/bob with a shared doc', async () => {
    const a = await seedDemo(deps);
    const b = await seedDemo(deps);
    expect(a.docId).toBe(b.docId);
    const login = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'bob@confluo.dev', password: 'password123!' } });
    expect(login.statusCode).toBe(200);
    const doc = await app.inject({ method: 'GET', url: `/v1/docs/${a.docId}`, headers: { authorization: `Bearer ${login.json().accessToken}` } });
    expect(doc.json().role).toBe('editor');
    const text = await app.inject({ method: 'GET', url: `/v1/docs/${a.docId}/content?format=text`, headers: { authorization: `Bearer ${login.json().accessToken}` } });
    expect(text.json().content).toContain('Welcome to Confluo');
  });
});
