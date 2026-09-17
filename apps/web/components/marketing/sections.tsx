import { CtaLink } from './cta-link';

export function ProofStrip() {
  const items = [
    { value: '100 %', label: 'convergence after partition', note: 'target' },
    { value: '≤ 150 ms', label: 'p95 cursor sync on LAN', note: 'target' },
    { value: '≤ 3 s', label: 'offline resync of 10k edits', note: 'target' },
  ];
  return (
    <section aria-label="Engineering targets" className="border-y border-line bg-surface">
      <dl className="mx-auto grid max-w-6xl grid-cols-1 divide-y divide-line px-4 sm:grid-cols-3 sm:divide-x sm:divide-y-0">
        {items.map((it) => (
          <div key={it.label} className="flex flex-col gap-1 py-6 sm:px-6 first:sm:pl-0">
            <dt className="text-[13px] text-muted">
              {it.label} <span className="ml-1 rounded-full bg-code-bg px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide">{it.note}</span>
            </dt>
            <dd className="font-display text-3xl font-semibold tabular-nums">{it.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

const STEPS = [
  {
    title: 'Your edits merge, not overwrite',
    body: 'Every keystroke becomes a CRDT operation. Two people typing in the same sentence end with the same sentence on every screen, without a last-write-wins coin flip.',
    icon: (
      <svg viewBox="0 0 48 48" className="h-10 w-10" aria-hidden fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M6 14h14l8 20h14" />
        <path d="M6 34h14l8-20h14" />
        <circle cx="42" cy="14" r="3" fill="currentColor" stroke="none" />
        <circle cx="42" cy="34" r="3" fill="currentColor" stroke="none" />
      </svg>
    ),
  },
  {
    title: 'See everyone, block by block',
    body: 'Live carets and selections in each person’s colour, plus a soft lock on the paragraph someone is editing so intent is preserved instead of tangled.',
    icon: (
      <svg viewBox="0 0 48 48" className="h-10 w-10" aria-hidden fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="6" y="8" width="36" height="10" rx="2" />
        <rect x="6" y="22" width="36" height="10" rx="2" strokeDasharray="3 3" />
        <path d="M14 26h4M22 26h10" />
        <path d="M6 40h36" />
      </svg>
    ),
  },
  {
    title: 'Offline is just a slower network',
    body: 'Changes are stored on the device first. When the socket comes back, both sides exchange what the other missed and converge in one round trip.',
    icon: (
      <svg viewBox="0 0 48 48" className="h-10 w-10" aria-hidden fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M8 30a8 8 0 0 1 2-15.7A12 12 0 0 1 33 12a9 9 0 0 1 7 18H12" />
        <path d="M20 36l4 4 8-8" />
      </svg>
    ),
  },
];

export function HowItWorks() {
  return (
    <section id="how" className="mx-auto max-w-6xl px-4 py-20">
      <h2 className="font-display text-3xl font-semibold sm:text-4xl">How it works</h2>
      <p className="mt-3 max-w-2xl text-muted">Three guarantees, each backed by a specific mechanism rather than a promise.</p>
      <ol className="mt-10 grid gap-8 md:grid-cols-3">
        {STEPS.map((s, i) => (
          <li key={s.title} className="flex flex-col gap-4 border-t border-line pt-6">
            <div className="flex items-center gap-3 text-accent">
              {s.icon}
              <span className="text-[13px] font-semibold uppercase tracking-wide text-muted">Step {i + 1}</span>
            </div>
            <h3 className="font-display text-xl font-semibold">{s.title}</h3>
            <p className="text-[15px] leading-relaxed text-muted">{s.body}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

const FEATURES = [
  ['Rich text that stays simple', 'Headings, bold and italic, bulleted and numbered lists, and images. The essentials, kept fast.'],
  ['Comments on exact text', 'Threads anchor to CRDT positions, so they follow the words even while others keep editing around them.'],
  ['Four roles, enforced twice', 'Viewer, commenter, editor and owner. The permission matrix is checked by the API and again by the sync server.'],
  ['Share links with expiry', 'Hand out a link with a role and an expiry. Revoke it any time.'],
  ['Saves that never go backwards', 'Metadata saves are snapshotted, debounced, abortable and version-checked. A slow response cannot clobber a newer edit.'],
  ['Images that upload in the background', 'Paste or drop an image and keep typing. The placeholder swaps in place when the upload finishes.'],
];

export function FeatureGrid() {
  return (
    <section id="product" className="border-t border-line bg-surface">
      <div className="mx-auto max-w-6xl px-4 py-20">
        <h2 className="font-display text-3xl font-semibold sm:text-4xl">Everything a team document needs</h2>
        <ul className="mt-10 grid gap-x-10 gap-y-8 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map(([title, body]) => (
            <li key={title} className="border-l-2 border-accent pl-4">
              <h3 className="font-semibold">{title}</h3>
              <p className="mt-1.5 text-[15px] leading-relaxed text-muted">{body}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

const MATRIX: Array<[string, string, string, string, string]> = [
  ['Read the document', '✓', '✓', '✓', '✓'],
  ['See live cursors', '✓', '✓', '✓', '✓'],
  ['Post comments', '—', '✓', '✓', '✓'],
  ['Edit text and upload images', '—', '—', '✓', '✓'],
  ['Hold block locks', '—', '—', '✓', '✓'],
  ['Manage sharing and roles', '—', '—', '—', '✓'],
  ['Delete the document', '—', '—', '—', '✓'],
];

export function PermissionsTable() {
  return (
    <section id="security" className="mx-auto max-w-6xl px-4 py-20">
      <h2 className="font-display text-3xl font-semibold sm:text-4xl">Permissions you can explain in one table</h2>
      <p className="mt-3 max-w-2xl text-muted">
        Roles are strictly ordered. Viewers connect to the live session but their edits are ignored at the socket. Only owners can change who has access.
      </p>
      <div className="mt-8 overflow-x-auto">
        <table className="w-full min-w-[560px] border-collapse text-[15px]">
          <thead>
            <tr className="text-left text-[13px] uppercase tracking-wide text-muted">
              <th scope="col" className="border-b border-line py-2 pr-4 font-semibold">
                Capability
              </th>
              {['Viewer', 'Commenter', 'Editor', 'Owner'].map((r) => (
                <th key={r} scope="col" className="border-b border-line px-3 py-2 text-center font-semibold">
                  {r}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {MATRIX.map(([cap, ...cells]) => (
              <tr key={cap}>
                <th scope="row" className="border-b border-line py-2.5 pr-4 text-left font-normal">
                  {cap}
                </th>
                {cells.map((c, i) => (
                  <td key={i} className={`border-b border-line px-3 py-2.5 text-center ${c === '✓' ? 'text-accent' : 'text-muted'}`}>
                    <span className="sr-only">{c === '✓' ? 'Allowed' : 'Not allowed'}</span>
                    <span aria-hidden>{c}</span>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="mt-8 grid gap-3 text-[15px] text-muted sm:grid-cols-2">
        <li>Passwords hashed with Argon2id; short-lived access tokens with rotating refresh tokens.</li>
        <li>Single-use, 60-second socket tickets bound to a user and a document.</li>
        <li>Uploads go straight to storage through signed URLs and are verified by content, not by file name.</li>
        <li>Every permission and sharing change is written to an audit log.</li>
      </ul>
    </section>
  );
}

const FAQ: Array<[string, string]> = [
  ['What happens if two people edit the same sentence?', 'Both edits survive. The document is a CRDT (Yjs), so concurrent operations merge deterministically on every client and the server.'],
  ['What is a block lock?', 'When you place your cursor in a paragraph, other editors see it marked with your name and cannot type into it until you move on. It prevents tangled edits; the CRDT still guarantees nothing is lost if a lock is bypassed.'],
  ['Does it work offline?', 'Yes. Changes are saved on your device immediately. When you reconnect, the client and server exchange what each missed and converge.'],
  ['Can viewers see who is editing?', 'Yes. Viewers receive live cursors and presence. Their own edit attempts are ignored by the server.'],
  ['Where are images stored?', 'In private object storage. The browser uploads directly through a signed URL and reads through short-lived signed links.'],
  ['Is there a free plan?', 'Confluo is free while in preview. Create an account and start writing.'],
];

export function Faq() {
  return (
    <section className="border-t border-line bg-surface">
      <div className="mx-auto max-w-3xl px-4 py-20">
        <h2 className="font-display text-3xl font-semibold sm:text-4xl">Questions</h2>
        <div className="mt-8 divide-y divide-line">
          {FAQ.map(([q, a]) => (
            <details key={q} className="group py-4">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-medium">
                {q}
                <span className="text-muted transition-transform group-open:rotate-45" aria-hidden>
                  +
                </span>
              </summary>
              <p className="mt-3 text-[15px] leading-relaxed text-muted">{a}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

export function FinalCta() {
  return (
    <section className="mx-auto max-w-6xl px-4 py-20 text-center">
      <h2 className="font-display text-3xl font-semibold sm:text-4xl">Write together. Never lose a word.</h2>
      <p className="mx-auto mt-3 max-w-xl text-muted">Create a document, share a link, and watch edits merge in real time.</p>
      <div className="mt-8 flex justify-center">
        <CtaLink location="footer">Start writing — free</CtaLink>
      </div>
    </section>
  );
}

export function Footer() {
  return (
    <footer className="border-t border-line">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-4 py-8 text-[13px] text-muted">
        <span className="font-display text-base text-ink">Confluo</span>
        <nav aria-label="Footer" className="flex gap-5">
          <a href="#product" className="hover:text-ink">
            Product
          </a>
          <a href="#how" className="hover:text-ink">
            How it works
          </a>
          <a href="#security" className="hover:text-ink">
            Security
          </a>
        </nav>
        <span>Built on Yjs, TipTap and Next.js.</span>
      </div>
    </footer>
  );
}
