import { test, expect } from '@playwright/test';

// TODO: enable once apps/server (API + sync) runs in CI. Requires seeded users alice/bob (see apps/server seed).
test.skip('register, create a doc, type, reload, text persists', async ({ page }) => {
  await page.goto('/register');
  await page.getByLabel('Email').fill(`e2e-${Date.now()}@example.com`);
  await page.getByLabel('Password').fill('password123!');
  await page.getByLabel('Display name').fill('E2E');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: /new document/i }).click();
  await page.locator('.confluo-editor').click();
  await page.keyboard.type('hello persistence');
  await page.reload();
  await expect(page.locator('.confluo-editor')).toContainText('hello persistence');
});

test.skip('two contexts see each other’s text and carets', async ({ browser }) => {
  // TODO: log in alice and bob in two contexts, open the same doc, type in A, assert in B and caret label.
  const a = await browser.newContext();
  const b = await browser.newContext();
  await a.close();
  await b.close();
});

test.skip('viewer cannot type and sees the banner', async () => {
  // TODO: share a doc as viewer with bob, open as bob, assert banner and non-editable.
});
