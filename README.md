# Confluo

Real-time collaborative rich text editor. Google-Docs-style simultaneous editing with no data loss: Yjs CRDT over the y-websocket protocol, live cursors and selections, per-block soft locks, offline persistence in IndexedDB, and full recovery after reconnects.

## Run it locally (no Docker needed)

Requirements: Node.js 22 and pnpm 10. Local mode uses an embedded Postgres (PGlite), an in-process key/value and pub/sub bus, and local-disk uploads, so nothing else has to be installed.

```bash
pnpm install
cp .env.example .env                      # already done on this machine
echo NEXT_PUBLIC_API_URL=http://localhost:4000 > apps/web/.env.local
pnpm dev:all                              # starts the API + sync server on :4000 and the web app on :3000
```

Open http://localhost:3000. Demo accounts are seeded on first start:

| Email | Password | Role on the demo document |
|---|---|---|
| alice@confluo.dev | password123! | owner |
| bob@confluo.dev | password123! | editor |

To see collaboration, open the same document in two browsers (or one normal and one private window), log in as Alice in one and Bob in the other.

Useful scripts:

| Command | What it does |
|---|---|
| `pnpm dev` | API + sync server only (port 4000) |
| `pnpm dev:web` | Next.js app only (port 3000) |
| `pnpm typecheck` | TypeScript across the workspace |
| `pnpm test` | Unit and integration tests (Vitest) |
| `pnpm db:generate` | Regenerate the SQL migration from the Drizzle schema |
| `pnpm db:seed` | Re-run the demo seed |

Data for local mode lives in `.data/` (embedded database, uploads, dev JWT keys). Delete the folder to reset.

### Automated browser check

With the stack running, this drives two real Chromium sessions (Alice and Bob) plus a viewer through login, simultaneous editing, remote carets, soft locks, an offline edit that resyncs, a title rename, and a read-only share link, and saves screenshots to `docs/screenshots/`:

```bash
cd apps/web
pnpm exec playwright install chromium     # once
node scripts/verify-e2e.mjs
```

## Cloud mode (hosting)

Set `CONFLUO_MODE=cloud` and provide `DATABASE_URL`, `REDIS_URL` and the `S3_*` variables (see `.env.example`). `infra/docker-compose.yml` starts Postgres, Redis, MinIO and Toxiproxy for a self-hosted stack. The all-in-one server (`apps/server`) can run as a single container, or `apps/api` and `apps/sync` can be deployed separately and scaled; sync nodes coordinate through Redis pub/sub.

## Layout

```
apps/web            Next.js 16 app: landing page, auth, dashboard, editor
apps/api            Fastify HTTP API (auth, docs, permissions, comments, assets, tickets)
apps/sync           WebSocket sync server (Yjs, awareness, soft locks, persistence, compaction)
apps/server         All-in-one entry mounting api + sync on one port
packages/shared     Contracts: roles, permission matrix, protocol constants, zod schemas, DB schema
packages/adapters   Database / KV / pub-sub / object storage adapters (local and cloud)
packages/editor-schema  TipTap 3 extension set (server-safe)
packages/editor     Browser collaboration client: providers, soft-lock plugin, save controller, uploads
packages/doc-render Server-side Y.Doc → JSON / HTML / text
docs/prompts        The five development prompts this codebase was built from
docs/ROADMAP-AND-COMPLIANCE.md  Build order, hosting plan, requirements compliance
```

## Architecture in one paragraph

The document body lives only in a `Y.Doc`. Browsers edit through TipTap bound to Yjs, persist every update to IndexedDB, and exchange updates with the sync server over the y-websocket protocol using single-use tickets minted by the HTTP API. The sync server enforces the permission matrix per message (viewers and commenters can read and see cursors but their edits are dropped), appends every update to an append-only log in Postgres, and compacts the log into snapshots. Soft locks are 30-second leases arbitrated by the server and enforced in the editor by a ProseMirror plugin; the CRDT still converges if a lock is bypassed. Metadata saves use a debounced, mutex-guarded, abortable save controller with sequence-based invalidation and `If-Match` versioning, so a stale response can never overwrite newer state.
