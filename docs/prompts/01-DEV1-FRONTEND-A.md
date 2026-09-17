# Developer 1 — Frontend Track A: "Quiet Precision"

> **Prerequisite:** `00-COMMON-FOUNDATION.md` is loaded in your context and is authoritative. This prompt only adds role-specific direction. You are building `apps/web` on branch `dev1/web`. Developer 2 builds a competing implementation of the same scope on `dev2/web`; the Tech Lead will pick one. Do not coordinate styling with Dev 2. Do coordinate API/contract questions through Dev 4 and sync questions through Dev 3.

---

## 1. Your scope

You own the entire Next.js application `apps/web`:

1. **Marketing landing page** (`/`) — high-converting, accessible, fast.
2. **Auth pages** — `/login`, `/register`, `/share/[token]` (accept a share link, then redirect into the doc).
3. **Dashboard** (`/docs`) — list, create, rename, delete (owner), open.
4. **Editor page** (`/docs/[id]`) — the collaborative editor shell: toolbar, presence, connection status, soft-lock rendering, comments sidebar, share dialog, image upload UX, read-only mode for viewers/commenters.
5. **Cross-cutting** — auth session handling (access token in memory + silent refresh), error boundaries, loading states, keyboard accessibility, dark/light themes, analytics event abstraction.

You **do not** implement: CRDT logic, providers, lock enforcement, SaveController, UploadManager (all in `@confluo/editor`, Dev 4); API business logic (Dev 4); the sync server (Dev 3). You consume them. If a hook or API you need is missing, write the TypeScript interface you want in `packages/shared` or `packages/editor`, open a PR describing it, and stub it locally behind a feature flag until Dev 4 lands it.

---

## 2. Design direction for Track A: "Quiet Precision"

The product is a place people write for hours. Track A's identity is calm, typographic, and workspace-like (think a well-set book, not a SaaS billboard). Concretely:

- **Palette:** an ink-on-paper neutral system with a hue bias toward the accent. Light: paper `#FBFAF7`, ink `#1B1A17`, muted `#6B675F`, line `#E6E2DA`. Accent: a deep teal `#0F6E6E` (hover `#0B5757`). Dark: ground `#141412`, surface `#1C1B19`, ink `#EDEAE3`, accent `#3FB4B4`. Semantic: success `#2E7D4F`, warning `#B7791F`, danger `#B23A3A`. Expose all as CSS custom properties on `:root` with `prefers-color-scheme` and a manual `data-theme` toggle. Collaborator colors come from the user's `color` field (server-assigned 12-color palette), never from the theme.
- **Type:** display/headings in *Fraunces* (variable, opsz), body in *Source Serif 4* for the editor canvas and *Inter* for UI chrome. Load via `next/font/google` with `display: swap` and real fallback stacks. Type scale: 13 / 14 / 16 / 18 / 22 / 28 / 40 / 56. Editor measure 68ch max.
- **Layout:** generous whitespace, a single accent per screen, rules and spacing over cards and shadows. Landing page is a vertical narrative with one interactive hero; no parallax; motion limited to 150–250 ms opacity/translate on state changes, disabled under `prefers-reduced-motion`.
- **Component stack:** Tailwind CSS v4 + **shadcn/ui** (Radix primitives) for dialogs, popovers, dropdowns, tooltips, toasts (`sonner`). Icons: `lucide-react`. Do not introduce a second component library.

---

## 3. Architecture of `apps/web` (Track A)

```
apps/web/
├─ app/
│  ├─ (marketing)/page.tsx            landing (server component, zero client JS except hero demo island)
│  ├─ (auth)/login/page.tsx  register/page.tsx  share/[token]/page.tsx
│  ├─ (app)/layout.tsx                authenticated shell; redirects if no session
│  ├─ (app)/docs/page.tsx             dashboard (server component + client table)
│  ├─ (app)/docs/[id]/page.tsx        editor page (client island inside server shell)
│  ├─ api/session/route.ts            BFF: refresh access token from cookie (proxy to API /auth/refresh)
│  └─ layout.tsx, globals.css, not-found.tsx, error.tsx
├─ components/
│  ├─ ui/                             shadcn generated components
│  ├─ marketing/                      Hero, LiveDemo, FeatureGrid, ProofStrip, FAQ, CTA, Footer
│  ├─ editor/                         EditorShell, Toolbar, PresenceStack, ConnectionBadge, LockBadge, CommentsSidebar, ShareDialog, ImageUploadButton, ReadOnlyBanner
│  └─ dashboard/                      DocTable, NewDocButton, RenameInline
├─ lib/
│  ├─ api-client.ts                   typed fetch wrapper (zod-parsed responses, bearer injection, 401 → refresh once → retry)
│  ├─ session.ts                      in-memory access token, silent refresh timer at 80 % of exp
│  ├─ query/                          TanStack Query hooks: useDocs, useDoc, useComments, usePermissions
│  ├─ analytics.ts                    track(event, props) — no vendor; console in dev, no-op in prod until configured
│  └─ mocks/                          MSW handlers for every API route in the contract; y-websocket dev server script
├─ e2e/                               Playwright
└─ next.config.ts, tailwind config in globals.css (v4), middleware.ts (auth redirect)
```

**Data-fetching rules**
- Server components fetch with the refresh cookie forwarded to `apps/api` for first paint (dashboard list, doc metadata). Client mutations and live data use TanStack Query with the bearer token.
- Access token lives in memory only (never `localStorage`). On boot, `/api/session` (BFF route) exchanges the `httpOnly` refresh cookie for an access token.
- `middleware.ts` redirects unauthenticated visitors from `(app)` routes to `/login?next=`.
- Every API response is parsed with the zod schema from `@confluo/shared`; a parse failure is a thrown error surfaced by the nearest error boundary.

**Editor integration contract** (from `@confluo/editor`; if not yet published, stub against this exact shape):
```ts
const collab = useCollabDoc({
  docId, user: { id, name, color, avatarUrl }, role,
  getTicket: () => api.post(`/docs/${docId}/socket-ticket`),   // called on every (re)connect
  syncUrl: process.env.NEXT_PUBLIC_SYNC_URL,
});
// collab.editor: TipTap Editor | null   (schema from @confluo/editor-schema, Collaboration + CollaborationCaret + BlockId + Image + SoftLock plugins pre-wired)
// collab.connectionState: 'connecting'|'connected'|'reconnecting'|'offline'|'denied'
// collab.unsyncedChanges: boolean
// collab.peers: Array<{ clientId, user, role, status, lock }>
// collab.locks: Map<blockId, { userId, name, color, expiresAt }>
// collab.deniedReason?: 'revoked'|'deleted'|'unauthenticated'
// collab.uploads: UploadManager  (uploads.enqueue(file) — inserts placeholder + uploads)
// collab.titleSave: SaveController<string>  (schedule()/flush()/state)
```

---

## 4. Landing page specification (`/`)

Goal: a visitor understands in 5 seconds that this is a collaborative editor that never loses work, and clicks "Start writing". Structure, top to bottom:

1. **Nav** — wordmark, links (Product, How it works, Security), `Log in`, primary `Start writing — free`. Sticky, translucent on scroll, 56 px tall, `top: env(safe-area-inset-top)`.
2. **Hero (the thesis)** — headline ≤ 8 words ("Write together. Never lose a word."), one supporting sentence naming the three guarantees (conflict-free merging, live cursors, offline-safe). Primary CTA + secondary "Open a demo doc" (creates an anonymous-safe demo route `/demo`, which mounts the real editor against a throwaway doc using a public demo token endpoint from Dev 4, or, until that exists, a local-only `Y.Doc` with two scripted simulated collaborators). **Hero visual = a live editor island** (client component, lazy-loaded below LCP), showing two simulated named cursors typing different paragraphs with soft-lock chips visible, and a small "connection" pill that flips to *Offline → Reconnecting → Synced* on a loop. Everything else on the page is static server-rendered HTML.
3. **Proof strip** — three measurable claims sourced from the harness once available (convergence runs, p95 cursor latency, offline resync time). Until then render the target numbers marked "target". Never fabricate measured results.
4. **How it works** — three steps with a small inline SVG each: (1) *Your edits merge, not overwrite* (CRDT), (2) *See everyone, block by block* (presence + soft locks), (3) *Offline is just a slower network* (IndexedDB + resync). Copy must be truthful to the implementation in the common doc.
5. **Feature grid** — rich text (headings, lists, images), comments & roles (viewer/commenter/editor/owner), sharing links, version-safe saves. Six items, 2×3 → 1 column on phones.
6. **Security & permissions** — the permission matrix rendered as a compact table (viewer/commenter/editor/owner rows). This doubles as a conversion element for team buyers.
7. **FAQ** — 6 questions, native `<details>` for zero-JS accessibility.
8. **Final CTA** and footer.

**Conversion & quality requirements**
- Single primary CTA repeated three times, identical label; secondary CTA visually subordinate.
- Above-the-fold LCP element is the headline text, not an image. Hero demo mounts after `requestIdleCallback`.
- Lighthouse mobile: Performance ≥ 95, Accessibility 100, SEO ≥ 95. Route JS for `/` ≤ 90 kB gzipped excluding the lazily loaded demo island.
- Full keyboard navigation, visible focus rings, skip link, landmarks, `aria-live` for the demo pill, all images with alt, contrast ≥ 4.5:1 in both themes.
- OpenGraph/Twitter meta with a generated OG image (`opengraph-image.tsx`), canonical URL, `robots`, `sitemap.ts`.
- `track('cta_click', { location })`, `track('demo_interact')`, `track('signup_start')` fired through `lib/analytics.ts`.

---

## 5. Editor page specification (`/docs/[id]`)

**Layout:** left = document canvas (max 68ch, centered), right = collapsible comments sidebar (320 px, becomes a bottom sheet on phones), top bar = back, editable title, presence stack, connection badge, Share button (owner shows "Share", editors "Collaborators"), overflow menu.

**Required behaviours**
1. **Title** — inline editable input bound to `collab.titleSave` (debounced, `If-Match`), shows "Saving… / Saved / Couldn't save — retry" states; on `412` show "Renamed elsewhere to '…'" and adopt the server title unless the user is mid-typing.
2. **Toolbar** — Bold, Italic, H1/H2/H3, bullet list, ordered list, image upload, undo/redo (Yjs UndoManager via TipTap collaboration commands). Buttons reflect active state and are disabled when the caret is in a block locked by someone else (`collab.locks`).
3. **Presence** — avatar stack (max 5 + "+N"), tooltip with name and role; remote carets and selection highlights rendered by the collaboration caret extension using the peer's color; idle peers dimmed.
4. **Soft locks** — locked blocks show a left bar + name chip in the holder's color; attempted edits produce a toast "Paragraph is being edited by {name}". The client never makes the editor `editable=false` for locks (that is per-block via plugin); it does for role `viewer`/`commenter`.
5. **Connection badge** — `connected` (subtle), `reconnecting` (amber, animated), `offline` (grey, "Changes saved on this device"), `denied` (red, with reason and a "Back to documents" link). Show a dot when `unsyncedChanges` is true.
6. **Read-only mode** — for viewer/commenter: editor `editable=false`, toolbar hidden, banner "You can view (or comment on) this document". Commenters can select text and click "Comment" in a floating bubble menu.
7. **Comments sidebar** — threads anchored to text; clicking a thread scrolls to and highlights the anchored range (resolve RelativePosition → absolute via `@confluo/editor` helper each render; if the anchor no longer resolves, show "Original text was removed" and fall back to `blockId`). Create, reply, resolve, delete per matrix. Live updates via `comment.*` server events exposed from `collab`.
8. **Share dialog (owner)** — lookup by email, assign role, list collaborators, change role, remove; create share link with role + expiry; copy link. Owners cannot demote themselves.
9. **Images** — toolbar button, paste, and drag-drop all call `collab.uploads.enqueue(file)`. Show progress ring over the placeholder; failed uploads show retry/remove. Never block typing.
10. **Leave protection** — `beforeunload` guard when `unsyncedChanges || uploads.pending > 0`.
11. **Keyboard** — all toolbar actions have shortcuts and tooltips listing them; sidebar toggle `⌘/Ctrl+Shift+M`.

---

## 6. Dashboard and auth

- Dashboard table: title, role badge, collaborators avatars, updated time (relative, with `<time datetime>`), row actions per role. Empty state with a single "Create your first document" action. Optimistic create + navigate.
- Login/register forms: `react-hook-form` + zod schemas from `@confluo/shared`; inline errors; submit disabled while pending; "Continue" as the only button label; password field with reveal toggle; register shows a password strength hint (length-based only).
- `/share/[token]`: if logged in, `POST /share/:token/accept` then redirect; else redirect to `/login?next=/share/…`.

---

## 7. Mocking and local development

- MSW handlers cover **every** route in the HTTP contract with realistic latency (80–200 ms) and failure toggles (`?fail=412`, network error) so that the SaveController and error states can be exercised.
- `pnpm dev:mock` runs Next.js with MSW and a local `y-websocket` dev server; `pnpm dev` runs against `apps/api` and `apps/sync`.
- Storybook is optional; if you add it, keep it out of the production build.

---

## 8. Tests you must ship

- Vitest + Testing Library: `api-client` (refresh-once-then-retry), `session` timer, `ConnectionBadge` states, `ShareDialog` role rules, comments anchor fallback rendering.
- Playwright: (1) register → create doc → type → reload → text persists; (2) two contexts: text typed in A appears in B, A's caret is visible in B with A's color; (3) viewer context cannot type and sees the banner; (4) offline simulation (`context.setOffline(true)`) → type → back online → converged; (5) landing page axe scan with zero violations; (6) Lighthouse CI run against `/` with the budgets in the common doc.

---

## 9. Deliverables checklist

- [ ] `apps/web` builds with `pnpm build`, zero TypeScript errors, zero ESLint errors
- [ ] Landing page meets Section 4 budgets (attach Lighthouse JSON to the PR)
- [ ] Editor page implements every item in Section 5
- [ ] Dashboard, auth, share acceptance implemented
- [ ] Theme tokens, dark mode, reduced motion, keyboard access verified
- [ ] MSW mocks for the full contract; `pnpm dev:mock` works from a fresh clone
- [ ] Tests in Section 8 green
- [ ] `apps/web/README.md`: setup, env vars (`NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_SYNC_URL`, `NEXT_PUBLIC_WEB_URL`), design tokens, decisions log (5–10 bullets on why Track A choices were made)

**Review rubric the Tech Lead will use (both tracks):** conversion clarity of the landing page · Lighthouse/axe results · editor UX under `reconnecting`/`offline`/`denied` · lock and presence rendering fidelity · code quality and adherence to contracts · test depth.
