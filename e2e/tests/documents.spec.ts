import { expect, test } from '@playwright/test';
import { confirmSignUp } from '../helpers';

const unique = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

test('write a project document with autosave, preview, history and restore', async ({ page }) => {
  await page.goto('/register');
  await page.getByLabel('Name').fill('Dana');
  const email = `dana-${unique()}@example.com`;
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password').fill('correct-horse-battery');
  await page.getByRole('button', { name: 'Create account' }).click();
  await confirmSignUp(page, email);

  await page.getByRole('link', { name: 'Personal', exact: true }).click();
  await page.getByRole('button', { name: 'Create a project' }).click();
  await page.getByLabel('Project name').fill('Rebrand');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.waitForURL(/\/project\?id=/);

  await page.getByRole('button', { name: 'New project doc' }).click();
  await page.waitForURL(/\/docs\?ws=.*&id=/);
  await page.getByLabel('Page title').fill('Brand brief');
  await page.getByLabel('Page content (Markdown)').fill('## Goals\n\n- [x] New logo\n- [ ] **Colour** palette\n\n[Guide](https://example.com) [bad](javascript:alert(1))');
  await expect(page.locator('[data-doc-save="saved"]')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole('navigation', { name: 'Pages' })).toContainText('Brand brief');

  await page.getByRole('tab', { name: 'preview' }).click();
  const preview = page.locator('[data-doc-preview]');
  await expect(preview.getByRole('heading', { name: 'Goals' })).toBeVisible();
  await expect(preview.getByRole('checkbox', { name: 'done', exact: true })).toBeChecked();
  await expect(preview.locator('strong')).toHaveText('Colour');
  await expect(preview.getByRole('link', { name: 'Guide' })).toHaveAttribute('href', 'https://example.com');
  await expect(preview.getByRole('link', { name: 'bad' })).toHaveCount(0);

  // Persisted after reload.
  await page.reload();
  await expect(page.getByLabel('Page title')).toHaveValue('Brand brief');
  await expect(page.locator('[data-doc-preview]')).toContainText('New logo');

  // History + restore the first version (empty page).
  await page.getByRole('button', { name: 'History' }).click();
  const restoreButtons = page.locator('#history-title').locator('../..').getByRole('button', { name: 'Restore' });
  await restoreButtons.last().click();
  await expect(page.getByText(/Restored version 1/)).toBeVisible();
  await expect(page.getByLabel('Page title')).toHaveValue('Untitled');

  // Searchable from Ctrl+K.
  await page.getByRole('tab', { name: 'write' }).click();
  await page.getByLabel('Page content (Markdown)').fill('Typography decisions live here');
  await expect(page.locator('[data-doc-save="saved"]')).toBeVisible({ timeout: 10_000 });
  await page.keyboard.press('Control+k');
  await page.getByLabel('Search projects, tasks and comments').fill('typograph');
  await expect(page.getByRole('option').first()).toContainText('document');
});
