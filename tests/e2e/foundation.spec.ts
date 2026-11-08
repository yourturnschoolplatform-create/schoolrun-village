import { expect, test } from '@playwright/test';

test('shows the mobile-first email sign-up entrypoint and three-step onboarding structure', async ({ page }) => {
  await page.goto('/');

  await expect(page).toHaveTitle('SchoolRun Village');
  await expect(page.getByRole('heading', { name: 'Start with your email.' })).toBeVisible();
  await expect(page.getByLabel('Email address')).toBeVisible();
  await expect(page.getByLabel('Password')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create account' })).toBeVisible();
  const progress = page.getByRole('list', { name: 'Onboarding progress' });
  await expect(progress).toContainText('Account');
  await expect(progress).toContainText('School');
  await expect(progress).toContainText('Safety');
  await expect(page.getByText('No payments', { exact: true })).toBeVisible();
  await expect(page.getByText('No live location tracking', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /swap|match|payment/i })).toHaveCount(0);
});

test('keeps an unavailable invitation generic before approval', async ({ page }) => {
  await page.goto('/?invite=not-a-valid-invitation-token-000000000000');

  await expect(page.getByText('This invitation link is unavailable. No school details were revealed.')).toBeVisible();
  await expect(page.getByText(/Sample Harbourview Primary School|Sample Rivergum Primary School/)).toHaveCount(0);
});

test('exposes installable PWA and route metadata', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', '/manifest.webmanifest');
  const routes = await page.evaluate(async () => (await fetch('/manus-routes.json')).json());
  expect(routes).toEqual({ routes: [{ path: '/', title: 'SchoolRun Village foundation' }] });
});
