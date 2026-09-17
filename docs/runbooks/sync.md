# Runbook — Sync server (`apps/sync`)

## What it is

The WebSocket node that holds live Yjs documents in memory, gates every frame by role,
relays presence, arbitrates soft locks, and persists updates to PostgreSQL. It speaks the
y-websocket protocol plus three custom message types (RPC 10, RPC result 11, server event 12).

Endpoints (standalone, port 4100): `ws://host:4100/v1/docs/{docId}?ticket=…`, `GET /metrics`,
`GET /healthz`. When mounted inside the all-in-one server the WebSocket path is prefixed with `/sync`.

## Durability model

1. A client update is applied to the in-memory `Y.Doc`, broadcast to the other sockets on this
   node, published on the Redis channel `doc:{id}:updates`, and appended to a per-room write buffer.
2. The buffer is flushed to `document_updates` every **200 ms**, or at **64 items** or **512 KiB**,
   whichever comes first, as one multi-row `INSERT`. Only updates received directly from clients
   are persisted; updates that arrive via Redis are applied and broadcast but not written
   (the node that received them from its client writes them). Yjs updates are idempotent, so
   duplicates are harmless.
3. Compaction runs when a room has ≥ 500 updates, ≥ 2 MiB, or 5 minutes of changes since the
   last snapshot, and on graceful unload. It takes the lease `doc:{id}:compact` (60 s), inserts
   a V2 snapshot into `document_snapshots` with `upto_update_id`, and deletes the covered rows.
4. A room is unloaded 60 s after its last socket closes (flush → compact if dirty → drop).
   Under memory pressure (RSS > 80 % of `SYNC_MAX_RSS_MB`) idle rooms are evicted LRU-first.

**If a node crashes** before a flush, the up-to-200 ms of buffered updates are lost *on the
server only*. Every client still holds them in memory and in IndexedDB; on reconnect the
state-vector exchange (SyncStep1/2) re-delivers exactly the missing updates. Nothing typed is lost.

**If PostgreSQL is down** the buffer is retried with exponential backoff (100 ms → 5 s) and kept
up to 32 MiB per room; clients are unaffected. Compaction resumes when writes succeed.

**If Redis is down** (cloud mode) the node keeps serving its local sockets. Cross-node fan-out and
server events degrade to local delivery and a `bus_unavailable` warning is logged.

## Locks

`lock:{docId}:{blockId}` = `userId|clientId` with a 30 s TTL renewed by `lock.heartbeat` every
10 s; `locks:{docId}` hash holds display info for `lock.list`. Tabs of the same user share a lock.
A 5 s sweeper drops hash entries whose lease expired and publishes `lock.changed {holder:null}`.

## Running two nodes locally (cloud mode)

```bash
docker compose -f infra/docker-compose.yml up -d
export CONFLUO_MODE=cloud DATABASE_URL=postgres://confluo:confluo@localhost:5432/confluo \
       REDIS_URL=redis://localhost:6379 S3_ENDPOINT=http://localhost:9000 S3_BUCKET=confluo \
       S3_ACCESS_KEY=confluo S3_SECRET_KEY=confluo-secret WEB_URL=http://localhost:3000
SYNC_NODE_ID=a PORT=4100 pnpm --filter @confluo/sync exec tsx src/main.ts &
SYNC_NODE_ID=b PORT=4102 pnpm --filter @confluo/sync exec tsx src/main.ts &
```

Connect one browser to node `a` and another to node `b` (mint two tickets); typing on one must
appear on the other and `sync_update_bytes_total` must grow on both `/metrics` endpoints.

## Fault injection

Toxiproxy (port 8474) fronts sync on `4101` and api on `4001`:

```bash
curl -X POST localhost:8474/proxies/sync/toxics -d '{"type":"latency","attributes":{"latency":100,"jitter":50}}'
curl -X POST localhost:8474/proxies/sync/toxics -d '{"type":"timeout","attributes":{"timeout":10000}}'
curl -X DELETE localhost:8474/proxies/sync/toxics/timeout_downstream
```

## Key metrics

`rooms_loaded`, `connections{role}`, `sync_gate_dropped_total{role,type}`,
`sync_update_bytes_total`, `persist_batch_seconds`, `persist_backlog_bytes`,
`compaction_seconds`, `doc_state_bytes{docId}`, `lock_acquire_total{granted}`, `rpc_seconds{method}`.

## Close codes

`4001` bad/expired ticket · `4003` access revoked · `4004` doc deleted · `4008` server shutdown
(clients reconnect) · `4029` rate limited · `4030` kicked · `1009` frame > 2 MiB · `1013` backpressure.
