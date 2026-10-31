import { expect, test } from '@playwright/test';
import { taskButton, teamWithProject } from '../helpers';

test('teammates see each other’s changes live, with presence', async ({ page, browser }) => {
  const { mia, projectUrl } = await teamWithProject(page, browser);
  await page.getByLabel('New task title').fill('Homepage copy');
  await page.getByRole('button', { name: 'Add task' }).click();
  await expect(taskButton(page, 'Homepage copy')).toBeVisible();

  await mia.goto(projectUrl);
  await expect(mia.locator('[data-live="live"]')).toBeVisible();
  await expect(page.locator('[data-presence]')).toContainText('Mia');
  await expect(mia.locator('[data-presence]')).toContainText('Olivia');

  // Olivia changes status and adds a task; Mia's page updates without reloading.
  await page.getByLabel('Status of Homepage copy').selectOption('IN_REVIEW');
  await expect(mia.getByLabel('Status of Homepage copy')).toHaveValue('IN_REVIEW', { timeout: 5000 });
  await page.getByLabel('New task title').fill('Hero image');
  await page.getByRole('button', { name: 'Add task' }).click();
  await expect(taskButton(mia, 'Hero image')).toBeVisible({ timeout: 5000 });

  // And the other way round; Mia's later edit is not refused as a stale write.
  await mia.getByLabel('Status of Homepage copy').selectOption('DONE');
  await expect(page.getByLabel('Status of Homepage copy')).toHaveValue('DONE', { timeout: 5000 });
  await expect(mia.getByText('Someone else changed this task')).toHaveCount(0);

  // Presence updates when Mia leaves.
  await mia.close();
  await expect(page.locator('[data-presence]')).toHaveCount(0, { timeout: 5000 });
});
