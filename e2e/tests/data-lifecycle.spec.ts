import { expect, request, test } from '@playwright/test';
import { register } from '../helpers';

const API = 'http://localhost:4100/api/v1';

async function latestLink(to: string, kind: string, path: string): Promise<string> {
  const ctx = await request.newContext();
  for (let i = 0; i < 40; i++) {
    const { messages } = (await (await ctx.get(`${API}/dev/mailbox?to=${encodeURIComponent(to)}`)).json()) as { messages: { kind: string; text: string }[] };
    const m = messages.filter((x) => x.kind === kind).pop();
    const match = m && new RegExp(`(http://localhost:3100${path}\\?token=[A-Za-z0-9_-]+)`).exec(m.text);
    if (match) return match[1]!;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`no ${kind} email`);
}

test('data lifecycle: export my data, delete and restore an organisation, delete my account', async ({ page }) => {
  const email = `life-${Date.now()}@example.com`;
  await register(page, 'Lena', email);

  // Export
  await page.getByRole('link', { name: 'Account & data' }).click();
  await expect(page.getByRole('heading', { name: 'Account & data', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Prepare export' }).click();
  const link = page.getByRole('link', { name: /Download export/ });
  await expect(link).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent('download'), link.click()]);
  expect(download.suggestedFilename()).toMatch(/^monty-export-\d{4}-\d{2}-\d{2}\.json$/);
  const body = JSON.parse(await (await import('node:fs/promises')).readFile((await download.path())!, 'utf8'));
  expect(body.account.email).toBe(email);

  // Organisation: rename, delete, restore
  await page.getByRole('button', { name: '+ New organisation' }).click();
  await page.getByLabel('Organisation name').fill('Temp Co');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.getByRole('link', { name: 'Members & settings' }).click();
  await page.getByRole('tab', { name: 'Settings' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Temp Ltd');
  await page.getByRole('button', { name: 'Save name' }).click();
  await expect(page.getByRole('heading', { name: 'Temp Ltd', level: 1 })).toBeVisible();
  await page.getByLabel('Type “Temp Ltd” to confirm').fill('Temp Ltd');
  await page.getByLabel('Your password').fill('correct-horse-battery');
  await page.getByRole('button', { name: 'Delete organisation' }).click();
  await page.waitForURL(/\/settings\/account/);
  await expect(page.getByRole('navigation', { name: 'Main' }).getByText('Temp Ltd')).toHaveCount(0);
  await page.getByRole('button', { name: 'Restore Temp Ltd' }).click();
  await expect(page.getByText('Temp Ltd was restored.')).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Main' }).getByText('Temp Ltd')).toBeVisible();

  // Account deletion (Temp Ltd has only Lena, so it is erased with the account)
  await page.getByLabel('Your password').fill('correct-horse-battery');
  await page.getByRole('button', { name: 'Email me a deletion link' }).click();
  await expect(page.getByText(/emailed you a confirmation link/)).toBeVisible();
  await page.goto(await latestLink(email, 'account_deletion', '/account/delete'));
  const confirm = page.getByRole('button', { name: 'Delete my account' });
  await expect(confirm).toBeDisabled();
  await page.getByLabel('Type DELETE to confirm').fill('DELETE');
  await confirm.click();
  await expect(page.getByRole('heading', { name: 'Your account was deleted' })).toBeVisible();

  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password').fill('correct-horse-battery');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('Email or password is incorrect')).toBeVisible();
});
