import { Browser, expect, Page } from '@playwright/test';

const unique = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

export async function register(page: Page, name: string, email: string) {
  await page.goto('/register');
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password').fill('correct-horse-battery');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
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
