// End-to-end verification against a running stack (server on :4000, web on :3000).
// Run: node scripts/verify-e2e.mjs
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const WEB = process.env.WEB_URL ?? 'http://localhost:3000';
const API = process.env.API_URL ?? 'http://localhost:4000';
const OUT = process.env.SHOT_DIR ?? '../../docs/screenshots';
mkdirSync(OUT, { recursive: true });

const results = [];
const run = Date.now().toString(36); // unique per run: the document persists between runs
function check(name, ok, extra = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  (' + extra + ')' : ''}`);
}
async function waitFor(fn, ms = 15000, step = 200) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, step));
  }
  return false;
}
async function api(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${API}/v1${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Origin: WEB,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function login(browser, email, password) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`  [${email}] pageerror: ${e.message}`));
  await page.goto(`${WEB}/login`);
  await page.fill('#email', email);
  await page.fill('#password', password);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/docs/, { timeout: 20000 });
  return { ctx, page };
}

const editorText = (page) => page.locator('.confluo-editor').innerText();

const browser = await chromium.launch();
try {
  // 1. Landing page
  const lp = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  await lp.goto(WEB, { waitUntil: 'networkidle' });
  const h1 = await lp.locator('h1').first().innerText();
  check('landing page renders headline', h1.length > 5, h1.replace(/\s+/g, ' ').slice(0, 60));
  await lp.screenshot({ path: `${OUT}/landing.png`, fullPage: true });
  await lp.context().close();

  // 2. Two collaborators
  const alice = await login(browser, 'alice@confluo.dev', 'password123!');
  const bob = await login(browser, 'bob@confluo.dev', 'password123!');
  check('login redirects to dashboard', alice.page.url().includes('/docs'));
  await alice.page.screenshot({ path: `${OUT}/dashboard.png` });

  const link = alice.page.getByRole('link', { name: 'Welcome to Confluo' }).first();
  await link.click();
  await alice.page.waitForURL(/\/docs\/[0-9a-f-]+/);
  const docUrl = alice.page.url();
  await bob.page.goto(docUrl);

  for (const who of [alice, bob]) {
    await who.page.locator('.confluo-editor').waitFor({ state: 'visible', timeout: 20000 });
  }
  const seededOk = await waitFor(async () => (await editorText(alice.page)).includes('Welcome to Confluo'));
  check('editor loads seeded content', !!seededOk);

  // Alice edits paragraph 1 and creates paragraph 2, then returns to paragraph 1 (keeping its lock).
  // Bob then types into paragraph 2, which is free. (Splitting Alice's locked paragraph would be rejected.)
  const p1 = alice.page.locator('.confluo-editor > p').first();
  await p1.click();
  await alice.page.keyboard.press('End');
  await alice.page.keyboard.type(` Alice was here ${run}.`);
  await alice.page.keyboard.press('Enter');
  await alice.page.keyboard.type(`Second paragraph ${run}.`);
  await p1.click();

  const bobSeesP2 = await waitFor(async () => (await editorText(bob.page)).includes(`Second paragraph ${run}.`));
  check('new paragraph from Alice appears for Bob', !!bobSeesP2);
  await bob.page.locator('.confluo-editor > p').nth(1).click();
  await bob.page.keyboard.press('End');
  await bob.page.keyboard.type(` Bob adds ${run}.`);

  const aSeesB = await waitFor(async () => (await editorText(alice.page)).includes(`Bob adds ${run}.`));
  const bSeesA = await waitFor(async () => (await editorText(bob.page)).includes(`Alice was here ${run}.`));
  check('Bob\'s edit appears in Alice\'s editor', !!aSeesB);
  check('Alice\'s edit appears in Bob\'s editor', !!bSeesA);

  // Presence: Bob should see Alice's caret label.
  const caret = await waitFor(async () => {
    const labels = await bob.page.locator('.collaboration-carets__label').allInnerTexts();
    return labels.some((l) => /alice/i.test(l)) ? labels : false;
  });
  check('remote caret with name is visible', !!caret, caret ? caret.join(',') : '');

  // Soft lock as presence: Alice is writing in paragraph 1 → Bob sees her name on it.
  await p1.click();
  const locked = await waitFor(async () => (await bob.page.locator('.confluo-editor > .is-locked').count()) > 0, 8000);
  check('paragraph shows who is writing in it', !!locked);

  // Co-editing: both type into the SAME paragraph at the SAME time. Nothing is blocked, nothing is lost.
  const bobP1 = bob.page.locator('.confluo-editor > p').first();
  await bobP1.click();
  await bob.page.keyboard.press('Home');
  await alice.page.keyboard.press('End');
  await Promise.all([
    alice.page.keyboard.type(` ALICE-${run}-together`, { delay: 35 }),
    bob.page.keyboard.type(`BOB-${run}-together `, { delay: 35 }),
  ]);
  // Compare document text only: remote caret labels live inside the paragraph's DOM.
  const paraText = (page) =>
    page.evaluate(() => {
      const p = document.querySelector('.confluo-editor > p')?.cloneNode(true);
      if (!p) return '';
      p.querySelectorAll('.collaboration-carets__caret, .collaboration-carets__label').forEach((n) => n.remove());
      return p.textContent ?? '';
    });
  let lastTexts = ['', ''];
  const both = await waitFor(async () => {
    const [a, b] = [await paraText(alice.page), await paraText(bob.page)];
    lastTexts = [a, b];
    const ok = (t) => t.includes(`ALICE-${run}-together`) && t.includes(`BOB-${run}-together`);
    return ok(a) && ok(b) && a === b ? a : false;
  }, 10000);
  check(
    'both people type in the same paragraph at once; text converges with nothing lost',
    !!both,
    both ? '' : `alice sees: "${lastTexts[0].slice(-120)}" | bob sees: "${lastTexts[1].slice(0, 120)}"`,
  );

  // Destructive guard: while Alice is writing there, Bob cannot restyle (replace) her paragraph.
  await alice.page.keyboard.type('.');
  await bob.page.waitForTimeout(700);
  await bobP1.click();
  await bob.page.keyboard.press('Control+Alt+1');
  await bob.page.waitForTimeout(900);
  const restyled = (await bob.page.locator('.confluo-editor > h1').count()) + (await alice.page.locator('.confluo-editor > h1').count());
  check('restyling a paragraph someone is writing in is refused', restyled === 0);

  await alice.page.screenshot({ path: `${OUT}/editor-alice.png` });
  await bob.page.screenshot({ path: `${OUT}/editor-bob.png` });

  // Offline edit by Alice resyncs after reconnect.
  await alice.ctx.setOffline(true);
  // Chromium keeps an established WebSocket alive under emulated offline, so drop it for real
  // through the dev-only hook; the client must then hold the edit locally and resync later.
  await alice.page.evaluate(() => window.__confluo?.handle?.provider?.provider?.ws?.close());
  // Wait until the client has noticed the loss of connectivity before typing.
  const badgeLocator = alice.page.locator('[aria-label^="Connection:"]');
  await waitFor(async () => /Offline|Reconnecting/i.test((await badgeLocator.getAttribute('aria-label')) ?? ''), 10000);
  await p1.click();
  await alice.page.keyboard.press('End');
  await alice.page.keyboard.type(` offline-${run}`);
  await alice.page.waitForTimeout(1500);
  const offlineBadge = await badgeLocator.getAttribute('aria-label');
  const notYet = !(await editorText(bob.page)).includes(`offline-${run}`);
  const aliceHasIt = (await editorText(alice.page)).includes(`offline-${run}`);
  await alice.ctx.setOffline(false);
  const resynced = await waitFor(async () => (await editorText(bob.page)).includes(`offline-${run}`), 25000);
  await waitFor(async () => /Connected/.test((await badgeLocator.getAttribute('aria-label')) ?? ''), 15000);
  const badgeAfter = await badgeLocator.getAttribute('aria-label');
  check(
    'offline edit resyncs after reconnect',
    !!resynced && notYet && /Connected/.test(badgeAfter ?? ''),
    `while offline: badge="${offlineBadge}", aliceHasIt=${aliceHasIt}, bobNotYet=${notYet}; after: badge="${badgeAfter}", resynced=${!!resynced}`,
  );

  // Title save with If-Match (SaveController) → Bob sees rename via doc.updated event.
  const title = alice.page.getByLabel('Document title');
  await title.click();
  await title.fill(`Welcome to Confluo (${run})`);
  await title.press('Tab');
  const renamed = await waitFor(async () => (await bob.page.getByLabel('Document title').inputValue()) === `Welcome to Confluo (${run})`, 15000);
  check('title rename propagates to the other user', !!renamed);

  // Viewer via share link: register Carol through the API, Alice creates a viewer link, Carol accepts in the UI.
  const docId = docUrl.split('/docs/')[1];
  const aliceTok = (await api('/auth/login', { method: 'POST', body: { email: 'alice@confluo.dev', password: 'password123!' } })).json.accessToken;
  const carolEmail = `carol+${Date.now()}@confluo.dev`;
  const reg = await api('/auth/register', { method: 'POST', body: { email: carolEmail, password: 'password123!', displayName: 'Carol' } });
  check('register via API', reg.status === 201, `status ${reg.status}`);
  const linkRes = await api(`/docs/${docId}/share-links`, { method: 'POST', token: aliceTok, body: { role: 'viewer' } });
  check('owner creates a viewer share link', linkRes.status === 201 && !!linkRes.json?.url, `status ${linkRes.status}`);
  const carol = await login(browser, carolEmail, 'password123!');
  await carol.page.goto(linkRes.json.url);
  await carol.page.waitForURL(/\/docs\/[0-9a-f-]+/, { timeout: 20000 });
  await carol.page.locator('.confluo-editor').waitFor({ state: 'visible', timeout: 20000 });
  const ce = await carol.page.locator('.confluo-editor').getAttribute('contenteditable');
  const sees = await waitFor(async () => (await editorText(carol.page)).includes(`Bob adds ${run}.`));
  check('viewer sees the document read-only', ce === 'false' && !!sees, `contenteditable=${ce}`);
  await carol.page.screenshot({ path: `${OUT}/editor-viewer.png` });
  await carol.ctx.close();

  await alice.ctx.close();
  await bob.ctx.close();
} catch (err) {
  console.error('ERROR', err);
  results.push({ name: 'script completed', ok: false });
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
