import { expect, test } from '@playwright/test';

// Uses the local OpenID provider started by playwright.config.ts in place of Google.
test('continue with Google: new account, sign out, sign back in to the same account, cancel shows a reason', async ({ page }) => {
  const email = `gina-${Date.now()}@example.com`;

  await page.goto('/login?next=/calendar');
  await page.getByRole('link', { name: 'Continue with Google' }).click();
  await expect(page.getByRole('heading', { name: 'Test identity provider' })).toBeVisible();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Name').fill('Gina');
  await page.getByRole('button', { name: 'Continue' }).click();

  // Signed in, confirmed, and returned to where they were going.
  await page.waitForURL(/\/calendar$/);
  const me = await (await page.request.get('/api/v1/auth/me')).json();
  expect(me.user).toMatchObject({ email, name: 'Gina', emailVerified: true });

  await page.goto('/home');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.waitForURL(/\/login/);

  await page.getByRole('link', { name: 'Continue with Google' }).click();
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.waitForURL(/\/home$/);
  expect((await (await page.request.get('/api/v1/auth/me')).json()).user.id).toBe(me.user.id);

  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.getByRole('link', { name: 'Continue with Google' }).click();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await page.waitForURL(/\/login\?error=google_cancelled/);
  await expect(page.getByText('Google sign-in was cancelled.')).toBeVisible();
});
