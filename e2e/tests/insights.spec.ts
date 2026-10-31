import { expect, test } from '@playwright/test';

const unique = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

test('home dashboard, quick search and calendar', async ({ page }) => {
  await page.goto('/register');
  await page.getByLabel('Name').fill('Sam');
  await page.getByLabel('Email', { exact: true }).fill(`sam-${unique()}@example.com`);
  await page.getByLabel('Password').fill('correct-horse-battery');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
  await expect(page.getByText('Nothing is blocked, at risk or missing essentials.')).toBeVisible();

  await page.getByRole('link', { name: 'Personal', exact: true }).click();
  await page.getByRole('button', { name: 'Create a project' }).click();
  await page.getByLabel('Project name').fill('Quarterly newsletter');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.waitForURL(/\/project\?id=/);
  const today = new Date();
  const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  await page.getByLabel('New task title').fill('Draft subscriber survey');
  await page.getByRole('button', { name: 'Add task' }).click();
  await page.getByLabel('Due date of Draft subscriber survey').fill(iso);
  await page.getByLabel('Assignee of Draft subscriber survey').selectOption({ label: 'Sam' });
  await expect(page.locator('[data-save-state="saved"]')).toBeVisible();

  // Home shows the draft project needing attention and today's task.
  await page.getByRole('link', { name: 'Home' }).click();
  await expect(page.locator('[data-attention="Quarterly newsletter"]')).toContainText('Draft');
  await expect(page.locator('[data-stat="Due today"]')).toContainText('1');

  // Ctrl+K search opens the task.
  await page.keyboard.press('Control+k');
  await page.getByLabel('Search projects, tasks and comments').fill('subscr surv');
  await expect(page.getByRole('option').first()).toContainText('Draft subscriber survey');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Task: Draft subscriber survey' })).toBeVisible();

  // Calendar shows it on today's date.
  await page.keyboard.press('Escape');
  await page.getByRole('link', { name: 'Calendar' }).click();
  await expect(page.locator(`[data-date="${iso}"]`)).toContainText('Draft subscriber survey');
  // Two months ahead, today's date is no longer on the grid.
  await page.getByRole('button', { name: 'Next month' }).click();
  await page.getByRole('button', { name: 'Next month' }).click();
  await expect(page.locator(`[data-date="${iso}"]`)).toHaveCount(0);
  await page.getByRole('button', { name: 'Today' }).click();
  await expect(page.locator(`[data-date="${iso}"]`)).toContainText('Draft subscriber survey');
});
