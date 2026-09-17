// Focused check: an edit made while offline resyncs after reconnect. Prints the client connection log.
import { chromium } from '@playwright/test';
const WEB = process.env.WEB_URL ?? 'http://localhost:3000';

async function login(browser, email) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  await page.goto(`${WEB}/login`);
  await page.fill('#email', email);
  await page.fill('#password', 'password123!');
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/docs/, { timeout: 20000 });
  return { ctx, page };
}
const text = (p) => p.locator('.confluo-editor').innerText();
const badge = (p) => p.locator('[aria-label^="Connection:"]').getAttribute('aria-label');
const until = async (fn, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn().catch(() => false)) return true; await new Promise((r) => setTimeout(r, 200)); } return false; };
const dumpLog = async (p, label) => {
  const entries = await p.evaluate(() => (window.__confluo?.log ?? []).slice(-12).map((e) => `${e.level} ${e.message}`));
  console.log(`--- ${label} log ---\n  ` + entries.join('\n  '));
};

const browser = await chromium.launch();
const alice = await login(browser, 'alice@confluo.dev');
const bob = await login(browser, 'bob@confluo.dev');
await alice.page.getByRole('link', { name: /Welcome to Confluo/ }).first().click();
await alice.page.waitForURL(/\/docs\/[0-9a-f-]+/);
await bob.page.goto(alice.page.url());
for (const w of [alice, bob]) await w.page.locator('.confluo-editor').waitFor({ state: 'visible', timeout: 20000 });
await until(async () => (await badge(alice.page))?.includes('Connected'));
console.log('alice badge:', await badge(alice.page));

const stamp = `offline-${Date.now()}`;
await alice.ctx.setOffline(true);
// Close the real socket too: Chromium keeps established WebSockets alive under emulated offline.
await alice.page.evaluate(() => window.__confluo?.handle?.provider?.provider?.ws?.close());
await until(async () => /Offline|Reconnecting/.test((await badge(alice.page)) ?? ''), 10000);
console.log('alice badge while offline:', await badge(alice.page));
const p1 = alice.page.locator('.confluo-editor > p').first();
await p1.click();
await alice.page.keyboard.press('End');
await alice.page.keyboard.type(` ${stamp}`);
await alice.page.waitForTimeout(2500);
console.log('bob has it while alice offline (expect false):', (await text(bob.page)).includes(stamp));
await dumpLog(alice.page, 'alice (offline)');

await alice.ctx.setOffline(false);
const resynced = await until(async () => (await text(bob.page)).includes(stamp), 25000);
const back = await until(async () => (await badge(alice.page))?.includes('Connected'), 10000);
console.log('resynced to bob:', resynced, '| alice badge after:', await badge(alice.page), '| back to connected:', back);
await dumpLog(alice.page, 'alice (after online)');
await browser.close();
process.exit(resynced && back ? 0 : 1);
