import { Browser, expect, Page, request } from '@playwright/test';

const unique = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

const API = 'http://localhost:4100/api/v1';

/** Reads the newest email of a kind from the API's development mailbox and returns the first matching link. */
export async function emailLink(to: string, kind: string, path: string): Promise<string> {
  const ctx = await request.newContext();
  try {
    for (let i = 0; i < 50; i++) {
      const res = await ctx.get(`${API}/dev/mailbox?to=${encodeURIComponent(to)}`);
      const { messages } = (await res.json()) as { messages: { kind: string; text: string }[] };
      const mail = messages.filter((m) => m.kind === kind).pop();
      const m = mail && new RegExp(`(http://localhost:3100${path}\\?token=[A-Za-z0-9_-]+(?:&next=[^\\s]+)?)`).exec(mail.text);
      if (m) return m[1]!;
      await new Promise((r) => setTimeout(r, 100));
    }
  } finally {
    await ctx.dispose();
  }
  throw new Error(`no ${kind} email for ${to}`);
}

/** Sign-up ends with "check your email"; following the emailed link confirms the address and signs in. */
export async function register(page: Page, name: string, email: string, landing: RegExp | string = 'Home') {
  if (!page.url().includes('/register')) await page.goto('/register');
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password').fill('correct-horse-battery');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  await page.goto(await emailLink(email, 'email_verification', '/verify-email'));
  if (landing) await expect(page.getByRole('heading', { name: landing }).first()).toBeVisible();
}

/** Owner creates a team org and project; the teammate joins through an invitation link. */
export async function teamWithProject(page: Page, browser: Browser) {
  const miaEmail = `mia-${unique()}@example.com`;
  await register(page, 'Olivia', `olivia-${unique()}@example.com`);
  await page.getByRole('button', { name: '+ New organisation' }).click();
  await page.getByLabel('Organisation name').fill('Studio');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'General' })).toBeVisible();
  await page.getByRole('link', { name: 'Members & settings' }).click();
  await page.getByRole('tab', { name: 'Invitations' }).click();
  await page.getByLabel('Email', { exact: true }).fill(miaEmail);
  await page.getByLabel('Add to workspace').selectOption({ label: 'General' });
  await page.getByRole('button', { name: 'Create invitation' }).click();
  const inviteUrl = await page.getByLabel('Invitation link').inputValue();

  const mia = await (await browser.newContext()).newPage();
  await register(mia, 'Mia', miaEmail);
  await mia.goto(inviteUrl);
  await mia.getByRole('button', { name: 'Accept invitation' }).click();
  await expect(mia.getByRole('heading', { name: 'General' })).toBeVisible();

  await page.getByRole('link', { name: 'General' }).click();
  await page.getByRole('button', { name: 'Create a project' }).click();
  await page.getByLabel('Project name').fill('Website');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.waitForURL(/\/project\?id=/);
  return { mia, projectUrl: page.url() };
}

export const taskButton = (page: Page, title: string) => page.locator('table').getByRole('button', { name: title, exact: true });

/** After clicking "Create account": check-your-email screen, then follow the emailed link. */
export async function confirmSignUp(page: Page, email: string, landing: string = 'Home') {
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  await page.goto(await emailLink(email, 'email_verification', '/verify-email'));
  await expect(page.getByRole('heading', { name: landing }).first()).toBeVisible();
}
