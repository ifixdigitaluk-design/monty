import { expect, Page, request, test } from '@playwright/test';

const API = 'http://localhost:4100/api/v1';
const unique = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

/** Reads the newest email of a kind from the API's development mailbox (log transport only). */
async function latestLink(to: string, kind: string, path: string): Promise<string> {
  const ctx = await request.newContext();
  for (let i = 0; i < 20; i++) {
    const res = await ctx.get(`${API}/dev/mailbox?to=${encodeURIComponent(to)}`);
    const { messages } = (await res.json()) as { messages: { kind: string; text: string }[] };
    const mail = messages.filter((m) => m.kind === kind).pop();
    const m = mail && new RegExp(`(http://localhost:3100${path}\\?token=[A-Za-z0-9_-]+)`).exec(mail.text);
    if (m) {
      await ctx.dispose();
      return m[1]!;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`no ${kind} email for ${to}`);
}

async function register(page: Page, email: string) {
  await page.goto('/register');
  await page.getByLabel('Name').fill('Rosa');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password').fill('correct-horse-battery');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
}

test('email verification from the sign-up email', async ({ page }) => {
  const email = `rosa-${unique()}@example.com`;
  await register(page, email);
  const banner = page.getByRole('region', { name: 'Email confirmation' });
  await expect(banner).toContainText(email);

  await page.goto(await latestLink(email, 'email_verification', '/verify-email'));
  await expect(page.getByText('your email address is confirmed')).toBeVisible();
  await page.getByRole('link', { name: 'Continue to Monty' }).click();
  await expect(page.getByRole('heading', { name: 'My Tasks' })).toBeVisible();
  await expect(banner).toHaveCount(0);
});

test('forgot password → email link → new password → old sessions signed out', async ({ page, browser }) => {
  const email = `reset-${unique()}@example.com`;
  await register(page, email);

  // A second device stays signed in until the reset.
  const other = await (await browser.newContext()).newPage();
  await other.goto('/login');
  await other.getByLabel('Email', { exact: true }).fill(email);
  await other.getByLabel('Password').fill('correct-horse-battery');
  await other.getByRole('button', { name: 'Sign in' }).click();
  await expect(other.getByRole('heading', { name: 'Home' })).toBeVisible();

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in to Monty' })).toBeVisible();
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByRole('link', { name: 'Forgot password?' }).click();
  await expect(page.getByLabel('Email', { exact: true })).toHaveValue(email);
  await page.getByRole('button', { name: 'Send reset link' }).click();
  await expect(page.getByRole('status')).toContainText('If an account exists');

  await page.goto(await latestLink(email, 'password_reset', '/reset-password'));
  await page.getByLabel('New password', { exact: true }).fill('a-brand-new-password');
  await page.getByLabel('Confirm new password').fill('a-brand-new-password');
  await page.getByRole('button', { name: 'Change password' }).click();
  await expect(page.getByText('signed out on every device')).toBeVisible();

  await other.reload();
  await expect(other.getByRole('heading', { name: 'Sign in to Monty' })).toBeVisible();

  await page.getByRole('link', { name: 'Sign in' }).click();
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password').fill('a-brand-new-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
  // The reset link proved inbox access, so the email is now confirmed.
  await expect(page.getByRole('region', { name: 'Email confirmation' })).toHaveCount(0);
});

test('unknown emails get the same reset response', async ({ page }) => {
  await page.goto('/forgot-password');
  await page.getByLabel('Email', { exact: true }).fill(`ghost-${unique()}@example.com`);
  await page.getByRole('button', { name: 'Send reset link' }).click();
  await expect(page.getByRole('status')).toContainText('If an account exists');
});
