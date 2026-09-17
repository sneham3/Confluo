import { test, expect } from '@playwright/test';

// TODO: enable with @axe-core/playwright once the backend is wired in CI.
test.skip('landing page renders hero and CTA', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByRole('link', { name: /start writing/i }).first()).toBeVisible();
});
