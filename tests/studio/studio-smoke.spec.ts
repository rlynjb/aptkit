import { expect, test } from '@playwright/test';

const pages = [
  { card: 'Recommendation Agent', heading: 'Recommendation Agent Replay' },
  { card: 'Anomaly Monitoring Agent', heading: 'Anomaly Monitoring Replay' },
  { card: 'Diagnostic Investigation Agent', heading: 'Diagnostic Investigation Replay' },
  { card: 'Query Agent', heading: 'Query Replay' },
  { card: 'Runtime & Eval Utilities', heading: 'Runtime & Eval Utilities' },
];

test('Studio cards open their workspaces', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Capability Gallery' })).toBeVisible();

  for (const entry of pages) {
    await page.getByRole('button', { name: new RegExp(entry.card) }).click();
    await expect(page.getByRole('heading', { name: entry.heading })).toBeVisible();
    await page.getByRole('button', { name: 'Home' }).click();
    await expect(page.getByRole('heading', { name: 'Capability Gallery' })).toBeVisible();
  }
});

test('Runtime utility fixture run increments the run counter and renders panels', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Runtime & Eval Utilities/ }).click();
  await expect(page.getByRole('heading', { name: 'Runtime & Eval Utilities' })).toBeVisible();

  const runMetric = page.locator('.metric').filter({ hasText: 'Run' }).locator('strong');
  await expect(runMetric).toHaveText('#1');

  await page.getByRole('button', { name: 'Run Fixtures' }).click();
  await expect(runMetric).toHaveText('#2');

  await expect(page.getByRole('heading', { name: 'Structured Generation' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Rubric Judge' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Content Workflow' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Provider Fallback' })).toBeVisible();
  await expect(page.getByText('Checkout payment failures', { exact: true })).toBeVisible();
  await expect(page.getByText('cloud-fixture').first()).toBeVisible();
});
