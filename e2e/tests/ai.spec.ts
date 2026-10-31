import { expect, test } from '@playwright/test';
import { register, taskButton } from '../helpers';

test('plan with AI: review a proposal, pick tasks, add them', async ({ page }) => {
  await register(page, 'Ivy', `ivy-${Date.now()}@example.com`);
  await page.getByRole('link', { name: 'Personal', exact: true }).click();
  await page.getByRole('button', { name: 'Create a project' }).click();
  await page.getByLabel('Project name').fill('Spring campaign');
  await page.getByLabel('Objective').fill('Run a social media campaign for the spring sale');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.waitForURL(/\/project\?id=/);

  await page.getByRole('button', { name: '✦ Plan with AI' }).click();
  const dialog = page.getByRole('dialog', { name: 'Plan with AI' });
  await dialog.getByRole('button', { name: 'Suggest tasks' }).click();
  await expect(dialog.getByText('Define audience and key message', { exact: true })).toBeVisible();
  await expect(dialog.getByText(/Suggested by Basic planner/)).toBeVisible();
  // Nothing is added until approved.
  await expect(page.locator('table')).toHaveCount(0);

  await dialog.getByRole('checkbox').nth(1).uncheck();
  const add = dialog.getByRole('button', { name: /^Add \d+ tasks?$/ });
  const label = await add.textContent();
  await add.click();
  await expect(page.getByText(/Added \d+ tasks to the project/)).toBeVisible();
  await expect(taskButton(page, 'Confirm scope and success criteria')).toBeVisible();
  await expect(taskButton(page, 'Agree owners and stakeholders')).toHaveCount(0);
  const n = Number(/\d+/.exec(label ?? '')![0]);
  await expect(page.locator('table tbody tr')).toHaveCount(n);
});
