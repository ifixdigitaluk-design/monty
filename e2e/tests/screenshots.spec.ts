import { expect, test } from '@playwright/test';

// Visual review helper: `SCREENSHOTS=1 pnpm e2e` writes PNGs to e2e/screenshots/.
test.skip(!process.env.SCREENSHOTS, 'screenshots only on demand');

test('capture key screens', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/register');
  await page.screenshot({ path: 'screenshots/01-register.png' });
  await page.getByLabel('Name').fill('Priya');
  await page.getByLabel('Email', { exact: true }).fill(`priya-${Date.now()}@example.com`);
  await page.getByLabel('Password').fill('correct-horse-battery');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'My Tasks' })).toBeVisible();

  await page.getByRole('link', { name: 'Personal', exact: true }).click();
  await page.getByRole('button', { name: 'Create a project' }).click();
  await page.getByLabel('Project name').fill('Spring campaign launch');
  await page.getByLabel('Objective').fill('Launch the spring campaign across web, email and social by end of March.');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.waitForURL(/\/project\?id=/);
  await expect(page.getByLabel('Project name')).toHaveValue('Spring campaign launch');
  await page.screenshot({ path: 'screenshots/02-project-draft.png' });

  await page.getByLabel('Project owner').selectOption({ label: 'Priya' });
  await page.getByLabel('Project target date').fill('2030-03-31');
  for (const t of ['Write campaign brief', 'Design email template', 'Schedule social posts', 'Landing page copy']) {
    await page.getByLabel('New task title').fill(t);
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(page.getByRole('table').getByRole('button', { name: t, exact: true })).toBeVisible();
  }
  await page.getByLabel('Assignee of Write campaign brief').selectOption({ label: 'Priya' });
  await page.getByLabel('Due date of Write campaign brief').fill('2030-01-15');
  await page.getByLabel('Status of Design email template').selectOption('IN_PROGRESS');
  await expect(page.locator('[data-save-state="saved"]')).toBeVisible();
  await page.screenshot({ path: 'screenshots/03-project-list.png', fullPage: true });

  await page.getByRole('tab', { name: 'board' }).click();
  await page.screenshot({ path: 'screenshots/04-project-board.png', fullPage: true });

  await page.locator('[data-column]').getByRole('button', { name: 'Write campaign brief', exact: true }).click();
  await page.screenshot({ path: 'screenshots/05-task-drawer.png' });

  await page.emulateMedia({ colorScheme: 'dark' });
  await page.keyboard.press('Escape');
  await page.getByRole('tab', { name: 'list' }).click();
  await page.screenshot({ path: 'screenshots/06-dark.png', fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.getByLabel('Project name')).toBeVisible();
  await page.waitForTimeout(400);
  await page.screenshot({ path: 'screenshots/07-mobile.png' });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: 'screenshots/08-mobile-nav.png' });

  await page.setViewportSize({ width: 1400, height: 900 });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/tasks');
  await page.getByRole('button', { name: '+ New organisation' }).click();
  await page.getByLabel('Organisation name').fill('Northwind Studio');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.getByRole('link', { name: 'Members & settings' }).click();
  await page.getByRole('tab', { name: 'Invitations' }).click();
  await page.getByLabel('Email', { exact: true }).fill('sam@example.com');
  await page.getByRole('button', { name: 'Create invitation' }).click();
  await expect(page.getByLabel('Invitation link')).toBeVisible();
  await page.screenshot({ path: 'screenshots/09-invitations.png', fullPage: true });
  await page.getByRole('tab', { name: 'Audit log' }).click();
  await expect(page.locator('[data-audit]').first()).toBeVisible();
  await page.screenshot({ path: 'screenshots/10-audit.png', fullPage: true });
});
