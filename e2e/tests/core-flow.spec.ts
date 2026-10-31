import { Browser, expect, Page, test } from '@playwright/test';
import { Pool } from 'pg';

const dbUrl = process.env.E2E_DATABASE_URL ?? 'postgresql://monty:monty_dev@localhost:5432/monty_e2e';
const unique = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

async function db<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const pool = new Pool({ connectionString: dbUrl });
  try {
    return (await pool.query(sql, params)).rows as T[];
  } finally {
    await pool.end();
  }
}

async function register(page: Page, name: string) {
  const email = `${name.toLowerCase()}-${unique()}@example.com`;
  await page.goto('/register');
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password').fill('correct-horse-battery');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'My Tasks' })).toBeVisible();
  return email;
}

async function login(browser: Browser, email: string) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password').fill('correct-horse-battery');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'My Tasks' })).toBeVisible();
  return page;
}

/** Task title buttons inside the task views (the readiness panel can also list task titles). */
const taskButton = (page: Page, title: string) =>
  page.locator('table, [data-column]').getByRole('button', { name: title, exact: true });
const check = (page: Page, id: string) => page.locator(`[data-check="${id}"]`);
const saved = (page: Page) => expect(page.locator('[data-save-state="saved"]')).toBeVisible();

test('sign up → project → tasks → readiness → board → persistence → isolation → logout', async ({ page, browser }) => {
  const email = await register(page, 'Ana');
  await expect(page.getByText('Nothing assigned to you')).toBeVisible();

  // Personal workspace exists and is reachable from the sidebar.
  await page.getByRole('link', { name: 'Personal', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Personal' })).toBeVisible();

  // Create a project.
  await page.getByRole('button', { name: 'Create a project' }).click();
  await page.getByLabel('Project name').fill('Website relaunch');
  await page.getByLabel('Objective').fill('Launch the redesigned marketing site');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.waitForURL(/\/project\?id=/);
  await expect(page.getByLabel('Project name')).toHaveValue('Website relaunch');
  const projectUrl = page.url();

  // Readiness explains exactly what is missing.
  await expect(page.getByText('Draft', { exact: true })).toBeVisible();
  await expect(check(page, 'objective_defined')).toHaveAttribute('data-passed', 'true');
  await expect(check(page, 'owner_assigned')).toHaveAttribute('data-passed', 'false');
  await expect(check(page, 'has_tasks')).toHaveAttribute('data-passed', 'false');

  // Fix the gaps.
  await page.getByLabel('Project owner').selectOption({ label: 'Ana' });
  await saved(page);
  await page.getByLabel('Project target date').fill('2030-06-30');
  await expect(check(page, 'target_date_set')).toHaveAttribute('data-passed', 'true');
  await expect(check(page, 'owner_assigned')).toHaveAttribute('data-passed', 'true');

  await page.getByLabel('New task title').fill('Design homepage');
  await page.getByRole('button', { name: 'Add task' }).click();
  await expect(taskButton(page, 'Design homepage')).toBeVisible();
  await expect(check(page, 'tasks_assigned')).toHaveAttribute('data-passed', 'false');

  await page.getByLabel('Assignee of Design homepage').selectOption({ label: 'Ana' });
  await expect(check(page, 'tasks_assigned')).toHaveAttribute('data-passed', 'true');
  await expect(page.getByText('Ready to start', { exact: true })).toBeVisible();

  // Same records in board view; move via the keyboard-accessible status control.
  await page.getByRole('tab', { name: 'board' }).click();
  const inProgress = page.locator('[data-column="IN_PROGRESS"]');
  await page.getByLabel('Status of Design homepage').selectOption('IN_PROGRESS');
  await expect(inProgress.getByRole('button', { name: 'Design homepage' })).toBeVisible();
  await saved(page);

  // Persistence: reload and verify server state, and the database itself.
  await page.reload();
  await expect(page.getByLabel('Status of Design homepage')).toHaveValue('IN_PROGRESS');
  const rows = await db<{ status: string; version: number }>(
    `select t.status, t.version from tasks t join projects p on p.id = t.project_id where p.name = 'Website relaunch' and t.title = 'Design homepage' order by t.created_at desc limit 1`,
  );
  expect(rows[0]).toMatchObject({ status: 'IN_PROGRESS' });

  // Blocker via the drawer → project computed status becomes Blocked once Active.
  await taskButton(page, 'Design homepage').click();
  const drawer = page.getByRole('dialog', { name: 'Task: Design homepage' });
  await drawer.getByLabel('Blocked by').fill('Waiting for brand assets');
  await drawer.getByLabel('Blocked by').blur();
  await saved(page);
  await page.keyboard.press('Escape');
  await page.getByLabel('Project stage').selectOption('ACTIVE');
  await expect(page.getByText('Blocked', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('1 open task blocked.')).toBeVisible();

  // My Tasks shows it.
  await page.getByRole('link', { name: 'My Tasks' }).click();
  await expect(page.getByRole('link', { name: 'Design homepage' })).toBeVisible();

  // Conflict handling: a second session (same user) edits first; the stale write is refused visibly.
  const other = await login(browser, email);
  await other.goto(projectUrl);
  await other.getByLabel('Priority of Design homepage').selectOption('URGENT');
  await expect(other.locator('[data-save-state="saved"]')).toBeVisible();

  await page.goto(projectUrl);
  await expect(page.getByLabel('Priority of Design homepage')).toHaveValue('URGENT');
  // Make this page stale by changing again from the other session.
  await other.getByLabel('Priority of Design homepage').selectOption('LOW');
  await expect(other.locator('[data-save-state="saved"]')).toBeVisible();
  await page.getByLabel('Status of Design homepage').selectOption('IN_REVIEW');
  await expect(page.getByText('Someone else changed this task')).toBeVisible();
  await expect(page.getByLabel('Priority of Design homepage')).toHaveValue('LOW'); // server version loaded, nothing overwritten
  await page.getByRole('button', { name: 'Re-apply mine' }).click();
  await expect(page.getByLabel('Status of Design homepage')).toHaveValue('IN_REVIEW');
  await expect(page.getByLabel('Priority of Design homepage')).toHaveValue('LOW');

  // Isolation: a different user cannot open this project.
  const ctxB = await browser.newContext();
  const pageB = await ctxB.newPage();
  await register(pageB, 'Bob');
  await pageB.goto(projectUrl);
  await expect(pageB.getByText('Project not found')).toBeVisible();

  // Logout revokes the session.
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in to Monty' })).toBeVisible();
  await page.goto('/tasks');
  await expect(page.getByRole('heading', { name: 'Sign in to Monty' })).toBeVisible();
});

test('rapid successive edits to the same record are all saved (no false conflicts)', async ({ page }) => {
  await register(page, 'Quick');
  await page.getByRole('link', { name: 'Personal', exact: true }).click();
  await page.getByRole('button', { name: 'Create a project' }).click();
  await page.getByLabel('Project name').fill('Rapid edits');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.waitForURL(/\/project\?id=/);
  await expect(page.getByLabel('Project name')).toHaveValue('Rapid edits');

  // Fire edits back-to-back without waiting for "saved" in between.
  await page.getByLabel('Project owner').selectOption({ label: 'Quick' });
  await page.getByLabel('Project target date').fill('2030-06-30');
  await page.getByLabel('Project start date').fill('2030-01-01');
  await page.getByLabel('New task title').fill('Task one');
  await page.getByRole('button', { name: 'Add task' }).click();
  await expect(taskButton(page, 'Task one')).toBeVisible();
  await page.getByLabel('Assignee of Task one').selectOption({ label: 'Quick' });
  await page.getByLabel('Priority of Task one').selectOption('HIGH');
  await page.getByLabel('Due date of Task one').fill('2030-02-01');
  await page.getByLabel('Status of Task one').selectOption('IN_PROGRESS');
  await expect(page.locator('[data-save-state="saved"]')).toBeVisible();
  await expect(page.getByText('Someone else changed')).toHaveCount(0);

  await page.reload();
  await expect(page.getByLabel('Project target date')).toHaveValue('2030-06-30');
  await expect(page.getByLabel('Project start date')).toHaveValue('2030-01-01');
  await expect(page.getByLabel('Project owner')).not.toHaveValue('');
  await expect(page.getByLabel('Assignee of Task one')).not.toHaveValue('');
  await expect(page.getByLabel('Priority of Task one')).toHaveValue('HIGH');
  await expect(page.getByLabel('Due date of Task one')).toHaveValue('2030-02-01');
  await expect(page.getByLabel('Status of Task one')).toHaveValue('IN_PROGRESS');
});

test('team organisation and workspace creation', async ({ page }) => {
  await register(page, 'Owner');
  await page.getByRole('button', { name: '+ New organisation' }).click();
  await page.getByLabel('Organisation name').fill('Acme Agency');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'General' })).toBeVisible();
  await page.getByRole('button', { name: 'New workspace in Acme Agency' }).click();
  await page.getByLabel('Workspace name').fill('Client Work');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Client Work' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('link', { name: 'Client Work' })).toBeVisible();
});

test('unauthenticated visitors are sent to sign in and returned afterwards', async ({ page, browser }) => {
  const email = await register(page, 'Ret');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.goto('/settings/sessions');
  await expect(page).toHaveURL(/\/login\?next=%2Fsettings%2Fsessions/);
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password').fill('correct-horse-battery');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Sessions & security' })).toBeVisible();
  await expect(page.getByText('This device')).toBeVisible();
  void browser;
});
