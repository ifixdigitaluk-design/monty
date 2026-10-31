import { expect, Page, test } from '@playwright/test';

const unique = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

async function register(page: Page, name: string, email: string) {
  await page.goto('/register');
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password').fill('correct-horse-battery');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'My Tasks' })).toBeVisible();
}

test('invite a teammate → they sign up from the link → access, roles, audit, removal', async ({ page, browser }) => {
  const bobEmail = `bob-${unique()}@example.com`;
  await register(page, 'Olivia', `olivia-${unique()}@example.com`);

  // Team org with a project.
  await page.getByRole('button', { name: '+ New organisation' }).click();
  await page.getByLabel('Organisation name').fill('Northwind Studio');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'General' })).toBeVisible();
  const workspaceUrl = page.url();
  await page.getByRole('button', { name: 'Create a project' }).click();
  await page.getByLabel('Project name').fill('Client launch');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.waitForURL(/\/project\?id=/);

  // Invite Bob as member of the General workspace.
  await page.getByRole('link', { name: 'Members & settings' }).click();
  await page.getByRole('tab', { name: 'Invitations' }).click();
  await page.getByLabel('Email', { exact: true }).fill(bobEmail);
  await page.getByLabel('Organisation role').selectOption('MEMBER');
  await page.getByLabel('Add to workspace').selectOption({ label: 'General' });
  await page.getByLabel('Workspace role').selectOption('MEMBER');
  await page.getByRole('button', { name: 'Create invitation' }).click();
  const inviteUrl = await page.getByLabel('Invitation link').inputValue();
  expect(inviteUrl).toMatch(/\/invite\?token=[A-Za-z0-9_-]+$/);
  await expect(page.getByText(bobEmail).last()).toBeVisible(); // in pending list

  // Bob opens the link signed out, creates an account (email prefilled), accepts.
  const bobCtx = await browser.newContext();
  const bob = await bobCtx.newPage();
  await bob.goto(inviteUrl);
  await expect(bob.getByRole('heading', { name: 'Join Northwind Studio' })).toBeVisible();
  await bob.getByRole('link', { name: 'Create account' }).click();
  await expect(bob.getByLabel('Email', { exact: true })).toHaveValue(bobEmail);
  await bob.getByLabel('Name').fill('Bob');
  await bob.getByLabel('Password').fill('correct-horse-battery');
  await bob.getByRole('button', { name: 'Create account' }).click();
  await expect(bob.getByRole('heading', { name: 'Join Northwind Studio' })).toBeVisible();
  await bob.getByRole('button', { name: 'Accept invitation' }).click();
  await expect(bob.getByRole('heading', { name: 'General' })).toBeVisible();
  await expect(bob.getByRole('link', { name: /Client launch/ })).toBeVisible();
  await expect(bob.getByText('Personal', { exact: true }).first()).toBeVisible(); // personal space kept

  // The link is single-use.
  await bob.goto(inviteUrl);
  await expect(bob.getByText('This invitation is accepted')).toBeVisible();

  // Olivia promotes Bob to admin.
  await page.reload();
  await page.getByRole('tab', { name: /Members/ }).click();
  await page.getByLabel('Role of Bob').selectOption('ADMIN');
  await expect(page.getByText('Bob is now admin.')).toBeVisible();

  // Audit log shows what happened.
  await page.getByRole('tab', { name: 'Audit log' }).click();
  await expect(page.locator('[data-audit="member.role_changed"]')).toContainText('MEMBER → ADMIN');
  await expect(page.locator('[data-audit="invitation.accepted"]')).toContainText('Bob');
  await expect(page.locator('[data-audit="invitation.created"]')).toContainText(bobEmail);

  // Workspace access: demote Bob to member, then grant/revoke via Manage access.
  await page.getByRole('tab', { name: /Members/ }).click();
  await page.getByLabel('Role of Bob').selectOption('MEMBER');
  await expect(page.getByText('Bob is now member.')).toBeVisible();
  await page.goto(workspaceUrl);
  await page.getByRole('button', { name: 'Manage access' }).click();
  await page.getByLabel('Workspace access for Bob').selectOption('');
  await page.getByRole('button', { name: 'Done' }).click();
  await bob.goto(workspaceUrl);
  await expect(bob.getByText('Workspace not found')).toBeVisible();

  // Removal.
  await page.getByRole('link', { name: 'Members & settings' }).click();
  page.once('dialog', (d) => void d.accept());
  await page.getByRole('button', { name: 'Remove Bob' }).click();
  await expect(page.getByText('Bob was removed.')).toBeVisible();
  await bob.goto('/tasks');
  await expect(bob.getByRole('link', { name: 'Members & settings' })).toHaveCount(0);
  await bobCtx.close();
});

test('an invitation cannot be accepted from a different account', async ({ page, browser }) => {
  await register(page, 'Owner', `owner-${unique()}@example.com`);
  await page.getByRole('button', { name: '+ New organisation' }).click();
  await page.getByLabel('Organisation name').fill('Guarded Co');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.getByRole('link', { name: 'Members & settings' }).click();
  await page.getByRole('tab', { name: 'Invitations' }).click();
  await page.getByLabel('Email', { exact: true }).fill(`intended-${unique()}@example.com`);
  await page.getByRole('button', { name: 'Create invitation' }).click();
  const inviteUrl = await page.getByLabel('Invitation link').inputValue();

  const ctx = await browser.newContext();
  const other = await ctx.newPage();
  await register(other, 'Mallory', `mallory-${unique()}@example.com`);
  await other.goto(inviteUrl);
  await expect(other.getByText(/This invitation is for intended-/)).toBeVisible();
  await expect(other.getByRole('button', { name: 'Accept invitation' })).toBeDisabled();
  await ctx.close();
});
