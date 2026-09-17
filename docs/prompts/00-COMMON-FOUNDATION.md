# Confluo — Shared Engineering Foundation (Common Prompt)

> **Audience:** every developer's AI agent on this project. Place this file in the IDE context of all four developers. Individual role prompts (`01`–`04`) build on top of this document and never contradict it. If a role prompt and this document disagree, this document wins and the disagreement must be raised with the Tech Lead.
>
> **Status of this document:** normative. Words like MUST / MUST NOT / SHOULD follow RFC 2119 meaning.

---

## 0. How to use this document

1. Read it fully before generating any code.
2. Treat every section marked **[CONTRACT]** as a frozen interface. You may propose changes via a PR that edits this file, but you may not silently deviate.
3. When something is ambiguous, prefer the option that (a) preserves CRDT convergence, (b) enforces the permission matrix, (c) is simpler to test under network partition.
4. Do not invent alternative names for things named here (packages, tables, message types, roles, close codes, env vars). Consistency across four codebases is the point.

---

## 1. Mission and evaluation criteria

**Product:** Confluo, a Google-Docs-style real-time collaborative rich text editor. Multiple users edit the same document simultaneously without data loss or race conditions, over latent and unreliable networks, with full recovery after mid-session disconnects.

**The system is graded on four measurable axes.** Every design decision must be defensible against them:

| Axis | What the mentors will do | Our target |
|---|---|---|
| State consistency | Run N clients, partition the network (drop/delay/duplicate), edit concurrently on both sides, heal, then diff every client's document state | 100 % convergence: identical `Y.encodeStateVector` and identical rendered text on all clients after heal, every run |
| Presence latency | Measure time from a cursor/selection move on client A to it rendering on client B | p95 ≤ 150 ms on LAN, ≤ 300 ms with 100 ms injected RTT |
| CRDT memory footprint | Long-lived document with ~1 M operations including heavy deletion; measure encoded state size and server RSS | Encoded V2 state ≤ 5 MB for a 100 k-character document with 1 M ops history after compaction; server RSS per loaded doc ≤ 2× encoded size + 5 MB |
| Offline sync performance | Client goes offline, makes 10 k local ops, reconnects | Full bidirectional convergence ≤ 3 s after socket reopens |

---

## 2. Non-negotiable system rules

- **R1 — Single source of truth for content is the Yjs CRDT.** Document body lives in a `Y.Doc`. No REST endpoint writes document body. No Last-Write-Wins anywhere in the content path. LWW is disallowed even for "small" fields inside the document body.
- **R2 — Conflict resolution is Yjs.** Merging is done by Yjs's CRDT algorithm transported over the y-websocket sync protocol (`y-protocols/sync`). We do not implement OT. We do not write custom merge code.
- **R3 — Permission matrix (Section 9) is enforced on the server**, on both the HTTP API and the WebSocket sync server, independently. Client-side enforcement is UX only and is never trusted.
- **R4 — Soft locks are advisory for convergence but mandatory for UX.** A soft lock (Section 10) prevents *destructive concurrent writes on the same block* from the UI. If a lock is bypassed (latency window, bug, malicious client), the CRDT still converges. Locks never cause data loss.
- **R5 — Every client persists locally** with `y-indexeddb`. Losing the socket or the tab never loses typed content.
- **R6 — Every server-side write of document updates is append-only** (`document_updates`) and compacted into snapshots (`document_snapshots`). Never `UPDATE` a stored Yjs update in place.
- **R7 — Any HTTP save from the client is snapshot-based, debounced, mutex-guarded, abortable and sequence-checked** (Section 12). Never read the live DOM to build a save payload.
- **R8 — All cross-process contracts are typed once in `packages/shared`** (zod schemas + TS types + constants). Apps import them. No duplicated enums.
- **R9 — TypeScript `strict: true` everywhere.** No `any` outside `// eslint-disable-next-line` with a justification comment.
- **R10 — Secrets only via environment variables.** Never commit `.env`. `.env.example` is committed and complete.
- **R11 — No paid/Pro dependencies.** Everything must run from a fresh clone with `pnpm i && docker compose up && pnpm dev`.
- **R12 — Every feature ships with tests** at the level named in its role prompt. Untested distributed-systems code is rejected in review.
- **R13 — The server never trusts a client-provided user id, role, doc id, or timestamp.** Identity comes from the verified token. Time comes from the server clock.
- **R14 — Editor schema is defined once** in `packages/editor-schema` and used by both the browser editor and the server-side renderer. Schema drift = broken rendering = rejected PR.

---

## 3. Tech stack [CONTRACT]

| Layer | Choice | Notes |
|---|---|---|
| Language / runtime | TypeScript 5.x (strict), Node.js 22 LTS | ESM modules everywhere |
| Package manager / monorepo | pnpm 10 workspaces + Turborepo | `pnpm -r`, `turbo run build/test/lint` |
| CRDT core | **Yjs** (`yjs` ^13.6) | `gc: true` (default). V1 updates on the wire, V2 encoding for stored snapshots |
| Sync transport | **y-websocket protocol** (`y-websocket` client `WebsocketProvider`, `y-protocols` sync + awareness, `lib0` encoding) | The **server is ours**: `apps/sync`, built on `ws` + `y-protocols`, using the reference y-websocket server as a behavioral spec. The stock server is NOT used in production because it cannot enforce permissions |
| Presence | `y-protocols/awareness` | Cursor + selection via TipTap collaboration caret extension |
| Editor | **TipTap 3.x** (ProseMirror) with `@tiptap/extension-collaboration`, `@tiptap/extension-collaboration-caret` (named `-collaboration-cursor` in TipTap 2; use the 3.x name), `y-prosemirror` | Custom `BlockId` and `Image` extensions in `packages/editor-schema` |
| Frontend | **Next.js 15 (App Router) + React 19**, Tailwind CSS v4 | Two competing implementations (Dev 1, Dev 2); see role prompts |
| Client state / data | TanStack Query v5 for server data; role prompts choose UI-state lib | |
| HTTP API | **Fastify 5** + zod (via `fastify-type-provider-zod`), pino logging | `apps/api` |
| DB | **PostgreSQL 16** via Drizzle ORM + `postgres` driver, `drizzle-kit` migrations | |
| Cache / coordination | **Redis 7** via `ioredis` | Pub/sub fan-out between sync nodes, soft-lock registry, socket tickets, rate limits |
| Client persistence | **IndexedDB** via `y-indexeddb` | One database per document |
| Object storage | S3-compatible via `@aws-sdk/client-s3` (**MinIO** locally) | Images uploaded directly by the browser with presigned PUT |
| Auth | Email + password (Argon2id via `argon2`), JWT access tokens (`jose`, ES256, 15 min) + rotating refresh tokens in `httpOnly` cookie (30 days) | Socket auth via single-use tickets (Section 8.2) |
| Validation | zod, schemas shared from `packages/shared` | |
| Tests | Vitest (unit/integration), Playwright (e2e), custom `apps/harness` (distributed evaluation), Toxiproxy (network faults) | |
| Lint / format | ESLint 9 flat config + Prettier, shared from `packages/config` | |
| Local infra | `infra/docker-compose.yml`: postgres:16, redis:7, minio, toxiproxy | |

**Fixed local ports:** web 3000 · api 4000 · sync 4100 · postgres 5432 · redis 6379 · minio 9000 (console 9001) · toxiproxy 8474 (proxied sync 4101, proxied api 4001).

---

## 4. Monorepo layout and ownership [CONTRACT]

```
confluo/
├─ apps/
│  ├─ web/             Next.js app: landing, auth, dashboard, editor UI       → Dev 1 / Dev 2 (competing; each on own branch)
│  ├─ api/             Fastify HTTP API                                       → Dev 4
│  ├─ sync/            WebSocket sync server (Yjs, awareness, locks, RPC)     → Dev 3
│  └─ harness/         Distributed evaluation harness (partitions, latency)   → Dev 3
├─ packages/
│  ├─ shared/          zod schemas, TS types, permission matrix, protocol constants, error codes → Dev 4 (Dev 3 reviews)
│  ├─ editor-schema/   TipTap extension set, server-safe (no DOM)             → Dev 4
│  ├─ editor/          Browser collaboration client: providers, locks plugin, SaveController, UploadManager, React hooks → Dev 4
│  ├─ doc-render/      Y.Doc → ProseMirror JSON → HTML/text renderer (server) → Dev 3
│  └─ config/          eslint, prettier, tsconfig bases                       → Dev 4
├─ infra/
│  ├─ docker-compose.yml                                                      → Dev 3
│  └─ toxiproxy.json                                                          → Dev 3
├─ docs/               ADRs, this prompt set, runbooks
├─ turbo.json  pnpm-workspace.yaml  package.json  .env.example
```

npm scope: `@confluo/*` (e.g. `@confluo/shared`, `@confluo/editor`).

**Ownership rule:** you may open a PR against a package you do not own, but the owner must review it. Contract packages (`shared`, `editor-schema`) get a version bump comment in the PR description describing the change.

---

## 5. System architecture

```
                 ┌────────────────────────────────────────────────────────────┐
                 │                        Browser (apps/web)                  │
                 │  Next.js UI ── @confluo/editor ── TipTap ── y-prosemirror   │
                 │        │             │     │                                 │
                 │   TanStack Query     │     └── Y.Doc ── y-indexeddb (local) │
                 │        │             │            │                          │
                 └────────┼─────────────┼────────────┼──────────────────────────┘
                          │ HTTPS       │ wss (ticket)│ awareness + sync + rpc
                          ▼             ▼            ▼
   ┌──────────────────────────┐   ┌──────────────────────────────────────────┐
   │ apps/api (Fastify)       │   │ apps/sync (ws + y-protocols)  ×N nodes   │
   │ auth · docs · perms ·    │   │ ticket check on upgrade · permission gate │
   │ comments · assets ·      │◄──┤ doc lifecycle · write queue · compaction  │
   │ socket tickets · events  │   │ awareness relay · lock RPC · server events│
   └───┬─────────┬────────┬───┘   └───┬───────────────┬──────────────┬────────┘
       │         │        │           │               │              │
       ▼         ▼        ▼           ▼               ▼              ▼
   PostgreSQL   Redis   S3/MinIO   PostgreSQL       Redis          Redis pub/sub
   (users, docs,(tickets,(assets)  (document_       (locks,        (doc:{id}:updates,
   perms,       rate      ^        updates,          writer/         doc:{id}:awareness,
   comments,    limits)   │        document_         compaction      doc:{id}:events)
   snapshots idx)         │        snapshots)        leases)
                          └── browser PUTs directly via presigned URL
```

**Flow of a keystroke:** TipTap transaction → y-prosemirror applies to `Y.Doc` → `Y.Doc` emits update → (a) `y-indexeddb` stores locally, (b) `WebsocketProvider` sends `MESSAGE_SYNC/Update` → sync server verifies role ≥ editor → applies to in-memory `Y.Doc` → broadcasts to other sockets on this node → publishes to Redis `doc:{id}:updates` for other nodes → enqueues for append to `document_updates`.

**Flow of a reconnect:** provider reconnects with a fresh ticket → both sides exchange `SyncStep1` (state vectors) → each sends `SyncStep2` (missing updates) → converged. Updates made offline were already in IndexedDB and in the in-memory `Y.Doc`, so they are included automatically.

---

## 6. Data models [CONTRACT]

### 6.1 PostgreSQL schema (Drizzle; shown as SQL for precision)

```sql
CREATE EXTENSION IF NOT EXISTS citext;
CREATE TYPE doc_role AS ENUM ('viewer', 'commenter', 'editor', 'owner');

CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          citext UNIQUE NOT NULL,
  password_hash  text NOT NULL,                 -- argon2id
  display_name   text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 80),
  color          text NOT NULL,                 -- '#RRGGBB', assigned at signup from a 12-color palette
  avatar_url     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE refresh_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,             -- sha256 of the opaque token
  family_id   uuid NOT NULL,                    -- rotation family for reuse detection
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  user_agent  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE documents (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title       text NOT NULL DEFAULT 'Untitled' CHECK (length(title) <= 200),
  owner_id    uuid NOT NULL REFERENCES users(id),
  version     bigint NOT NULL DEFAULT 1,        -- metadata version for If-Match (title etc.), NOT content
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz                        -- soft delete; hard purge job after 30 days
);
CREATE INDEX documents_owner_idx ON documents(owner_id) WHERE deleted_at IS NULL;

CREATE TABLE document_permissions (
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        doc_role NOT NULL,
  granted_by  uuid NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, user_id)
);
CREATE INDEX document_permissions_user_idx ON document_permissions(user_id);
-- Invariant: the owner row (role='owner', user_id=documents.owner_id) always exists. Exactly one owner per doc.

CREATE TABLE share_links (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  role        doc_role NOT NULL CHECK (role <> 'owner'),
  token_hash  text NOT NULL UNIQUE,
  created_by  uuid NOT NULL REFERENCES users(id),
  expires_at  timestamptz,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Append-only log of Yjs updates (V1 encoding, exactly as received from the client).
CREATE TABLE document_updates (
  id          bigserial PRIMARY KEY,             -- global monotonic sequence; used as per-doc ordering too
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  update      bytea NOT NULL,
  byte_size   int NOT NULL,
  origin_user uuid,                              -- null for system/merge writes
  node_id     text NOT NULL,                     -- sync node that received it
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX document_updates_doc_idx ON document_updates(document_id, id);

-- Compacted full state. V2 encoding. Newest row per doc is authoritative baseline.
CREATE TABLE document_snapshots (
  id            bigserial PRIMARY KEY,
  document_id   uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  upto_update_id bigint NOT NULL,               -- all document_updates.id <= this are included
  state         bytea NOT NULL,                 -- Y.encodeStateAsUpdateV2(doc)
  state_vector  bytea NOT NULL,                 -- Y.encodeStateVector(doc)
  byte_size     int NOT NULL,
  char_count    int NOT NULL,                   -- rendered text length, for metrics
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX document_snapshots_doc_idx ON document_snapshots(document_id, id DESC);

CREATE TABLE comments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  author_id   uuid NOT NULL REFERENCES users(id),
  parent_id   uuid REFERENCES comments(id) ON DELETE CASCADE,   -- replies; one level deep
  anchor_from bytea,                             -- Y.RelativePosition (encoded), null for reply
  anchor_to   bytea,
  block_id    text,                              -- data-block-id at creation, for fallback rendering
  body        text NOT NULL CHECK (length(body) BETWEEN 1 AND 5000),
  resolved_at timestamptz,
  resolved_by uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);
CREATE INDEX comments_doc_idx ON comments(document_id) WHERE deleted_at IS NULL;

CREATE TABLE assets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  uploader_id uuid NOT NULL REFERENCES users(id),
  storage_key text NOT NULL UNIQUE,              -- 'docs/{document_id}/{asset_id}.{ext}'
  mime        text NOT NULL,                     -- allowlist: image/png, image/jpeg, image/webp, image/gif
  byte_size   int NOT NULL CHECK (byte_size > 0 AND byte_size <= 10485760),
  width       int, height int,
  status      text NOT NULL DEFAULT 'pending',   -- pending | ready | orphaned
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  id          bigserial PRIMARY KEY,
  actor_id    uuid,
  action      text NOT NULL,     -- 'doc.create','doc.delete','perm.set','perm.remove','share.create','auth.login', ...
  target_type text NOT NULL,
  target_id   text NOT NULL,
  metadata    jsonb NOT NULL DEFAULT '{}',
  ip          inet,
  created_at  timestamptz NOT NULL DEFAULT now()
);
```

### 6.2 Yjs document schema

- One `Y.Doc` per document. `doc.guid = documents.id`.
- Content: `doc.getXmlFragment('content')` — TipTap collaboration `field: 'content'`. **Do not use the TipTap default field name.**
- `doc.getMap('meta')` is reserved and currently unused. Title is metadata in PostgreSQL, not in the CRDT (it is edited from a form field with `If-Match`, Section 12).
- Every top-level block node (paragraph, heading, bulletList, orderedList, image) carries the attribute `blockId` (`data-block-id` in HTML): 12-char nanoid, assigned on creation by the `BlockId` extension, never re-assigned, never copied on split (the new block gets a new id).
- Undo/redo: `Collaboration` extension's `Y.UndoManager` scoped to the local client (`trackedOrigins` = the local y-prosemirror binding). TipTap `History` extension is disabled.

### 6.3 Awareness state schema [CONTRACT]

Each client sets exactly this object via `awareness.setLocalState`:

```ts
type AwarenessState = {
  user: { id: string; name: string; color: string; avatarUrl?: string };
  role: 'viewer' | 'commenter' | 'editor' | 'owner';
  cursor: { anchor: RelativePositionJSON; head: RelativePositionJSON } | null; // managed by CollaborationCaret
  lock: { blockId: string; expiresAt: number } | null;   // mirror of the server-granted lock, for rendering
  status: 'active' | 'idle';                             // idle after 60 s without input
  clientTs: number;                                      // Date.now() at last local change (for latency measurement only)
};
```

Awareness updates are throttled client-side to at most one every 33 ms (rAF-aligned). Awareness heartbeat every 15 s; the server marks a client offline after 30 s of silence (y-protocols default) and removes it.

### 6.4 Redis keys [CONTRACT]

| Key | Type | TTL | Purpose |
|---|---|---|---|
| `ticket:{ticket}` | string (JSON `{userId, docId, role, iat}`) | 60 s | Single-use WebSocket ticket. `GETDEL` on upgrade |
| `lock:{docId}:{blockId}` | string `{userId}\|{clientId}` | 30 s (renewed by heartbeat) | Soft lock holder |
| `locks:{docId}` | hash blockId → JSON `{userId, clientId, name, color, expiresAt}` | — (entries cleaned by holder node) | Fast enumeration for `lock.list` and reconnect |
| `doc:{docId}:updates` | pub/sub channel | — | Raw Yjs update bytes + origin node id (binary, lib0-encoded) |
| `doc:{docId}:awareness` | pub/sub channel | — | Awareness update bytes |
| `doc:{docId}:events` | pub/sub channel | — | JSON server events (Section 8.5) published by API or sync nodes |
| `doc:{docId}:compact` | string nodeId | 60 s | Compaction lease |
| `rl:{scope}:{key}` | counters | window | Rate limiting |

### 6.5 IndexedDB (client)

`new IndexeddbPersistence(\`confluo-doc-${docId}\`, ydoc)`. One database per document. Cleared when the user loses access (403 on ticket) or explicitly signs out.

---

## 7. HTTP API contract [CONTRACT]

Base URL: `http://localhost:4000/v1`. JSON only. Auth: `Authorization: Bearer <accessToken>` on every route except `auth/*` and `healthz`. Every response includes `x-request-id`.

**Error envelope (all non-2xx):**
```json
{ "error": { "code": "DOC_NOT_FOUND", "message": "Human readable", "details": {}, "requestId": "…" } }
```
Error codes (in `@confluo/shared`): `VALIDATION_FAILED`, `UNAUTHENTICATED`, `FORBIDDEN`, `DOC_NOT_FOUND`, `USER_NOT_FOUND`, `VERSION_CONFLICT`, `RATE_LIMITED`, `PAYLOAD_TOO_LARGE`, `UNSUPPORTED_MEDIA`, `TICKET_INVALID`, `INTERNAL`.

| Method & path | Min role | Request | Response | Notes |
|---|---|---|---|---|
| `POST /auth/register` | — | `{email, password, displayName}` | `201 {user, accessToken}` + refresh cookie | password ≥ 10 chars; Argon2id |
| `POST /auth/login` | — | `{email, password}` | `200 {user, accessToken}` + refresh cookie | constant-time on unknown email |
| `POST /auth/refresh` | cookie | — | `200 {accessToken}` + rotated cookie | reuse of a rotated token revokes the family |
| `POST /auth/logout` | cookie | — | `204` | revokes family |
| `GET /me` | any | — | `{user}` | |
| `GET /docs` | any | `?cursor&limit` | `{items: DocSummary[], nextCursor}` | docs where the user has any role; each item includes `role` |
| `POST /docs` | any | `{title?}` | `201 {doc}` | creates owner permission row; initial empty snapshot |
| `GET /docs/:id` | viewer | — | `{doc: {id,title,version,ownerId,createdAt,updatedAt}, role, collaborators: [{id,name,color,role}]}` | |
| `GET /docs/:id/content` | viewer | `?format=json\|html\|text` | `{format, version:{uptoUpdateId}, content}` | rendered server-side from CRDT via `@confluo/doc-render` |
| `PATCH /docs/:id` | editor | `{title}` + header `If-Match: "<version>"` | `200 {doc}` | `412 VERSION_CONFLICT` on mismatch; increments `version` |
| `DELETE /docs/:id` | owner | — | `204` | soft delete; publishes `doc.deleted` event; sync server closes sockets with 4004 |
| `POST /docs/:id/socket-ticket` | viewer | — | `{ticket, wsUrl, role, expiresAt}` | ticket single-use, 60 s |
| `GET /docs/:id/permissions` | owner | — | `{items: [{user, role, grantedBy, createdAt}]}` | |
| `PUT /docs/:id/permissions/:userId` | owner | `{role}` | `200 {item}` | cannot change the owner's own row; publishes `permission.changed` |
| `DELETE /docs/:id/permissions/:userId` | owner | — | `204` | publishes `permission.changed {role: null}` |
| `POST /docs/:id/share-links` | owner | `{role, expiresInHours?}` | `201 {id, url, role, expiresAt}` | url = `${WEB_URL}/share/${token}`; raw token returned once |
| `DELETE /docs/:id/share-links/:linkId` | owner | — | `204` | |
| `POST /share/:token/accept` | any | — | `{docId, role}` | upserts permission (never downgrades an existing higher role) |
| `GET /docs/:id/comments` | viewer | `?includeResolved` | `{items: Comment[]}` | anchors returned base64 |
| `POST /docs/:id/comments` | commenter | `{body, anchorFrom?, anchorTo?, blockId?, parentId?}` | `201 {comment}` | publishes `comment.created` |
| `PATCH /comments/:id` | commenter (author) or owner | `{body?, resolved?}` | `200 {comment}` | |
| `DELETE /comments/:id` | author or owner | — | `204` | |
| `POST /docs/:id/assets/presign` | editor | `{mime, byteSize, filename}` | `{assetId, uploadUrl, method:'PUT', headers, expiresAt}` | mime allowlist; ≤ 10 MB |
| `POST /docs/:id/assets/:assetId/complete` | editor | — | `{asset: {id, url, width, height}}` | server HEADs the object, verifies size & magic bytes, sets `ready` |
| `GET /assets/:assetId` | viewer of the asset's doc | — | `302` to a 10-min signed URL | |
| `GET /users/lookup?email=` | any | | `{user: {id, name, color}}` or 404 | for the share dialog; rate limited 20/min |
| `GET /healthz`, `GET /readyz` | — | | | |

**Rate limits (per user or IP):** auth 10/min, presign 30/min, comments 60/min, general 600/min.

**Internal (service-to-service, `x-service-token` header, not exposed publicly):**
`POST /internal/events` (sync → api, e.g. lock analytics), `GET /internal/docs/:id/role/:userId` (sync → api role re-check fallback if Redis miss).

---

## 8. WebSocket sync protocol [CONTRACT]

### 8.1 Endpoint
`ws://localhost:4100/v1/docs/{docId}?ticket={ticket}` — `WebsocketProvider(serverUrl='ws://localhost:4100/v1/docs', roomname=docId, ydoc, { params: { ticket } })`.

### 8.2 Handshake
1. Client calls `POST /v1/docs/:id/socket-ticket` (HTTP, bearer auth) → `{ticket}`.
2. Client opens the socket with `?ticket=`.
3. Server, **during the HTTP upgrade** (before `ws` accepts): `GETDEL ticket:{ticket}`. Missing/expired → respond `401` and destroy the socket. Doc id mismatch → `403`. Doc deleted → `404`. Otherwise attach `{userId, docId, role, clientId}` to the connection.
4. Server sends `SyncStep1` and the current awareness states. Client replies per y-protocols.
5. A ticket is single use. **On every reconnect the client fetches a new ticket.**

### 8.3 Message framing
Binary frames. `lib0/encoding`. First `varUint` = message type:

| Type | Name | Direction | Payload |
|---|---|---|---|
| `0` | `MESSAGE_SYNC` | both | y-protocols sync: sub-type `0` SyncStep1, `1` SyncStep2, `2` Update |
| `1` | `MESSAGE_AWARENESS` | both | y-protocols awareness update |
| `3` | `MESSAGE_QUERY_AWARENESS` | client→server | — |
| `10` | `MESSAGE_RPC` | client→server | `varString` JSON `{ id: string, method: string, params: object }` |
| `11` | `MESSAGE_RPC_RESULT` | server→client | `varString` JSON `{ id, ok: true, result } \| { id, ok: false, error: { code, message } }` |
| `12` | `MESSAGE_SERVER_EVENT` | server→client | `varString` JSON `{ type, payload, ts }` |

Max inbound frame size: **2 MiB**. Larger → close `1009`. Inbound rate: 200 messages / s per connection sustained (token bucket 400) → exceed: close `4029`.

### 8.4 Permission gate (server-side, per message)

| Message | viewer | commenter | editor | owner |
|---|---|---|---|---|
| SYNC/SyncStep1 (request state) | ✅ | ✅ | ✅ | ✅ |
| SYNC/SyncStep2 (send state) | ❌ dropped | ❌ dropped | ✅ | ✅ |
| SYNC/Update | ❌ dropped + `error` event `FORBIDDEN_EDIT` (once per 10 s) | ❌ dropped | ✅ | ✅ |
| AWARENESS (presence, cursor) | ✅ (lock field ignored/stripped) | ✅ (lock stripped) | ✅ | ✅ |
| RPC `lock.*` | ❌ `FORBIDDEN` | ❌ | ✅ | ✅ |
| RPC `annotation.broadcast` | ❌ | ✅ | ✅ | ✅ |
| RPC `admin.*` | ❌ | ❌ | ❌ | ✅ |
| Receives SYNC from server | ✅ | ✅ | ✅ | ✅ |
| Receives AWARENESS from server | ✅ | ✅ | ✅ | ✅ |

"Dropped" = never applied to the server `Y.Doc`, never broadcast, never persisted. Viewers and commenters still receive `SyncStep2`/updates so they can read.

**Live role changes:** the sync server subscribes to `doc:{id}:events`; on `permission.changed {userId, role}` it updates every connection of that user in that doc immediately. Role → `null` ⇒ close `4003`. Downgrade below editor ⇒ subsequent updates dropped, locks released, `role.changed` event sent so the client switches the editor to read-only.

### 8.5 RPC methods and server events

RPC (client → server, answered with `MESSAGE_RPC_RESULT`):

| Method | Params | Result |
|---|---|---|
| `lock.acquire` | `{ blockId }` | `{ granted: boolean, holder: {userId, clientId, name, color}, expiresAt }` |
| `lock.release` | `{ blockId }` | `{ released: boolean }` |
| `lock.heartbeat` | `{ blockIds: string[] }` | `{ renewed: string[], lost: string[] }` |
| `lock.list` | `{}` | `{ locks: Array<{blockId, userId, clientId, name, color, expiresAt}> }` |
| `annotation.broadcast` | `{ kind: 'comment.focus' \| 'comment.typing', commentId?, blockId? }` | `{}` (ephemeral fan-out as server event `annotation`) |
| `admin.kick` | `{ userId }` | `{ closed: number }` |
| `admin.forceSnapshot` | `{}` | `{ snapshotId, byteSize }` |
| `admin.broadcast` | `{ message }` | `{}` |
| `ping` | `{ t }` | `{ t, serverTs }` (latency measurement) |

Server events (`MESSAGE_SERVER_EVENT.type`): `lock.changed {blockId, holder|null, expiresAt}`, `role.changed {role}`, `permission.changed {userId, role}`, `comment.created|updated|deleted {comment}`, `annotation {from, kind, …}`, `doc.deleted {}`, `kicked {reason}`, `error {code, message}`, `admin.broadcast {message}`.

### 8.6 Close codes

`1000` normal · `1009` frame too large · `4001` unauthenticated (bad/expired ticket) · `4003` forbidden / access revoked · `4004` doc not found or deleted · `4008` server shutting down (client reconnects) · `4029` rate limited · `4030` kicked by owner.

Client reconnect policy: y-websocket exponential backoff (min 100 ms, max 10 s, jitter). **Do not reconnect** on `4001`, `4003`, `4004`, `4030`; surface the reason in the UI.

---

## 9. Permission matrix [CONTRACT]

Roles are strictly ordered: `viewer < commenter < editor < owner`. "Min role" means that role or any higher one. Implemented once as `can(role, action)` in `@confluo/shared/permissions.ts` and used by API, sync server, and UI.

| Capability | viewer | commenter | editor | owner |
|---|---|---|---|---|
| HTTP: fetch doc metadata & content (JSON/HTML/text) | ✅ | ✅ | ✅ | ✅ |
| HTTP: list/read comments | ✅ | ✅ | ✅ | ✅ |
| HTTP: post comments / reply / resolve own | ❌ | ✅ | ✅ | ✅ |
| HTTP: edit title / metadata (`PATCH /docs/:id`) | ❌ | ❌ | ✅ | ✅ |
| HTTP: upload assets (presign/complete) | ❌ | ❌ | ✅ | ✅ |
| HTTP: manage permissions, share links | ❌ | ❌ | ❌ | ✅ |
| HTTP: delete document | ❌ | ❌ | ❌ | ✅ |
| WS: connect to room, receive doc state & remote cursors | ✅ | ✅ | ✅ | ✅ |
| WS: send own presence/cursor (awareness) | ✅ | ✅ | ✅ | ✅ |
| WS: send CRDT updates (edits) | ❌ ignored | ❌ ignored | ✅ | ✅ |
| WS: dispatch comment/annotation events | ❌ | ✅ | ✅ | ✅ |
| WS: acquire soft locks | ❌ | ❌ | ✅ | ✅ |
| WS: admin RPC (kick, force snapshot, broadcast) | ❌ | ❌ | ❌ | ✅ |

Actions enum: `doc.read`, `doc.comment`, `doc.edit`, `doc.uploadAsset`, `doc.managePermissions`, `doc.delete`, `ws.connect`, `ws.presence`, `ws.edit`, `ws.annotate`, `ws.lock`, `ws.admin`.

---

## 10. Soft-lock protocol [CONTRACT]

**Purpose:** prevent two editors from simultaneously mutating the same *block* (top-level node) so that intent is preserved and destructive overlapping edits are avoided. Convergence does not depend on locks (R4).

**Definitions**
- *Block:* a direct child of the `content` fragment, identified by `blockId`.
- *Holder:* `userId`. All tabs of the same user share the lock; `clientId` records the most recent claimant.
- *Lease:* 30 s TTL in Redis, renewed by `lock.heartbeat` every 10 s while the holder's selection is inside the block.

**Client behaviour (editors and owners only)**
1. On every selection change, compute the set of blocks touched by the selection (`$from.blockId … $to.blockId`). Multi-block selections attempt to lock every touched block; if any is denied, the selection is allowed but editing is blocked and the user is told which block is held.
2. When the touched set changes: send `lock.acquire` for newly entered blocks and `lock.release` for exited blocks. Do not spam: coalesce to one RPC per animation frame.
3. **Optimistic editing:** typing is allowed immediately while `lock.acquire` is in flight (latency ≤ RTT). If the result is `granted: false`, the block becomes read-only for this client until `lock.changed` reports it free. Edits that slipped into the latency window are fine (CRDT).
4. Mirror the granted lock into `awareness.lock` for rendering by peers.
5. Release on: selection leaving the block, editor blur > 5 s, tab hidden > 30 s, `beforeunload`, disconnect (server-side cleanup covers this).
6. Enforcement is a ProseMirror plugin (`filterTransaction`): reject any transaction that has a document-changing step whose range intersects a block held by another user. Always allow transactions with meta `y-sync$` (remote updates), selection-only transactions, and awareness/decoration-only transactions. Structural operations spanning a locked block boundary (join, delete-across, lift) are rejected with a toast: "Paragraph is being edited by {name}".
7. Rendering: locked-by-other blocks get class `is-locked` with a left-edge bar and a small name chip in the holder's color, `contenteditable` remains true (enforcement is via filterTransaction to avoid breaking cursors).

**Server behaviour**
- `lock.acquire`: `SET lock:{doc}:{block} "{userId}|{clientId}" NX PX 30000`. If exists and holder userId ≠ caller → `granted:false` with holder info. If same user → refresh TTL, update clientId, `granted:true`. On grant: `HSET locks:{doc}`, publish `lock.changed` on `doc:{id}:events` (fan-out to all nodes).
- `lock.heartbeat`: for each blockId, if holder userId = caller → `PEXPIRE 30000`; else report `lost`.
- `lock.release` and on connection close: release every lock whose clientId = this connection **and** the user has no other connection to the doc on any node currently claiming it (check `locks:{doc}` clientId). Publish `lock.changed {holder:null}`.
- Expired keys: a Redis keyspace listener (`__keyevent@0__:expired`) OR a 5 s sweeper on the node that granted the lock removes the hash entry and publishes `lock.changed {holder:null}`. Implement the sweeper (simpler, deterministic); keyspace notifications are optional.
- On role downgrade below editor: release all of that user's locks.

---

## 11. Persistence, snapshotting and recovery [CONTRACT]

### 11.1 Server-side
- **Load (first connection on a node):** newest `document_snapshots` row → `Y.applyUpdateV2(doc, state)`; then `document_updates WHERE document_id=$1 AND id > upto_update_id ORDER BY id` → `Y.applyUpdate` each (or `Y.mergeUpdates` in chunks of 256). Load is memoized per node (`Map<docId, Promise<LoadedDoc>>`) so concurrent joins share one load.
- **Write path:** an update received **directly from a client** (not from Redis) is (1) applied to the in-memory doc, (2) broadcast to local sockets, (3) published to `doc:{id}:updates` with `nodeId`, (4) pushed to a per-doc write buffer flushed every **200 ms or 64 items or 512 KiB**, whichever first, as one multi-row `INSERT`. Updates received via Redis are applied + broadcast but **not** persisted (the receiving node persists them). Yjs update application is idempotent, so duplicates are harmless.
- **Compaction:** triggered when, since the last snapshot, any of: 500 updates, 2 MiB of update bytes, or 5 min elapsed with at least one update. Acquire `doc:{id}:compact` lease. In one transaction: insert snapshot (`encodeStateAsUpdateV2`, `encodeStateVector`, `upto_update_id` = max persisted id at compaction start), then `DELETE FROM document_updates WHERE document_id=$1 AND id <= upto_update_id`. Also compact on graceful unload.
- **Unload:** 60 s after the last connection closes, flush buffer, compact if dirty, drop the in-memory doc. Under memory pressure (`process.memoryUsage().rss` > 80 % of `SYNC_MAX_RSS_MB`), unload least-recently-active idle docs first.
- **Durability model:** updates are durable in PostgreSQL within ~200 ms of receipt. If a sync node crashes before flushing, the originating clients still hold those updates in memory and IndexedDB and re-deliver them on reconnect via state-vector diff. Document this in the runbook.
- **Deleted text:** Yjs keeps tombstones for deleted content. `gc: true` ensures deleted content payloads are freed and tombstones are merged. Snapshots use V2 encoding (run-length compressed). The memory harness verifies the footprint target in Section 1.

### 11.2 Client-side
- `y-indexeddb` persists every local and remote update; on page load the doc is hydrated from IndexedDB *before* the socket connects, so the user can read and edit immediately (offline-first).
- Reconnect = y-protocols step 1/2 exchange; no custom merge logic.
- The UI exposes `connectionState: 'connecting' | 'connected' | 'reconnecting' | 'offline' | 'denied'` and `unsyncedChanges: boolean` (true when local updates exist that the server has not acknowledged via a subsequent `SyncStep2`/sync completion — computed by counting local `update` events since the provider's last `synced=true` transition).
- If the server responds `4003`/`4004`, the client clears the IndexedDB database for that doc and shows the reason.

---

## 12. Client data-integrity rules [CONTRACT]

These apply to **every HTTP write from the editor UI** (title/metadata save, comment create, asset complete) and to any background task that touches the document (image upload).

**12.1 Snapshot, never live DOM.** A save payload is built from an immutable snapshot taken synchronously at schedule time: `structuredClone(editor.state.doc.toJSON())` for content-derived data or the form's committed value for metadata. Reading `editor.view.dom`, `innerHTML`, or `contentEditable` nodes for persistence is forbidden.

**12.2 SaveController (in `@confluo/editor`), one instance per resource:**
```ts
interface SaveController<TSnapshot, TResult> {
  schedule(): void;             // debounce 1500 ms trailing, maxWait 10 000 ms
  flush(): Promise<void>;       // immediate; used on blur/beforeunload/visibilitychange
  state: 'idle' | 'pending' | 'saving' | 'error';
}
// flush algorithm:
//  1. await mutex.acquire()                       (async-mutex; at most one request in flight per resource)
//  2. const seq = ++lastScheduledSeq
//  3. const snapshot = takeSnapshot()             (synchronous, immutable)
//  4. if (deepEqual(snapshot, lastPersistedSnapshot)) { release; return }
//  5. inflight?.abort(); inflight = new AbortController()
//  6. try { const res = await save(snapshot, { signal: inflight.signal, ifMatch: currentVersion }) }
//     catch AbortError → release; return          (a newer flush superseded us)
//     catch 412 VERSION_CONFLICT → refetch resource; if no newer local snapshot pending, adopt server value; else re-run flush with new version
//  7. if (seq < lastAppliedSeq) { release; return }   // invalidation flag: stale response, discard
//  8. lastAppliedSeq = seq; currentVersion = res.version; lastPersistedSnapshot = snapshot
//  9. release()
```
The invalidation check in step 7 guarantees a delayed response from an older save can never overwrite newer client state.

**12.3 Background uploads while typing (UploadManager):**
- On paste/drop of an image, insert an `image` node **immediately** with attrs `{ src: <object URL>, uploadId: nanoid(), assetId: null, status: 'uploading', alt }`. Typing continues.
- Upload runs in the background with its own `AbortController`; abort when the node is deleted (`uploadId` no longer present in `editor.state.doc`) or on doc close.
- On completion, locate the node **by `uploadId` attribute by walking `editor.state.doc`**, never by a saved DOM node or position, and update attrs `{ src: asset.url, assetId, status: 'ready' }` in one transaction. If the node is gone, call `DELETE /assets/:id` (owner cleanup) — Dev 4 implements an orphan sweeper as a fallback.
- Remote peers render `status: 'uploading'` nodes as a skeleton placeholder (they cannot access the uploader's object URL). Only the uploader sees the local preview.
- `beforeunload` with uploads in progress prompts the user.

**12.4 Metadata versioning:** `documents.version` + `If-Match`. Server returns `412 VERSION_CONFLICT` with the current resource; never merges silently.

---

## 13. Security baseline [CONTRACT]

- Passwords: Argon2id (m=64 MiB, t=3, p=1). Never log. Rate limit auth routes; constant-time compare; identical error for unknown email and wrong password.
- Access token: ES256 JWT, 15 min, claims `{sub, name, iat, exp, jti}`. Refresh token: 32 random bytes, stored hashed, rotated on every refresh; reuse detection revokes the whole family. Cookie: `httpOnly; Secure (prod); SameSite=Lax; Path=/v1/auth`.
- CSRF: state-changing routes require the bearer header (not cookie auth), so CSRF is not applicable except `/auth/refresh` and `/auth/logout`, which check `Origin` against `WEB_URL`.
- CORS: allow only `WEB_URL`, credentials true.
- WebSocket: check `Origin` on upgrade; tickets single-use, 60 s, bound to `{userId, docId}`; message-size and rate limits (8.3); max 20 sockets per user per doc.
- Input: every body/query/param validated by zod from `@confluo/shared`; unknown keys stripped.
- Uploads: browser PUTs directly to storage via presigned URL with `Content-Type` and `Content-Length` conditions; server verifies magic bytes and dimensions on `complete`; objects are private; reads via short-lived signed URLs; `Content-Disposition: inline` with mime allowlist; never serve user uploads from the API origin.
- Rendering: server-rendered HTML (`/content?format=html`) is produced from the ProseMirror schema (no raw HTML nodes exist in the schema), and additionally passed through an allowlist sanitizer before response.
- Headers: `@fastify/helmet`; Next.js CSP with nonces for scripts, `img-src` restricted to self + storage origin + `blob:` + `data:` (for local previews only).
- Audit log for auth, permission, share-link, delete, admin RPC events.
- Dependencies: `pnpm audit --prod` in CI must have zero high/critical.
- Secrets: `.env.example` lists `DATABASE_URL, REDIS_URL, S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY, S3_SECRET_KEY, JWT_PRIVATE_KEY, JWT_PUBLIC_KEY, WEB_URL, API_URL, SYNC_URL, SERVICE_TOKEN, SYNC_NODE_ID, SYNC_MAX_RSS_MB`.

---

## 14. Performance budgets

| Item | Budget |
|---|---|
| Cursor/selection propagation | p95 ≤ 150 ms LAN, ≤ 300 ms at 100 ms RTT |
| Update propagation (keystroke → peer render) | p95 ≤ 200 ms LAN |
| Sync server: 50 concurrent editors on one doc | CPU < 50 % of one core, no message backlog > 1 s |
| Encoded state after compaction | ≤ 5 MB for 100 k chars / 1 M ops |
| Offline resync of 10 k updates | ≤ 3 s |
| Landing page (Lighthouse mobile) | Performance ≥ 95, Accessibility 100, Best Practices ≥ 95, SEO ≥ 95; LCP ≤ 1.5 s, CLS ≤ 0.05, TBT ≤ 150 ms |
| Editor route | time-to-editable ≤ 2 s on simulated 4G; route JS ≤ 350 kB gzipped |
| API p95 latency (local) | ≤ 50 ms for reads, ≤ 120 ms for writes |

---

## 15. Testing and Definition of Done

**Test layers**
1. Unit (Vitest): pure logic — permission matrix, lock state machine, SaveController, gate, compaction trigger, RelativePosition helpers.
2. Integration (Vitest + docker compose services): API routes against real PostgreSQL/Redis/MinIO; sync server with real `WebsocketProvider` clients in Node (`ws` polyfill).
3. Chaos / evaluation (`apps/harness`): partition, latency, duplication, reorder via Toxiproxy; convergence assertions; latency percentiles; memory measurements; JSON + Markdown report.
4. E2E (Playwright): two browser contexts editing the same doc; cursors visible; lock badge visible; reload while offline keeps text; viewer cannot type.

**Definition of Done for any PR**
- [ ] `pnpm lint && pnpm typecheck && pnpm test` green in CI
- [ ] New behaviour covered at the layer named in the role prompt
- [ ] No contract change without editing `packages/shared` and this document
- [ ] Logs are structured (pino), no `console.log` in app code
- [ ] Errors use the shared error envelope / close codes
- [ ] README or `docs/` updated if setup or runbook changed
- [ ] Reviewed by the owning developer of every touched package

**Git workflow:** trunk `main` protected. Branches `dev{n}/{short-topic}` (e.g. `dev3/sync-compaction`). Conventional Commits (`feat(sync): …`, `fix(api): …`). Squash-merge. PR template includes: what, why, how tested, contract changes.

---

## 16. Coordination milestones

| Milestone | Due | Owner(s) | Gate |
|---|---|---|---|
| M0 Contracts | Day 2 | Dev 4 (+ Dev 3 review) | `packages/shared`, `packages/editor-schema` published; `docker-compose` up; mock API (MSW) and dev sync server usable by Dev 1/2 |
| M1 Vertical slice | End of week 1 | all | login → create doc → two browsers edit the same paragraph list → cursors visible → reload restores |
| M2 Feature complete | End of week 2 | all | permissions, comments, images, locks, share links, offline indicator, landing page candidates |
| M3 Hardening | End of week 3 | Dev 3 lead | harness report meets Section 1 targets; security checklist; runbooks; frontend selection (Dev 1 vs Dev 2) |

Until M0 lands, frontend developers code against the mocked API and a local `npx y-websocket` dev server (`HOST=localhost PORT=4100`), switching to `apps/sync` when available. Interface shapes never change between the mock and the real thing because both import `@confluo/shared`.

---

## 17. Glossary

- **Awareness** — y-protocols ephemeral per-client state (cursor, user, lock); not persisted.
- **Block** — direct child of the `content` fragment; unit of soft locking.
- **Compaction** — replacing the update log prefix with a V2 snapshot.
- **RelativePosition** — Yjs position anchored to CRDT items, stable across concurrent edits; used for cursors and comment anchors.
- **State vector** — per-client clock map; diffing two gives the missing updates.
- **Ticket** — single-use 60 s Redis-backed credential to open a socket.
- **Soft lock** — advisory, server-arbitrated per-block lease that the UI enforces.
