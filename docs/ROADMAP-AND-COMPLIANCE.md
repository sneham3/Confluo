# Confluo — Implementation Roadmap, Hosting Plan & Requirements Compliance

This document accompanies the five development prompts in `docs/prompts/`. Part 1 describes the build order and everything needed to run the system in production. Part 2 checks the prompt set against the original project requirements and mentor evaluation guidelines.

---

# Part 1 — Implementation roadmap and hosting

## 1. Build order (critical path)

The order matters because three developers depend on Dev 4's packages. Do these in sequence, each gated by something runnable.

| Step | Owner | Timing | Deliverable | Gate |
|---|---|---|---|---|
| 1. Repo scaffolding | Dev 4 | Day 1 | pnpm workspaces, Turborepo, TypeScript base config, ESLint, Prettier, `.env.example`, CI skeleton on GitHub Actions | `pnpm i && pnpm lint && pnpm typecheck` green |
| 2. Local infrastructure | Dev 3 | Day 1 | Docker Compose with Postgres, Redis, MinIO, Toxiproxy | `docker compose up` healthy |
| 3. Contracts | Dev 4 | Day 2 | `@confluo/shared` (zod schemas, permission matrix, protocol constants, Drizzle schema), `@confluo/editor-schema`, fixtures for MSW mocks | Dev 1 and Dev 2 can start mocking |
| 4. Auth and documents API | Dev 4 | Days 3–5 | Register, login, refresh, create doc, list docs, socket tickets, migrations, seeds | Real logins from the frontends |
| 5. Minimal sync server | Dev 3 | Days 3–6 | Ticket check on upgrade, sync and awareness relay, append updates to Postgres, load from snapshot. No locks or compaction yet | Two Node clients converge |
| 6. Editor client package | Dev 4 | Days 5–8 | `@confluo/editor` hook, ticketed provider, IndexedDB persistence, connection state machine. Locks, SaveController and uploads follow | Frontends mount a live editor |
| 7. Vertical slice | Everyone | End of week 1 | Login → create doc → two browsers edit the same paragraph → cursors visible → reload restores content | Demo it before any feature work |
| 8. Features | Everyone | Week 2 | Permissions and share links, comments, image uploads via presigned URLs, soft locks, compaction, Redis fan-out for multiple sync nodes, landing pages | Feature checklist in each prompt |
| 9. Hardening | Dev 3 lead | Week 3 | Harness scenarios passing, security checklist, runbooks, staging deploy, frontend selection | Harness report meets targets |

**Prerequisites for every developer:** Docker Desktop, Node.js 22, pnpm 10, Git, the Antigravity IDE with the common prompt loaded.

**Branching:** merge the prompts from `sneham` into `main`, protect `main`, and have each developer branch as `dev{n}/{topic}`.

**Two gaps in the original requirements to decide on now:**

- There is no password reset or email verification. Adding them needs an email provider such as Resend. Fine to leave out for the evaluation, but say so explicitly.
- There is no ownership transfer. Same treatment.

## 2. Hosting

The one hard constraint is the sync server. It holds long-lived WebSockets and in-memory Yjs documents, so it cannot run on serverless platforms such as Vercel functions or AWS Lambda. Everything else is conventional.

### 2.1 Recommended for the evaluation: one VPS running Docker Compose

Cheapest option, mirrors local development exactly, and easy to debug during a live demo.

- **Server:** Hetzner CX22 or a DigitalOcean 4 GB droplet, Ubuntu 24.04.
- **Containers:** Caddy (automatic HTTPS and reverse proxy), web, api, sync, Postgres, Redis, MinIO. Caddy proxies WebSockets without extra configuration.
- **Domain:** one domain with `app.`, `api.` and `sync.` subdomains. Put DNS on Cloudflare. If the Cloudflare proxy is enabled, its 100-second idle timeout is fine because the sync server pings every 30 seconds.
- **Deploy:** GitHub Actions builds images on push to `main`, pushes them to GitHub Container Registry, then runs `docker compose pull && docker compose up -d` over SSH.

### 2.2 Managed option, if you want to demonstrate horizontal scaling

| Component | Service | Why |
|---|---|---|
| Web (Next.js) | Vercel | Zero-config, fast CDN for the landing page |
| API (Fastify) | Fly.io or Railway | Containers, easy scaling |
| Sync server | Fly.io, 2 machines | Real WebSocket support, lets you demo Redis fan-out across nodes |
| Postgres | Neon or Supabase | Managed, backups included |
| Redis | Redis Cloud or Fly Redis | Needs real pub/sub; avoid request-priced Redis for pub/sub |
| Object storage | Cloudflare R2 | S3-compatible, no egress fees |

**Rough monthly cost:** under 10 USD for the VPS route; 20–40 USD for the managed route on free and hobby tiers.

### 2.3 Environment setup for any host

- Generate the ES256 key pair once: `openssl ecparam -name prime256v1 -genkey -noout -out jwt.pem` and derive the public key with `openssl ec -in jwt.pem -pubout`.
- Store both keys plus database, Redis and storage credentials as GitHub Actions secrets. Keep a separate `.env` per environment.
- Production must set secure cookies, restrict CORS to the real web origin, and set the correct public URLs for the API and sync server (`WEB_URL`, `API_URL`, `SYNC_URL`).

## 3. Operations and demo readiness

- **Observability.** The sync server exposes Prometheus metrics. Run Grafana Cloud's free tier or a Grafana container to chart connections, dropped messages and per-document state size. Send API and sync errors to Sentry.
- **Backups.** Nightly `pg_dump` to R2 or MinIO; enable versioning on the asset bucket. Test one restore before the evaluation.
- **Staging.** A second Compose stack on the same VPS, or a Fly preview app, so the harness can run against a deployed environment and not just localhost.
- **Evaluation evidence.** Run the seven harness scenarios against staging, commit the report to `docs/harness-report.md`, and wire its numbers into the landing page proof strip. Mentors grade on convergence, cursor latency, memory and offline sync, so this report is the main exhibit.
- **Demo accounts.** Seed two or three users with known passwords and one shared document. Write a one-page runbook for the demo, including how to simulate a partition live with Toxiproxy.
- **Security pass before going public.** Dependency audit, rate limits verified, upload validation tested with a spoofed file, and a check that viewers cannot write over the socket.

**Immediate next action:** steps 1 and 2 of the build order. Once the scaffold and Compose stack exist, generate the Compose file, Caddyfile, GitHub Actions deploy workflow and `.env.example` so the team starts from a working skeleton.

---

# Part 2 — Requirements compliance check

The prompt set was checked requirement by requirement against the original brief and the mentor evaluation guidelines.

| Requirement from the brief | Where it is covered in the prompts | Status |
|---|---|---|
| CRDT or OT, no Last-Write-Wins | Common R1, R2: Yjs is the only content authority; LWW banned even for small fields | Met |
| Use yjs-websockets for merging | Client uses the y-websocket provider and protocol; server speaks the same protocol via y-protocols | Met, see note 1 |
| Live cursors and selection highlighting | Common §6.3 awareness schema, CollaborationCaret, 33 ms throttle | Met |
| Full recovery after mid-session reconnect | Common §11: state-vector exchange on reconnect, y-indexeddb hydration before connect, fresh ticket per reconnect | Met |
| Latent, unreliable networks | Backoff policy, close-code handling, Toxiproxy fault injection in the harness | Met |
| Suggested stack only | Yjs, y-websocket, TipTap + Next.js, PostgreSQL + Redis + IndexedDB, all from the suggested list | Met |
| Eval: state consistency under partition | Harness scenario 1, must pass 20 of 20 runs with drop, delay, duplicate and reorder faults | Met |
| Eval: cursor/selection sync latency | Harness scenario 2 with p95 targets at 0 and 100 ms RTT | Met |
| Eval: CRDT memory footprint over long lifetimes | Harness scenario 3 at 1 M ops; gc tombstones, V2 snapshots, compaction, idle unload | Met |
| Eval: offline sync performance | Harness scenario 4, 10 k offline ops, 3 s target | Met |
| Robust login | Argon2id, ES256 JWT, rotating refresh tokens with reuse detection | Met |
| Cloud storage, instantly uploaded/synced | Peers receive updates in real time; server persists within 200 ms batches; direct-to-bucket uploads | Met |
| CRDT storage optimized for deleted text and races | Append-only idempotent update log, gc on, compaction | Met |
| Rich text: typing, bold, headings, lists, images, deletion | Editor schema package in the Dev 4 prompt | Met |
| Intent-preserving cursor and selection management | Yjs RelativePosition for carets and comment anchors | Met |
| Soft lock on the focused block | Common §10: Redis leases, RPC, ProseMirror `filterTransaction` enforcement | Met, see note 2 |
| Async auto-save, debounce, mutexes | Common §12.2 SaveController with async-mutex | Met |
| State snapshotting instead of live DOM | Common §12.1 and §12.3; node lookup by `uploadId` | Met |
| Abort controllers and invalidation flags | Common §12.2 steps 5–7; stale responses discarded by sequence | Met |
| Permission matrix, four roles, HTTP and WS | Common §8.4 and §9, enforced server-side in both services | Met, see note 3 |
| Five prompts: one common plus four roles, two competing frontends | Files `00`–`04` in `docs/prompts/` | Met |

## Notes on deliberate interpretations

**Note 1 — custom sync server.** The stock y-websocket server package is not used as-is. It accepts every update from every socket, so it cannot make a viewer's edits be ignored. The prompts keep the y-websocket protocol and client, and Dev 3 builds the server on the same underlying libraries (`ws`, `y-protocols`, `lib0`) with a permission gate. If mentors require the literal package running, Dev 3 can instead wrap its exported utilities and intercept messages before they reach the document; this is a smaller change and can be added to the Dev 3 prompt as an explicit option.

**Note 2 — optimistic locking.** The brief asks for an exclusive write lock. The spec allows typing while the lock request is in flight, then makes the block read-only if the request is denied. This keeps typing responsive on slow networks, and the CRDT absorbs the few keystrokes in that window. For strictly exclusive behaviour, change one rule in Common §10 so the block is read-only until the grant arrives.

**Note 3 — viewers sending presence.** The matrix says viewers receive remote cursors but does not say whether they broadcast their own. The spec allows viewers and commenters to send presence so editors can see who is reading. To make viewers invisible, change one row in the gate table in Common §8.4.
