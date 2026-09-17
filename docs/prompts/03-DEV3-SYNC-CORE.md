# Developer 3 — Real-Time Sync Core, Persistence & Evaluation Harness

> **Prerequisite:** `00-COMMON-FOUNDATION.md` is loaded in your context and is authoritative. Sections 6.4, 8, 10, 11 of that document are *your* contracts; you implement them exactly. You own `apps/sync`, `apps/harness`, `packages/doc-render`, and `infra/`. Branch prefix `dev3/`. Dev 4 owns `packages/shared` (protocol constants, permission matrix); you review those PRs and consume them.

---

## 1. Mission

Build the distributed core that the whole product is graded on: a horizontally scalable Yjs sync server that enforces permissions per message, persists every update durably, compacts state to keep memory small, arbitrates soft locks, relays presence with minimal latency, and recovers cleanly from partitions. Then build the harness that *proves* it against the four evaluation axes (common doc §1).

---

## 2. Deliverable A — `apps/sync` (WebSocket sync server)

### 2.1 Structure
```
apps/sync/src/
├─ main.ts                 boot: env, redis, pg, http server, ws server, graceful shutdown
├─ http/upgrade.ts         ticket validation on HTTP upgrade (before ws accept), origin check
├─ ws/connection.ts        Connection class: {id, userId, docId, role, socket, awarenessClientIds, locks, rate bucket}
├─ ws/router.ts            decode first varUint → dispatch to sync/awareness/rpc handlers
├─ ws/gate.ts              permission gate (pure function: (role, messageType, subType) → allow|drop|error)
├─ sync/doc-manager.ts     load/hydrate/unload; per-doc room registry; memory pressure eviction
├─ sync/room.ts            Room: ydoc, awareness, connections Set, write buffer, dirty counters, timers
├─ sync/persistence.ts     loadDoc(docId), appendUpdates(batch), compact(docId), pg pool
├─ sync/redis-bus.ts       publish/subscribe doc:{id}:updates | :awareness | :events with nodeId origin
├─ locks/lock-service.ts   acquire/heartbeat/release/list/sweeper (Redis)
├─ rpc/handlers.ts         lock.*, annotation.broadcast, admin.*, ping
├─ events/subscriber.ts    doc:{id}:events → permission.changed / doc.deleted / comment.* fan-out to sockets
├─ metrics.ts              prom-client registry; /metrics on the http server
└─ config.ts               zod-validated env
```
Dependencies: `ws`, `yjs`, `y-protocols`, `lib0`, `ioredis`, `postgres` + `drizzle-orm` (schema imported from `@confluo/shared/db` if Dev 4 exports it; otherwise raw SQL for the two tables you own: `document_updates`, `document_snapshots`), `prom-client`, `pino`, `zod`.

### 2.2 Upgrade & connection lifecycle
1. `server.on('upgrade')`: parse `/v1/docs/:docId?ticket=`. Check `Origin ∈ {WEB_URL}`. `GETDEL ticket:{ticket}` → JSON `{userId, docId, role, iat}`; validate `docId` equality and `now - iat ≤ 60 s`. Failures: write `HTTP/1.1 401|403|404` and `socket.destroy()`. Success: `wss.handleUpgrade` → `Connection`.
2. On open: `room = await docManager.get(docId)` (memoized load); add connection; send `SyncStep1` (`syncProtocol.writeSyncStep1`); send full awareness state (`awarenessProtocol.encodeAwarenessUpdate(room.awareness, allClientIds)`); send `lock.list` snapshot as a `lock.changed` burst so the client renders locks immediately.
3. Per message: enforce max frame 2 MiB and the token bucket (200/s sustained, burst 400) **before** decoding. Then `gate(role, type, subType)`:
   - `allow` → handle.
   - `drop` → increment `sync_gate_dropped_total{role,type}`; for `SYNC/Update` from viewer/commenter send `error {code:'FORBIDDEN_EDIT'}` at most once per 10 s per connection.
   - `error` → send `MESSAGE_RPC_RESULT {ok:false, error:{code:'FORBIDDEN'}}`.
4. Awareness from viewer/commenter: decode, strip the `lock` field from their state before applying (`awarenessProtocol.applyAwarenessUpdate` on a modified encoding is awkward; instead: apply, then if the local state for their clientId contains `lock`, overwrite it with `lock: null` via `awareness.setLocalState`-equivalent on the server copy — implement `sanitizeAwareness(room.awareness, clientId, role)`).
5. On close: remove connection; `awarenessProtocol.removeAwarenessStates(room.awareness, connection.awarenessClientIds, null)`; release locks per common §10; if room has zero connections, start the 60 s unload timer.
6. Heartbeat: server pings every 30 s; terminate on missed pong (ws `isAlive` pattern).
7. Live role updates: `events/subscriber.ts` receives `permission.changed {userId, role}`; update `connection.role` for all matching connections on this node; `null` → close `4003`; downgrade below editor → release locks, send `role.changed`.
8. Graceful shutdown (`SIGTERM`): stop accepting upgrades, flush all write buffers, compact dirty rooms (bounded to 10 s total), close sockets with `4008`, exit.

### 2.3 Sync handling (y-protocols)
Use `syncProtocol.readSyncMessage(decoder, encoder, room.ydoc, connection)` semantics **but with the gate applied first** so that `SyncStep2`/`Update` from read-only roles never reach `Y.applyUpdate`. Concretely, decode the sub-type yourself:
- `SyncStep1` → `syncProtocol.writeSyncStep2(encoder, ydoc, sv)` → send.
- `SyncStep2` / `Update` (editors only) → `Y.applyUpdate(ydoc, update, connection)`; the room's `ydoc.on('update', (update, origin) => …)` handler then: broadcasts `MESSAGE_SYNC/Update` to every *other* local connection; if `origin instanceof Connection` (direct from client) → `redisBus.publishUpdate(docId, update)` and `room.writeBuffer.push({update, originUser})`. If `origin === 'redis'` → broadcast only (no publish, no persist). This prevents loops and double persistence.
- Track `sync_update_bytes_total`, `sync_update_apply_seconds` histogram.

### 2.4 Persistence (`sync/persistence.ts`) — implement common §11.1 exactly
- `loadDoc`: newest snapshot + trailing updates; use `Y.mergeUpdates` in chunks of 256 before applying to reduce apply cost. Record `load_seconds`, `loaded_state_bytes`.
- `appendUpdates(docId, batch)`: single multi-row `INSERT … RETURNING id`; set `room.lastPersistedUpdateId = max(id)`. Flush triggers: 200 ms timer, 64 items, 512 KiB. On DB error: retry with backoff (100 ms → 5 s, 10 attempts), keep the buffer (bounded to 32 MiB per room; beyond that, log `persist_backlog_overflow`, alert metric, and keep the newest — clients still hold the data).
- `compact(docId)`: lease `SET doc:{id}:compact nodeId NX PX 60000`; in a transaction: `INSERT document_snapshots (upto_update_id = room.lastPersistedUpdateId, state = encodeStateAsUpdateV2, state_vector, byte_size, char_count)` then `DELETE FROM document_updates WHERE document_id=$1 AND id <= $2`. Release lease. Triggers per §11.1. Metric `compaction_seconds`, `snapshot_bytes`.
- `unload`: per §11.1 + memory-pressure eviction ordered by `lastActivityAt`.

### 2.5 Redis bus
Binary channel payloads: `lib0` encoder: `writeVarString(nodeId)`, `writeVarUint8Array(update)`. One subscriber connection per node; subscribe on room load, unsubscribe on unload. Awareness updates are relayed the same way on `doc:{id}:awareness` (applied to the local awareness with origin `'redis'` so they fan out to local sockets but do not re-publish). Events channel carries JSON.

### 2.6 Lock service — implement common §10 server behaviour exactly
Lua script for `acquire` to make "check holder / set / refresh" atomic:
```lua
-- KEYS[1]=lock key, ARGV[1]=userId, ARGV[2]=clientId, ARGV[3]=ttlMs
local cur = redis.call('GET', KEYS[1])
if not cur then redis.call('SET', KEYS[1], ARGV[1]..'|'..ARGV[2], 'PX', ARGV[3]) return {1, ARGV[1], ARGV[2]} end
local u = string.match(cur, '^(.-)|')
if u == ARGV[1] then redis.call('SET', KEYS[1], ARGV[1]..'|'..ARGV[2], 'PX', ARGV[3]) return {1, ARGV[1], ARGV[2]} end
return {0, u, string.match(cur, '|(.*)$')}
```
Also maintain `locks:{docId}` hash for enumeration. Sweeper every 5 s: for each hash entry on rooms this node hosts, if `lock:{doc}:{block}` no longer exists → `HDEL` + publish `lock.changed {holder:null}`. Publish every lock change on `doc:{id}:events` so all nodes fan out.

### 2.7 RPC and server events
Implement every method in common §8.5 with zod-validated params. Unknown method → `{ok:false, error:{code:'UNKNOWN_METHOD'}}`. `ping` returns `serverTs` (used by the harness and the UI latency display). `admin.forceSnapshot` runs `compact` immediately. `admin.kick` closes all of that user's connections on all nodes (publish an event `kick {userId}`; every node closes with `4030`).

### 2.8 Backpressure and limits
- Before sending to a socket, check `socket.bufferedAmount`; if > 4 MiB, skip awareness messages for that socket (they are superseded anyway); if > 16 MiB, close `1013` (try again later) — the client will reconnect and resync.
- Awareness relay is coalesced per room per animation-frame-equivalent (16 ms) using a single merged awareness update.
- Max 20 connections per user per doc (count via `SINCR` on `conns:{doc}:{user}` with TTL; decrement on close).

### 2.9 Observability
Prometheus metrics: `rooms_loaded`, `connections{role}`, `sync_gate_dropped_total`, `sync_update_bytes_total`, `persist_batch_seconds`, `persist_backlog_bytes`, `compaction_seconds`, `snapshot_bytes{docId}` (top-N only), `doc_state_bytes` (gauge per loaded doc), `process_resident_memory_bytes`, `awareness_updates_total`, `rpc_seconds{method}`, `lock_acquire_total{granted}`. Structured pino logs with `docId`, `userId`, `connId`, `nodeId`. `/healthz` (process up), `/readyz` (pg + redis reachable).

---

## 3. Deliverable B — `packages/doc-render`

Server-safe library used by `apps/api` for `GET /docs/:id/content` and by the harness:
```ts
export async function loadYDoc(db, docId): Promise<Y.Doc>        // snapshot + updates → Y.Doc (shared with apps/sync via this package)
export function toProseMirrorJSON(ydoc): JSONContent               // y-prosemirror yDocToProsemirrorJSON(ydoc, 'content')
export function toHTML(ydoc): string                               // @tiptap/html generateHTML(json, extensions from @confluo/editor-schema) → sanitize (allowlist)
export function toText(ydoc): string
export function stats(ydoc): { chars, blocks, encodedV2Bytes, clients }   // for metrics and the harness
```
Move `loadDoc` here so `apps/sync` and `apps/api` share one implementation. No DOM APIs. Unit-test HTML output against a fixture doc containing every node type (headings, lists, bold/italic, image with `blockId`).

---

## 4. Deliverable C — `infra/`

- `docker-compose.yml`: `postgres:16` (with `citext`), `redis:7` (with `notify-keyspace-events Ex` enabled in case keyspace events are used), `minio` + `mc` init container creating bucket `confluo`, `toxiproxy` (ports 8474 API, 4101 → sync:4100, 4001 → api:4000). Health checks on all. Named volumes.
- `toxiproxy.json` with proxies `sync` and `api`.
- `pnpm infra:up|down|reset` scripts at the root. `pnpm dev` starts api, sync, web concurrently via Turborepo.
- `docs/runbooks/sync.md`: how the durability model works, what happens on node crash, how to run two sync nodes locally (`SYNC_NODE_ID=a PORT=4100`, `SYNC_NODE_ID=b PORT=4102`) and verify cross-node fan-out.

---

## 5. Deliverable D — `apps/harness` (evaluation harness)

A Node CLI (`pnpm harness <scenario> [--clients N] [--duration s] [--rtt ms] [--out report.json]`) that drives real `WebsocketProvider` clients (`ws` polyfill) and real TipTap-free Yjs documents (`Y.XmlFragment('content')` manipulated via `Y.XmlText`/`Y.XmlElement` to match the editor schema), through Toxiproxy, against `apps/sync`. Tickets are obtained from `apps/api` with seeded users (or a harness-only `SERVICE_TOKEN` endpoint Dev 4 exposes: `POST /internal/tickets`).

Scenarios (each prints a Markdown table and writes JSON):
1. **`convergence`** — N clients (default 8) on one doc, each performing random insert/delete/format ops at 20 ops/s for `duration`. Faults injected mid-run via Toxiproxy: `latency` (100 ms ± 50 jitter), `timeout` (partition 10 s for half the clients), `slicer`, `limit_data`, plus a *duplicate-and-reorder* step by replaying captured updates out of order through a second connection. After healing, wait for quiescence and assert: all clients' `Y.encodeStateVector` equal, all `toText()` equal, equal to the server's rendered text via `doc-render`. Report pass/fail, ops count, time-to-converge after heal. **Must pass 20/20 runs.**
2. **`cursor-latency`** — 2..N clients; client A moves its awareness cursor every 50 ms with `clientTs`; client B records `Date.now() - clientTs` on receipt (same machine clock). Report p50/p95/p99 at RTT 0 and RTT 100 ms. Targets: p95 ≤ 150 / ≤ 300 ms.
3. **`memory`** — one doc, 1 M ops (60 % insert, 35 % delete, 5 % format) generating ~100 k final chars with heavy churn, from 4 clients; force compaction via `admin.forceSnapshot`; report `snapshot_bytes`, `doc_state_bytes`, sync server RSS delta (`/metrics`), load time from cold. Target: state ≤ 5 MB, RSS/doc ≤ 2× state + 5 MB.
4. **`offline-sync`** — client A goes offline (Toxiproxy `timeout`), applies 10 k local ops, reconnects; measure time until server state vector includes A's clock and A's includes the others' concurrent edits. Target ≤ 3 s.
5. **`permissions`** — viewer and commenter clients send `SyncStep2`/`Update`/`lock.acquire`; assert nothing applied, `sync_gate_dropped_total` incremented, editors unaffected; owner `admin.kick` closes the target with `4030`; `permission.changed` to `null` closes with `4003` within 500 ms.
6. **`locks`** — two editors contend for the same block: exactly one granted; heartbeat keeps it; killing the holder's socket releases within 30 s (immediately on clean close); same-user second tab shares the lock.
7. **`scale`** — 50 editors on one doc, 10 ops/s each, 60 s: CPU, message backlog, p95 propagation ≤ 200 ms.

Output: `harness-report.md` + JSON for the README and the landing page "proof strip".

---

## 6. Tests you must ship

- Unit: `gate.ts` (full matrix table-driven), `lock-service` (Lua semantics via `ioredis-mock` or a real Redis in CI), compaction triggers, write buffer flush thresholds, Redis bus origin-loop prevention, awareness sanitization.
- Integration (docker compose): upgrade rejections (401/403/404, expired ticket, reuse), editor round-trip, viewer drop, live role change, snapshot + reload equivalence (`encodeStateAsUpdateV2` before unload == after reload), two-node fan-out (both nodes running, clients on different nodes converge).
- Harness scenarios 1–7 runnable in CI at reduced scale (`--quick`).

---

## 7. Edge cases you must handle explicitly (write a test for each)

- Ticket replay after `GETDEL` → 401.
- Update arrives after the connection's role was revoked but before the socket closed → dropped.
- Doc deleted while rooms are loaded → `doc.deleted` event → close all `4004`, discard write buffer, unload.
- A single 3 MiB paste update → `1009`; a legitimate 1.5 MiB image-heavy update passes.
- Awareness storm (client sends 1000/s) → rate limit `4029`.
- Postgres down for 30 s during editing → buffer holds, clients unaffected, backlog flushes on recovery, compaction resumes.
- Redis down → node keeps serving local clients (single-node mode), logs `bus_unavailable`, locks degrade to "granted locally" with a warning event to clients; recovers subscriptions on reconnect.
- Two nodes compacting simultaneously → lease prevents duplicate snapshots.
- Unload while a flush is in flight → unload awaits flush.

---

## 8. Deliverables checklist

- [ ] `apps/sync` implements common §8, §10, §11 exactly; gate table-driven from `@confluo/shared`
- [ ] `packages/doc-render` published and used by `apps/api`
- [ ] `infra/` compose + toxiproxy + runbook
- [ ] `apps/harness` with the seven scenarios and a committed sample `docs/harness-report.md`
- [ ] Metrics endpoint, structured logs, graceful shutdown verified
- [ ] Unit + integration + harness `--quick` green in CI
- [ ] ADRs in `docs/adr/`: `0001-yjs-over-automerge.md`, `0002-custom-sync-server.md`, `0003-append-log-plus-snapshots.md`, `0004-soft-locks-in-redis.md` (one page each: context, decision, consequences)
