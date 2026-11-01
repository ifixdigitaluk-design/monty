import { expect, test } from '@playwright/test';
import { Pool } from 'pg';
import { register, taskButton } from '../helpers';

async function db<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const pool = new Pool({ connectionString: process.env.E2E_DATABASE_URL ?? 'postgresql://monty:monty_dev@localhost:5432/monty_e2e' });
  try {
    return (await pool.query(sql, params)).rows as T[];
  } finally {
    await pool.end();
  }
}

test('automation: build a rule in the UI and see it act on a new task', async ({ page }) => {
  const email = `ada-${Date.now()}@example.com`;
  await register(page, 'Ada', email);
  await page.getByRole('link', { name: 'Personal', exact: true }).click();
  await page.getByRole('button', { name: 'Create a project' }).click();
  await page.getByLabel('Project name').fill('Ops');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.waitForURL(/\/project\?id=/);
  const projectUrl = page.url();

  // The project page's breadcrumb also links to "Personal" once it has loaded; use the sidebar's.
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Personal', exact: true }).click();
  await page.getByRole('link', { name: 'Automations' }).click();
  await expect(page.getByRole('heading', { name: 'Automations' })).toBeVisible();
  const automationsUrl = page.url();
  await page.getByRole('button', { name: 'Create an automation' }).click();
  const dialog = page.getByRole('dialog', { name: 'New automation' });
  await dialog.getByLabel('Name').fill('Start new work');
  await dialog.getByLabel('When').selectOption('task.created');
  await dialog.getByLabel('Action 1 type').selectOption('set_status');
  await dialog.getByLabel('Action 1 status').selectOption('IN_PROGRESS');
  await dialog.getByRole('button', { name: 'Add action' }).click();
  await dialog.getByLabel('Action 2 priority').selectOption('URGENT');
  await dialog.getByRole('button', { name: 'Save automation' }).click();
  const rules = page.getByRole('list', { name: 'Automations' });
  await expect(rules.getByText('Set status to In progress')).toBeVisible();
  await expect(rules.getByText('Set priority to Urgent')).toBeVisible();

  await page.goto(projectUrl);
  await page.getByLabel('New task title').fill('Check backups');
  await page.getByRole('button', { name: 'Add task' }).click();
  await expect(taskButton(page, 'Check backups')).toBeVisible();

  await expect
    .poll(async () => (await db<{ status: string; priority: string }>(`select t.status, t.priority from tasks t join users u on u.id = t.creator_id where u.email = $1`, [email]))[0], { timeout: 10_000 })
    .toEqual({ status: 'IN_PROGRESS', priority: 'URGENT' });
  // The open project page picks the change up live (SSE) without a reload.
  await expect(page.locator('table tbody tr').filter({ hasText: 'Check backups' })).toContainText('In progress');

  await page.goto(automationsUrl);
  await expect(page.getByText('succeeded')).toBeVisible();
  await page.getByRole('button', { name: 'Turn off Start new work' }).click();
  await expect(page.getByText('Off', { exact: true })).toBeVisible();
});
