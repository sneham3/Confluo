# Confluo

Real-time collaborative document editor built for concurrent, conflict-free editing at scale.

## Overview

Confluo lets multiple users edit the same document simultaneously without losing work, overwriting each other's changes, or breaking when a connection drops. It is built on Conflict-free Replicated Data Types (CRDTs) rather than Operational Transformation or Last-Write-Wins, which means every client is guaranteed to converge to the same document state regardless of edit order or network conditions.

## Core Requirements

The system is designed around three non-negotiable guarantees:

1. **Conflict Resolution** — Concurrent edits, including edits to the same text at the same time, always merge correctly. Last-Write-Wins is not used.
2. **Live Presence** — Every connected user's cursor position and text selection is visible to other users in real time.
3. **Persistence & Recovery** — A dropped network connection does not result in data loss. Edits made while offline are preserved and merged correctly on reconnect.

## Features

- Rich text editing: bold, headings, lists, images, insertions and deletions.
- Real-time multi-user editing with automatic conflict resolution.
- Intent-preserving cursor and selection tracking, so a user's cursor does not shift to an unrelated position when other users edit elsewhere in the document.
- Debounced auto-save with point-in-time state snapshotting, so background saves do not read partially-mutated content.
- Stale response invalidation for auto-save requests, preventing an outdated save from overwriting newer content.
- Block-level soft locking to prevent two users from making destructive, simultaneous edits to the same paragraph or block.
- Role-based permissions enforced at both the API and WebSocket layer.
- Local-first persistence, allowing offline editing with correct sync on reconnect.

## Permissions

| Role | API Access | Collaboration Access |
|---|---|---|
| Viewer | Fetch document (JSON/HTML) | Can connect to a document's live session; incoming edit events from this role are ignored; receives other users' cursors |
| Commenter | Fetch document; post comments | Can connect to a document's live session; cannot modify document content; can send comment/annotation events |
| Editor | Fetch and save metadata; upload assets | Full two-way edit synchronization and cursor awareness |
| Owner / Admin | Delete document; manage permissions | Full edit rights plus administrative actions |

Permission checks are enforced server-side on every incoming request and every incoming WebSocket message, independent of what the client interface allows or restricts.

## Tech Stack

| Layer | Technology |
|---|---|
| CRDT core | Yjs |
| Real-time sync | y-websocket |
| Editor | TipTap |
| Frontend | React, Next.js, Tailwind CSS |
| Local persistence | y-indexeddb |
| Backend / database | PostgreSQL (via Drizzle ORM) |
| Authentication | Supabase Auth |

## Run It Locally (No Docker Needed)

**Requirements:** Node.js 22 and pnpm 10.

Local mode uses an embedded Postgres (PGlite), an in-process key/value and pub/sub bus, and local-disk uploads, so nothing else has to be installed.

```bash
pnpm install
cp .env.example .env                      # already done on this machine
echo NEXT_PUBLIC_API_URL=http://localhost:4000 > apps/web/.env.local
pnpm dev:all                              # starts the API + sync server on :4000 and the web app on :3000
```

Open `http://localhost:3000`. Demo accounts are seeded on first start:

| Email | Password | Role on the demo document |
|---|---|---|
| alice@confluo.dev | password123! | owner |
| bob@confluo.dev | password123! | editor |

To see collaboration, open the same document in two browsers (or one normal and one private window), log in as Alice in one and Bob in the other.

### Useful Scripts

| Command | What it does |
|---|---|
| `pnpm dev` | API + sync server only (port 4000) |
| `pnpm dev:web` | Next.js app only (port 3000) |
| `pnpm typecheck` | TypeScript across the workspace |
| `pnpm test` | Unit and integration tests (Vitest) |
| `pnpm db:generate` | Regenerate the SQL migration from the Drizzle schema |
| `pnpm db:seed` | Re-run the demo seed |

Data for local mode lives in `.data/` (embedded database, uploads, dev JWT keys). Delete the folder to reset.

### Automated Browser Check

With the stack running, this drives two real Chromium sessions (Alice and Bob) plus a viewer through login, simultaneous editing, remote carets, soft locks, an offline edit that resyncs, a title rename, and a read-only share link, and saves screenshots to `docs/screenshots/`:

```bash
cd apps/web
pnpm exec playwright install chromium     # once
node scripts/verify-e2e.mjs
```

## Project Structure

```
confluo/
├── apps/
│   └── web/            # Next.js app (editor UI, e2e verification script, screenshots)
├── docs/
│   └── screenshots/    # Output of the automated browser check
├── .data/              # Local embedded database, uploads, dev JWT keys (gitignored)
└── README.md
```

## Roadmap

1. Core CRDT synchronization between clients
2. Live cursor and selection presence
3. Offline persistence and reconnect recovery
4. Role-based permission enforcement across API and WebSocket layers
5. Network partition simulation for demonstrating recovery behavior
6. Extended presence indicators (active block, editing status)

## License

To be determined.
