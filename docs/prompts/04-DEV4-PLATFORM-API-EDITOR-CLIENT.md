# Developer 4 — Platform: Auth, HTTP API, Shared Contracts & Client Editor Package

> **Prerequisite:** `00-COMMON-FOUNDATION.md` is loaded in your context and is authoritative. Sections 6.1, 7, 9, 12, 13 of that document are *your* contracts; you implement them exactly. You own `apps/api`, `packages/shared`, `packages/editor-schema`, `packages/editor`, `packages/config`. Branch prefix `dev4/`. You are the **first mover**: milestone M0 (contracts + mocks) is due on day 2 because Dev 1, Dev 2 and Dev 3 all build on your packages.

---

## 1. Mission

Deliver (a) the typed contracts everyone imports, (b) the secure HTTP platform (identity, documents, permissions, sharing, comments, assets, socket tickets, events), and (c) the browser-side collaboration client that turns Yjs + TipTap + the sync server into a single hook the frontends can use, including soft-lock enforcement, snapshot-based saving with abort/invalidation, and background uploads.

---

## 2. Deliverable A — `packages/shared` (day 1–2, M0)

```
packages/shared/src/
├─ roles.ts          Role union + ordering; RoleRank; isAtLeast(role, min)
├─ permissions.ts    Action union; can(role, action): boolean — the matrix from common §9, table-driven, exhaustively unit-tested
├─ protocol.ts       MESSAGE_* constants (0,1,3,10,11,12), SYNC_STEP1/2/UPDATE (0,1,2), CLOSE_* codes, RPC method names, ServerEvent types, AwarenessState zod schema, RPC param/result zod schemas
├─ api/              zod schemas for every request and response body in common §7 (one file per resource), ErrorEnvelope, ErrorCode enum
├─ db/               Drizzle schema for all tables in common §6.1 (exported so apps/sync and packages/doc-render can query document_updates/document_snapshots with the same types)
├─ ids.ts            nanoid(12) blockId helper; uuid guards
├─ time.ts           server-time helpers
└─ index.ts
```
Rules: no runtime dependency on Node-only or DOM-only APIs (this package runs in browser, Node, and edge). `zod` is the only heavy dependency. Every schema exports its inferred type. `can()` must be pure and have a test that asserts the entire matrix (4 roles × 12 actions) against the table in the common document.

---

## 3. Deliverable B — `packages/editor-schema` (day 1–2, M0)

TipTap extension set, **server-safe** (no `window`), used by the browser editor, the server renderer (`@confluo/doc-render`) and the landing demos:

- `Document`, `Paragraph`, `Text`, `Heading` (levels 1–3), `Bold`, `Italic`, `BulletList`, `OrderedList`, `ListItem`, `HardBreak`, `Dropcursor`, `Gapcursor`.
- **`Image`** (custom, block-level, `draggable`, `atom`): attrs `src` (string), `alt` (string), `assetId` (string|null), `uploadId` (string|null), `status` (`'uploading'|'ready'|'failed'`), `width` (number|null). `renderHTML` emits `<figure data-block-id><img …></figure>`. `parseHTML` accepts `img` and `figure > img`. When `status !== 'ready'` and the viewer is not the uploader, render a placeholder (the node view lives in `packages/editor`; the schema only defines attrs and HTML).
- **`BlockId`** (custom): adds global attribute `blockId` to `paragraph`, `heading`, `bulletList`, `orderedList`, `image` with `parseHTML: el.getAttribute('data-block-id')`, `renderHTML: { 'data-block-id': value }`. An `appendTransaction` assigns `nanoid(12)` to any top-level block lacking an id **or** sharing an id with an earlier block (split/duplicate case). Ids are never changed otherwise. Must be deterministic-safe under collaboration: only assign when the block is missing an id in the *local* transaction; remote blocks always arrive with ids.
- `History` is **excluded** (Collaboration provides undo). `StarterKit` is not used wholesale; import extensions individually to keep the server bundle small.
- Export `extensions: Extension[]` and `schemaVersion = 1`.
- Test: `generateHTML` / `generateJSON` round-trip a fixture containing every node/mark; `blockId` survives; unknown HTML (script, iframe) is dropped.

---

## 4. Deliverable C — `apps/api` (Fastify)

### 4.1 Structure
```
apps/api/src/
├─ main.ts               boot, plugins (helmet, cors, cookie, rate-limit, type-provider-zod, swagger), graceful shutdown
├─ config.ts             zod env
├─ db/                   drizzle client, migrations runner, seeds (dev users, demo doc)
├─ plugins/auth.ts       bearer verification (jose ES256), request.user; service-token guard for /internal
├─ plugins/authz.ts      requireRole(min) preHandler: loads role for (user, doc) with a 5 s in-memory LRU + Redis cache `role:{doc}:{user}`; invalidated on permission changes
├─ routes/auth.ts docs.ts permissions.ts share.ts comments.ts assets.ts tickets.ts users.ts internal.ts health.ts
├─ services/             auth-service, doc-service, permission-service, comment-service, asset-service (S3 presign + verify), ticket-service, event-bus (Redis publish), audit
├─ lib/errors.ts         AppError → shared error envelope; error codes from @confluo/shared
└─ openapi/              generated spec served at /docs (dev only)
```

### 4.2 Auth (common §13)
- Register: normalize email (citext), Argon2id hash, assign `color` round-robin from the 12-color palette in `@confluo/shared`, create refresh family, return access token + set cookie.
- Login: fetch by email; if missing, still run `argon2.verify` against a dummy hash (constant time); generic error `UNAUTHENTICATED`.
- Refresh: read cookie → sha256 → find token; if revoked or expired → if the family has a newer token, treat as reuse: revoke entire family, `401`. Else rotate: insert new token in same family, revoke old, set cookie, return new access token. `Origin` must match `WEB_URL`.
- Logout: revoke family, clear cookie.
- Access token: `jose` ES256, keys from env (PEM), 15 min, `jti` random. Verify on every request; no DB hit.
- `GET /me`.

### 4.3 Documents, permissions, sharing
- `POST /docs`: transaction: insert document, insert owner permission, insert an initial empty snapshot (`Y.Doc` with an empty `content` fragment containing one paragraph with a `blockId`, encoded V2) so the sync server always has a baseline. Audit.
- `GET /docs`: keyset pagination on `(updated_at, id)`; join permissions to include `role`; exclude soft-deleted.
- `GET /docs/:id`: metadata + role + collaborators (users with permissions, limited to 50, ordered by role desc).
- `GET /docs/:id/content?format=`: `@confluo/doc-render` `loadYDoc` → `toProseMirrorJSON | toHTML | toText`; response includes `version: { uptoUpdateId }` (max persisted update id) and `ETag`. Cache 0. Size guard: if encoded state > 20 MB respond `413`.
- `PATCH /docs/:id`: requires `If-Match: "<version>"`; `UPDATE … WHERE id=$1 AND version=$2 RETURNING` ; zero rows → `412 VERSION_CONFLICT` with `{ current: doc }`. Publish `doc.updated` event.
- `DELETE /docs/:id`: soft delete; publish `doc.deleted`; audit; a daily job purges >30 days (including S3 objects).
- Permissions: `PUT` upserts; forbid changing the owner row; forbid assigning `owner` (ownership transfer is out of scope → `400`); publish `permission.changed {docId, userId, role}`; invalidate role cache; audit.
- Share links: raw token = 32 random bytes base64url; store sha256; `accept` upserts permission with `GREATEST(existing, link.role)` semantics (never downgrade); publish `permission.changed`; audit.
- `GET /users/lookup?email=` rate limited 20/min/user; returns only `{id, name, color}`.

### 4.4 Comments
- Anchors are opaque bytes (`Y.encodeRelativePosition` output) received base64; validate length ≤ 256 bytes; store as bytea. `block_id` stored for fallback.
- Authorization: create requires `commenter+`; update/delete requires author or owner; resolve requires `commenter+` for own threads, `editor+` for any thread.
- Publish `comment.created|updated|deleted` on `doc:{id}:events` with the full comment DTO so the sync server fans out.

### 4.5 Assets
- `presign`: validate mime ∈ allowlist and `byteSize ≤ 10 MiB`; create `assets` row `pending`; key `docs/{docId}/{assetId}.{ext}`; return presigned `PUT` (5 min) with `Content-Type` and `Content-Length` conditions.
- `complete`: `HeadObject` → verify size and content type; `GetObject` `Range: bytes=0-31` → verify magic bytes (PNG/JPEG/WebP/GIF); read dimensions via `image-size` from a ranged/partial read (fallback: full read for files ≤ 2 MiB); set `ready`, `width`, `height`; return `{url: /v1/assets/:id, width, height}`.
- `GET /assets/:id`: role check on the asset's doc → `302` to a 10-min signed GET URL with `response-content-disposition=inline`.
- Orphan sweeper (hourly): `pending` older than 1 h → delete object + row; `ready` assets whose `assetId` no longer appears in the doc JSON (via `doc-render`) for > 24 h → mark `orphaned`, delete object after 7 days.

### 4.6 Socket tickets and events
- `POST /docs/:id/socket-ticket`: role check (`viewer+`); ticket = 32 random bytes base64url; `SET ticket:{ticket} {userId, docId, role, iat} EX 60`; return `{ticket, wsUrl: SYNC_URL, role, expiresAt}`.
- `POST /internal/tickets` (service token; harness only): mint tickets for seeded users without a session.
- `event-bus.publish(docId, event)` → `PUBLISH doc:{docId}:events JSON`.
- `GET /internal/docs/:id/role/:userId` (service token): role lookup fallback for the sync server.

### 4.7 Cross-cutting
- Zod on every route via `fastify-type-provider-zod`; OpenAPI generated from the same schemas.
- Rate limits per common §7 using `@fastify/rate-limit` with Redis store.
- `@fastify/helmet`, CORS restricted to `WEB_URL` with credentials.
- Errors: `AppError(code, status, message, details)` → envelope; unexpected errors → `INTERNAL` with `requestId`, logged with stack.
- Audit service writes to `audit_log` for auth, permissions, share links, delete, admin.
- Migrations via `drizzle-kit`; `pnpm db:migrate`, `pnpm db:seed` (two users `alice@…`/`bob@…` password `password123!`, one shared demo doc).
- Health: `/healthz` process, `/readyz` pg + redis + s3.

---

## 5. Deliverable D — `packages/editor` (browser collaboration client)

### 5.1 Public API (frozen; both frontend tracks code against this)
```ts
export function useCollabDoc(opts: {
  docId: string;
  user: { id: string; name: string; color: string; avatarUrl?: string };
  role: Role;
  getTicket: () => Promise<{ ticket: string; wsUrl: string; role: Role }>;
  syncUrl: string;
  onEvent?: (e: ServerEvent) => void;
}): {
  editor: Editor | null;
  connectionState: 'connecting' | 'connected' | 'reconnecting' | 'offline' | 'denied';
  deniedReason?: 'unauthenticated' | 'revoked' | 'deleted' | 'kicked';
  unsyncedChanges: boolean;
  peers: Peer[];                       // derived from awareness, excludes self
  locks: Map<string, LockHolder>;      // blockId → holder (excluding own)
  uploads: UploadManager;
  titleSave: SaveController<string>;   // wired to PATCH /docs/:id with If-Match by the caller-provided saver
  comments: { anchorFromSelection(): { anchorFrom: string; anchorTo: string; blockId: string } | null;
              resolveAnchor(a: { anchorFrom: string; anchorTo: string }): { from: number; to: number } | null };
  rpc: (method: string, params: object) => Promise<unknown>;
  log: ConnectionLogEntry[];           // last 50 entries for the UI
  destroy(): void;
};
export { SaveController, UploadManager, createCollabEditorExtensions };
```
Also export a framework-free `createCollabDoc(opts)` returning the same surface plus `subscribe()`; the hook is a thin wrapper (Dev 1/2 may use either).

### 5.2 Providers
- `Y.Doc({ guid: docId, gc: true })`; `IndexeddbPersistence('confluo-doc-' + docId, ydoc)`; wait for `whenSynced` before mounting the editor so offline content shows immediately.
- **Ticketed provider:** implement `TicketedWebsocketProvider` on top of `y-websocket`'s `WebsocketProvider` with `connect: false`. Connection procedure: `await getTicket()` → set `provider.url` (serverUrl + '/' + docId + '?ticket=…') → `provider.connect()`. On `connection-close` with a reconnectable code, wait the provider's backoff, then repeat the procedure with a *fresh* ticket. On `4001/4003/4004/4030` set `denied` with the mapped reason, `provider.disconnect()`, and for `4003/4004` clear the IndexedDB database. If subclassing proves brittle with the installed y-websocket version, write a minimal provider (~300 lines) on `y-protocols` + `lib0` that implements sync step 1/2, awareness, and the custom message types 10/11/12; decide within one day and record the decision in the README.
- Awareness local state: exactly common §6.3, updated through a single `setLocalStateField` throttle (33 ms). `status` flips to `idle` after 60 s without input and back on input.
- `connectionState` machine: `connecting` (first attempt) → `connected` (`status=connected` **and** `synced=true`) → `reconnecting` (closed with reconnectable code, or `navigator.onLine=false` while a connection existed) → `offline` (after 10 s in reconnecting or `navigator.onLine=false`) → `denied`.
- `unsyncedChanges`: increment a counter on every local `ydoc.on('update')` with local origin; reset to 0 on every `provider.on('sync', true)` and after each successfully sent update batch once `synced` (approximation: reset when `provider.synced && socket open && no pending local updates since last `synced` transition`). Expose as boolean.
- Custom message handling: register handlers on the provider for message types 10/11/12 (y-websocket exposes `messageHandlers[]`); RPC uses a `Map<id, {resolve,reject,timeout 10 s}>`.
- Leave `ydoc` and providers alive across React StrictMode double-mount (use a module-level registry keyed by `docId`, ref-counted; destroy on last unmount after a 100 ms grace).

### 5.3 Editor construction
`createCollabEditorExtensions({ ydoc, provider, user, role })` returns `@confluo/editor-schema` extensions plus:
- `Collaboration.configure({ document: ydoc, field: 'content' })`
- `CollaborationCaret.configure({ provider, user: { name, color } })` (TipTap 3 name; alias for 2.x if needed)
- `SoftLock` plugin (below)
- `ImageNodeView` (React node view: object-URL preview for uploader, skeleton for peers, progress ring, retry/remove on `failed`)
- `editable: role === 'editor' || role === 'owner'`; when `role.changed` arrives, call `editor.setEditable()` accordingly.

### 5.4 SoftLock ProseMirror plugin — implement common §10 client behaviour exactly
- Plugin state: `{ held: Set<blockId>, pending: Set<blockId>, others: Map<blockId, LockHolder> }` updated from RPC results and `lock.changed` events.
- `view.update`/`appendTransaction`: on selection change compute touched top-level blocks (`doc.resolve(from).node(1)?.attrs.blockId` … through `to`); diff against `held ∪ pending`; coalesce per rAF; `lock.acquire` for new, `lock.release` for dropped. Heartbeat every 10 s with `held`.
- `filterTransaction(tr)`: if `!tr.docChanged` → allow. If `tr.getMeta('y-sync$')` (remote) → allow. Else for each step, compute its affected range (`step.getMap()` / `ReplaceStep.from/to`), map to top-level blocks in the *old* doc; if any block ∈ `others` → reject and emit `onBlocked(holder)` for the toast. Join/lift/wrap steps spanning a locked block → reject.
- Decorations: node decorations on locked-by-other blocks with class `is-locked` and `data-lock-name`, `style="--lock-color: …"`.
- Release on blur > 5 s, `visibilitychange` hidden > 30 s, `beforeunload`, and on `destroy()`.

### 5.5 SaveController — implement common §12.2 verbatim
Generic class with `async-mutex`, debounce (1500 ms trailing, 10 000 ms max wait), `AbortController` per flush, sequence-based invalidation (`seq < lastAppliedSeq → discard`), `412` handling (refetch → adopt or retry), `flush()` on `blur`, `visibilitychange`, `beforeunload` (uses `keepalive: true` fetch for the final flush). 100 % branch-covered unit tests with fake timers, including: slow old response arriving after a newer success is discarded; abort of superseded request; conflict → adopt when no pending local change; conflict → retry when pending.

### 5.6 UploadManager — implement common §12.3 verbatim
`enqueue(file)`: validate mime/size client-side; insert `image` node with `{src: URL.createObjectURL(file), uploadId, status:'uploading'}` at the selection (or after the current block if selection is inside a locked block → toast). Concurrency 3. Flow: `presign` → `PUT` with progress (XHR for progress events) → `complete` → `editor.commands.command(({tr, state}) => { walk state.doc for uploadId; tr.setNodeMarkup(pos, undefined, {...attrs, src, assetId, status:'ready'}) })`. Node gone → `DELETE /assets/:id`. Abort when node deleted (checked on every `docChanged` transaction via a `Set` of active uploadIds) or on `destroy()`. `pending` count exposed; `beforeunload` guard wiring exposed as `hasPending()`.

### 5.7 Comment anchoring helpers
`anchorFromSelection()` → `Y.encodeRelativePosition(absolutePositionToRelativePosition(pos, ystate.type, ystate.binding.mapping))` for `from` and `to` (y-prosemirror `ySyncPluginKey` state) → base64. `resolveAnchor()` → `Y.createAbsolutePositionFromRelativePosition` → `relativePositionToAbsolutePosition` → `{from, to}` or `null` if either side no longer resolves.

### 5.8 Tests
- Vitest with `happy-dom` for the SoftLock plugin (lock a block via injected state, assert transactions rejected/allowed), SaveController (fake timers), UploadManager (mock XHR, node replacement by `uploadId` after intervening edits shift positions), anchor helpers (anchor survives concurrent inserts before it), provider state machine (mock socket).
- Integration: Node-side `createCollabDoc` (with `ws` and `fake-indexeddb`) against `apps/sync` from Dev 3 once available: two clients converge; viewer role gets `editable=false`; role revoke → `denied`.

---

## 6. Deliverable E — `packages/config` and repo scaffolding (day 1)

Root `package.json` (pnpm workspaces, Turborepo pipeline `build/dev/lint/typecheck/test`), `tsconfig.base.json` (strict, `moduleResolution: bundler`, `verbatimModuleSyntax`), ESLint 9 flat config (typescript-eslint strict, import ordering, no `console`), Prettier, `.editorconfig`, `.env.example` (all vars from common §13), GitHub Actions CI: install → lint → typecheck → unit tests → integration tests with services (postgres/redis/minio via `services:`) → harness `--quick` (after Dev 3 lands it), PR template, `CODEOWNERS` mapping paths to Dev 1–4.

---

## 7. Edge cases you must handle explicitly (write a test for each)

- Refresh token reuse after rotation revokes the family and the next legitimate refresh fails (`401`) — forces re-login.
- `PATCH /docs/:id` without `If-Match` → `428 PRECONDITION_REQUIRED` (add to error codes).
- Share link accept by a user who already has `editor` via a `viewer` link → stays `editor`.
- Owner tries to `PUT` their own permission or delete it → `400`.
- `complete` on an object with a spoofed `Content-Type` (PNG header, `image/jpeg` claimed) → `415 UNSUPPORTED_MEDIA`, row deleted, object deleted.
- Ticket requested for a soft-deleted doc → `404`.
- Comment anchor > 256 bytes → `400`.
- SaveController: user types title, network slow (5 s), user types again → exactly one final PATCH with the latest snapshot applied; the first response discarded or aborted.
- UploadManager: user deletes the placeholder mid-upload → upload aborted, no `complete` call, no orphan.
- SoftLock: remote update that modifies a block the local user holds → applied (remote is never blocked).

---

## 8. Deliverables checklist

- [ ] M0 (day 2): `@confluo/shared`, `@confluo/editor-schema`, `@confluo/config`, root scaffolding, CI skeleton, `.env.example`, `docs/api.md` linking the OpenAPI spec, a mock-friendly `fixtures/` folder with sample DTOs for Dev 1/2's MSW handlers
- [ ] `apps/api` implements every route in common §7 with the exact envelope, codes, rate limits and audit entries
- [ ] Auth per common §13 with the reuse-detection test
- [ ] Assets with presign, magic-byte verification, signed reads, orphan sweeper
- [ ] Socket tickets + event bus + internal routes for Dev 3 and the harness
- [ ] `@confluo/editor` public API exactly as in §5.1, with SoftLock, SaveController, UploadManager, anchors, ticketed provider, state machine
- [ ] All tests in §5.8 and §7 green; `pnpm db:seed` gives Dev 1/2 two users and a demo doc
- [ ] `docs/adr/0005-ticket-based-socket-auth.md`, `0006-metadata-versioning-if-match.md`, `0007-soft-lock-client-enforcement.md`
