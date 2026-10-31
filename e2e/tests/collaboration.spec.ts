import { Browser, expect, Page, test } from '@playwright/test';

const unique = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

async function register(page: Page, name: string, email: string) {
  await page.goto('/register');
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password').fill('correct-horse-battery');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'My Tasks' })).toBeVisible();
}

/** Owner creates a team org and project; the teammate joins through an invitation link. */
async function teamWithProject(page: Page, browser: Browser) {
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

const taskButton = (page: Page, title: string) => page.locator('table').getByRole('button', { name: title, exact: true });

test('milestones, dependencies, comments with mentions, and the inbox', async ({ page, browser }) => {
  const { mia, projectUrl } = await teamWithProject(page, browser);

  // Milestone.
  await page.getByLabel('New milestone name').fill('Beta launch');
  await page.getByLabel('New milestone due date').fill('2030-05-01');
  await page.getByRole('button', { name: 'Add milestone' }).click();
  await expect(page.locator('[data-milestone="Beta launch"]')).toContainText('0/0 tasks');

  // Two tasks; assign one to Mia (notifies her).
  for (const t of ['Design', 'Build']) {
    await page.getByLabel('New task title').fill(t);
    await page.getByRole('button', { name: 'Add task' }).click();
    await expect(taskButton(page, t)).toBeVisible();
  }
  await page.getByLabel('Assignee of Build').selectOption({ label: 'Mia' });
  await expect(page.locator('[data-save-state="saved"]')).toBeVisible();

  // Drawer: milestone + dependency + comment mentioning Mia.
  await taskButton(page, 'Build').click();
  const drawer = page.getByRole('dialog', { name: 'Task: Build' });
  await drawer.getByLabel('Milestone of Build').selectOption({ label: 'Beta launch' });
  await expect(page.locator('[data-milestone="Beta launch"]')).toContainText('0/1 tasks');
  await drawer.getByLabel('Add dependency').selectOption({ label: 'Design' });
  await expect(drawer.getByRole('button', { name: 'Remove dependency on Design' })).toBeVisible();
  await drawer.getByLabel('Write a comment (Comments)').fill('Ready when design lands');
  await drawer.getByLabel('Mention someone').selectOption({ label: 'Mia' });
  await drawer.getByRole('button', { name: 'Comment' }).click();
  await expect(drawer.locator('[data-comment]')).toContainText('@Mia');

  // Cycle is refused with a visible error.
  await page.keyboard.press('Escape');
  await taskButton(page, 'Design').click();
  await page.getByRole('dialog', { name: 'Task: Design' }).getByLabel('Add dependency').selectOption({ label: 'Build' });
  await expect(page.getByText('That would create a circular dependency')).toBeVisible();

  // Mia's inbox.
  await mia.goto('/tasks');
  await expect(mia.getByRole('link', { name: /Inbox \(2\)/ })).toBeVisible();
  await mia.getByRole('link', { name: /Inbox/ }).click();
  await expect(mia.locator('[data-notification="mention"]')).toContainText('Olivia mentioned you on “Build”');
  await expect(mia.locator('[data-notification="assigned"]')).toContainText('Olivia assigned you “Build”');
  await mia.locator('[data-notification="mention"]').click();
  const miaDrawer = mia.getByRole('dialog', { name: 'Task: Build' });
  await expect(miaDrawer.locator('[data-comment]')).toContainText('Ready when design lands');
  await miaDrawer.getByLabel('Write a comment (Comments)').fill('On it');
  await miaDrawer.getByRole('button', { name: 'Comment' }).click();
  await expect(miaDrawer.locator('[data-comment]')).toHaveCount(2);
  await mia.goto('/inbox');
  await expect(mia.getByRole('link', { name: /Inbox \(1\)/ })).toBeVisible();

  // Readiness reflects the dependency (Design is still open, so Build waits).
  await page.goto(projectUrl);
  await expect(page.locator('[data-check="dependencies_ordered"]')).toHaveAttribute('data-passed', 'true');
});
