# Developer 2 — Frontend Track B: "Show, Don't Tell"

> **Prerequisite:** `00-COMMON-FOUNDATION.md` is loaded in your context and is authoritative. This prompt only adds role-specific direction. You are building `apps/web` on branch `dev2/web`. Developer 1 builds a competing implementation of the same scope on `dev1/web`; the Tech Lead will pick one. Do not coordinate styling with Dev 1. Route API/contract questions to Dev 4 and sync questions to Dev 3.

---

## 1. Your scope (identical functional scope to Track A)

You own the entire Next.js application `apps/web`:

1. **Marketing landing page** (`/`).
2. **Auth pages** — `/login`, `/register`, `/share/[token]`.
3. **Dashboard** (`/docs`).
4. **Editor page** (`/docs/[id]`) — toolbar, presence, connection status, soft-lock rendering, comments, share dialog, image upload UX, read-only mode.
5. **Cross-cutting** — session handling, error boundaries, loading states, accessibility, themes, analytics abstraction.

You **do not** implement CRDT logic, providers, lock enforcement, SaveController, UploadManager (all in `@confluo/editor`, Dev 4), API business logic (Dev 4), or the sync server (Dev 3). If something you need is missing, write the TypeScript interface you want in `packages/shared` or `packages/editor`, open a PR describing it, and stub it locally behind a feature flag.

---

## 2. Design direction for Track B: "Show, Don't Tell"

Track B sells the product by letting the visitor *watch the hard part happen*: concurrent edits merging, a partition healing, cursors racing. The identity is confident, product-led, and kinetic, but precise, never gimmicky.

- **Palette:** a cool graphite system with one electric accent. Light: ground `#F6F7FB`, surface `#FFFFFF`, ink `#0E1220`, muted `#5B6272`, line `#DDE1EA`. Accent: cobalt `#2447F5` (hover `#1B37C7`), accent-soft `#E8ECFF`. Dark: ground `#0B0E17`, surface `#131828`, ink `#E8EBF5`, accent `#6D85FF`, accent-soft `#1B2350`. Semantic: success `#1E9E62`, warning `#D9902A`, danger `#D84C4C`. Tokens on `:root` + `prefers-color-scheme` + manual `data-theme`. Collaborator colors come from the user's `color` field.
- **Type:** display in *Instrument Serif* (italic for emphasis words in the headline), UI and body in *Geist* (sans) with *Geist Mono* for the "network log" elements and stats. `next/font` with real fallbacks. Scale: 12 / 14 / 16 / 20 / 24 / 32 / 48 / 72. Editor measure 70ch.
- **Layout:** asymmetric hero (copy left, live demo right on desktop; stacked on phones), full-bleed demo sections with a grid of 12 columns, thin 1 px lines rather than shadows, radius 6 px on controls and 12 px on panels. Motion is orchestrated (one page-load sequence in the hero, staggered ≤ 400 ms total; scroll-triggered sections start *visible* and only add a subtle translate), all disabled under `prefers-reduced-motion`.
- **Component stack:** Tailwind CSS v4 + **Radix Primitives used directly** (no shadcn), `motion` (Framer Motion v11+) for orchestration, `@radix-ui/react-toast` for toasts, icons from `@phosphor-icons/react`. Do not add a second component library.

---

## 3. Architecture of `apps/web` (Track B: feature-sliced)

```
apps/web/
├─ app/
│  ├─ (marketing)/page.tsx           landing: server component + client demo islands
│  ├─ (marketing)/demo/page.tsx      full-page live demo doc
│  ├─ (auth)/login  register  share/[token]
│  ├─ (app)/layout.tsx  docs/page.tsx  docs/[id]/page.tsx
│  ├─ api/session/route.ts           BFF refresh
│  └─ layout.tsx globals.css error.tsx not-found.tsx opengraph-image.tsx sitemap.ts
├─ features/
│  ├─ auth/        {actions.ts (Server Actions for login/register), forms/, session-store.ts}
│  ├─ docs/        {queries.ts, doc-list/, create-doc/}
│  ├─ editor/      {EditorScreen.tsx, toolbar/, presence/, locks/, connection/, title/, images/}
│  ├─ comments/    {CommentsPanel.tsx, thread/, composer/, anchors.ts}
│  ├─ sharing/     {ShareDialog.tsx, collaborator-row/, link-row/}
│  └─ landing/     {Hero.tsx, MergeDemo.tsx, PartitionDemo.tsx, PresenceDemo.tsx, Guarantees.tsx, RolesTable.tsx, Faq.tsx, Cta.tsx}
├─ shared/
│  ├─ api/          client.ts (typed fetch, zod parse, 401→refresh→retry once), msw/ handlers
│  ├─ ui/           Button, Dialog, Popover, Tooltip, Tabs, Toast, Avatar, Chip, Kbd  (Radix wrappers)
│  ├─ store/        zustand stores: ui-store (sidebar, theme), editor-ui-store (active thread, hover block)
│  └─ analytics.ts  track()
└─ e2e/ (Playwright), middleware.ts, next.config.ts
```

**Data-fetching rules**
- Server components for first paint (dashboard list, doc metadata) using the forwarded refresh cookie against `apps/api`.
- **Server Actions** for auth forms (`login`, `register`, `acceptShare`) so the forms work before JS hydrates; the action calls `apps/api` and sets the refresh cookie on the Next.js origin via a `Set-Cookie` pass-through. Client-side mutations elsewhere use TanStack Query.
- Access token in memory only (zustand store, not persisted). Silent refresh at 80 % of expiry.
- Zustand for UI state only; server state stays in TanStack Query; CRDT state stays in Yjs. Never mirror editor content into a store.
- Every API response parsed with `@confluo/shared` zod schemas.

**Editor integration contract** (from `@confluo/editor`; stub against this exact shape if not yet published):
```ts
const collab = useCollabDoc({
  docId, user: { id, name, color, avatarUrl }, role,
  getTicket: () => api.post(`/docs/${docId}/socket-ticket`),
  syncUrl: process.env.NEXT_PUBLIC_SYNC_URL,
});
// collab.editor, collab.connectionState, collab.unsyncedChanges, collab.peers, collab.locks,
// collab.deniedReason, collab.uploads (UploadManager), collab.titleSave (SaveController<string>)
```

---

## 4. Landing page specification (`/`)

Goal: the visitor *sees* conflict-free collaboration within the first screen and clicks "Start writing". Structure:

1. **Nav** — wordmark, links (Demo, Guarantees, Roles, Security), `Log in`, primary `Start writing`. Sticky with `top: env(safe-area-inset-top)`; background gains a 1 px bottom line after 8 px of scroll.
2. **Hero** — left: headline with one italic serif word ("Edit *together*, without stepping on each other."), one sentence, primary CTA + secondary "Watch a partition heal" that scrolls to section 4. Right: **MergeDemo** — a real TipTap editor (from `@confluo/editor-schema`, local `Y.Doc` only, no network) with two scripted personas typing into two different paragraphs *at the same time*, soft-lock chips on their blocks, and a third persona attempting to type into a locked block and being shown the "being edited by" chip. The script loops every 14 s and pauses when the tab is hidden. Mounted after LCP (`requestIdleCallback` + dynamic import). Visitors can click into the demo and type themselves.
3. **Guarantees** — three columns, each a *claim + how*: "Merges, never overwrites" (Yjs CRDT, no LWW), "You always see who is where" (awareness, block locks), "Offline is a first-class state" (IndexedDB, state-vector resync). Each column has a *mono* "what actually happens" snippet (three lines of pseudo-log) to signal engineering seriousness.
4. **PartitionDemo** — the signature section. Two side-by-side mini editors bound to two separate local `Y.Doc`s connected through an in-page "link" you control. A switch labelled **Network: Connected / Partitioned** (real toggle). While partitioned, both sides keep editing (scripted or by the visitor); on reconnect the docs exchange updates via `Y.encodeStateAsUpdate`/`applyUpdate` and a mono log prints the state vectors before/after and "converged ✓". This demonstrates the actual mechanism using the actual library; no faking.
5. **PresenceDemo** — a short strip with three colored carets moving through a paragraph with selection highlights, plus a latency readout "cursor sync: ~NN ms (target ≤ 150 ms)" driven by a local timer, labelled clearly as a local simulation until harness numbers exist.
6. **RolesTable** — the permission matrix from the common doc, four columns, with a segmented control that highlights one role at a time on phones.
7. **Security** — short bullets: Argon2id, rotating refresh tokens, single-use socket tickets, server-side enforcement, private uploads via signed URLs.
8. **FAQ** (native `<details>`), **final CTA**, footer.

**Conversion & quality requirements**
- One primary CTA label everywhere; secondary CTAs are text links with arrows drawn as SVG, not the `→` character.
- LCP element is the headline text. Total route JS for `/` ≤ 120 kB gzipped excluding lazily loaded demo islands (each island ≤ 90 kB gzipped, code-split).
- Lighthouse mobile: Performance ≥ 95, Accessibility 100, Best Practices ≥ 95, SEO ≥ 95.
- All demos are keyboard-operable and announce state changes via `aria-live="polite"`; simulated carets are `aria-hidden`; a visually hidden description explains each demo.
- OG image, canonical, sitemap, robots; `track('cta_click')`, `track('partition_toggle')`, `track('demo_type')`.

---

## 5. Editor page specification (`/docs/[id]`)

**Layout:** three-column on ≥ 1280 px: left rail (48 px: back, outline of headings), center canvas (70ch), right panel (comments / collaborators tabs, 340 px). Two columns on tablets (rail collapses). Single column on phones with the panel as a bottom sheet (`@radix-ui/react-dialog` styled as a sheet).

**Required behaviours** (same functional set as Track A; Track B differs in presentation):
1. **Title** — bound to `collab.titleSave`; status text in mono ("saving", "saved 3s ago", "conflict — renamed elsewhere"); `412` handling per common doc §12.
2. **Toolbar** — floating bubble menu on selection (Bold, Italic, H1–H3, lists, Comment) plus a fixed top toolbar with image upload and undo/redo. Controls disabled when the caret sits in a block locked by another user.
3. **Presence** — avatar row in the top bar; remote carets with name flags that fade after 2 s of inactivity and reappear on move; selection highlights at 25 % alpha of the peer color. Right panel "Collaborators" tab lists peers with role, status, and the block they are currently in ("editing ¶ 4").
4. **Soft locks** — locked blocks receive a 2 px left rule in the holder's color and a chip with name; a blocked edit attempt shakes the chip 1× (150 ms) and toasts "Paragraph is being edited by {name}".
5. **Connection** — a compact status pill with icon + label (`connected`, `reconnecting…`, `offline — saved on this device`, `access denied`); clicking opens a popover with the last 10 connection log lines in mono (from `collab` events) and an "unsynced changes" counter.
6. **Read-only** — viewers: canvas non-editable, toolbar hidden, top banner. Commenters: same, plus a selection bubble with only "Comment".
7. **Comments** — anchored threads; hovering a thread highlights its range; unresolvable anchors show "Original text removed" with a `blockId` fallback jump; create/reply/resolve/delete per matrix; live updates from `comment.*` events.
8. **Share dialog (owner)** — email lookup, role select, collaborator list with role change/remove, share links with role + expiry + copy; owners cannot demote themselves.
9. **Images** — button, paste, drop → `collab.uploads.enqueue(file)`; progress overlay on the placeholder; failed uploads show retry/remove; typing never blocks.
10. **Leave protection** — `beforeunload` when `unsyncedChanges || uploads.pending > 0`.
11. **Outline rail** — live list of headings (derived from `editor.state.doc`, throttled 250 ms) with click-to-scroll.

---

## 6. Dashboard and auth

- Dashboard as a responsive grid of document cards (title, role chip, avatars, updated time) with a list-view toggle persisted in `localStorage` (try/catch). Create is optimistic and navigates immediately.
- Auth forms via Server Actions with progressive enhancement; zod validation from `@confluo/shared` on both sides; errors rendered inline; a single "Continue" button.
- `/share/[token]` accepts then redirects; unauthenticated users go to `/login?next=`.

---

## 7. Mocking and local development

- MSW handlers for **every** contract route, with latency (80–200 ms) and failure toggles (`?fail=412`, `?fail=network`) to exercise SaveController and error UI.
- `pnpm dev:mock` = Next.js + MSW + local `y-websocket` dev server on 4100; `pnpm dev` = real `apps/api` + `apps/sync`.
- Demo islands never open sockets; they run entirely on local `Y.Doc`s.

---

## 8. Tests you must ship

- Vitest + Testing Library: api client refresh/retry, PartitionDemo convergence (apply updates both ways, assert equal `Y.encodeStateVector`), ConnectionPill states, ShareDialog rules, comment anchor fallback.
- Playwright: (1) register → create → type → reload → persists; (2) two contexts: live text and carets; (3) viewer cannot type; (4) `setOffline(true)` → type → online → converged; (5) landing axe scan zero violations, partition toggle keyboard-operable; (6) Lighthouse CI on `/` meeting budgets.

---

## 9. Deliverables checklist

- [ ] `apps/web` builds cleanly; zero TS/ESLint errors
- [ ] Landing page meets Section 4 budgets (attach Lighthouse JSON)
- [ ] MergeDemo and PartitionDemo use real Yjs, no fake animations of "merging"
- [ ] Editor page implements every item in Section 5
- [ ] Dashboard, auth via Server Actions, share acceptance
- [ ] Theme tokens, dark mode, reduced motion, keyboard access verified
- [ ] MSW mocks for the full contract; `pnpm dev:mock` works from a fresh clone
- [ ] Tests in Section 8 green
- [ ] `apps/web/README.md`: setup, env vars, token system, decisions log (why Track B choices were made)

**Review rubric the Tech Lead will use (both tracks):** conversion clarity · Lighthouse/axe results · editor UX under `reconnecting`/`offline`/`denied` · lock and presence rendering fidelity · code quality and contract adherence · test depth.
