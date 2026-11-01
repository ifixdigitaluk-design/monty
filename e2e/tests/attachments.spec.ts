import { expect, test } from '@playwright/test';
import { taskButton, teamWithProject } from '../helpers';

// A 1×1 transparent PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

test('attachments: task file is shared with the team and downloads intact; chat message with an image', async ({ page, browser }) => {
  const { mia, projectUrl } = await teamWithProject(page, browser);

  // Olivia attaches a text file to a task.
  await page.getByLabel('New task title').fill('Brief');
  await page.getByRole('button', { name: 'Add task' }).click();
  await taskButton(page, 'Brief').click();
  const drawer = page.getByRole('dialog', { name: 'Task: Brief' });
  await drawer.locator('input[type=file]').setInputFiles({ name: 'brief notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Launch on Monday\n') });
  const files = drawer.getByRole('list', { name: 'Attached files' });
  await expect(files).toContainText('brief notes.txt');

  // Mia (team member) sees it and downloads the exact bytes.
  await mia.goto(projectUrl);
  await taskButton(mia, 'Brief').click();
  const miaFiles = mia.getByRole('dialog', { name: 'Task: Brief' }).getByRole('list', { name: 'Attached files' });
  await expect(miaFiles).toContainText('brief notes.txt');
  // Mia didn't upload it and isn't an admin, so she can't remove it.
  await expect(miaFiles.getByRole('button', { name: 'Remove brief notes.txt' })).toHaveCount(0);
  const [download] = await Promise.all([mia.waitForEvent('download'), miaFiles.getByRole('link', { name: /brief notes\.txt/ }).click()]);
  expect(download.suggestedFilename()).toBe('brief notes.txt');
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(c as Buffer);
  expect(Buffer.concat(chunks).toString()).toBe('Launch on Monday\n');

  // Olivia removes it (after confirming).
  page.once('dialog', (d) => {
    expect(d.message()).toBe('Delete brief notes.txt?');
    void d.accept();
  });
  await files.getByRole('button', { name: 'Remove brief notes.txt' }).click();
  await expect(drawer.getByText('No files yet.')).toBeVisible();

  // Chat: post a message with only an image; Mia sees the thumbnail live.
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /^Chat/ }).click();
  await page.getByLabel('Workspace', { exact: true }).selectOption({ label: 'Studio · General' });
  await page.getByRole('button', { name: 'New channel' }).click();
  const dlg = page.getByRole('dialog', { name: 'New channel' });
  await dlg.getByLabel('Name', { exact: true }).fill('Design');
  await dlg.getByRole('button', { name: 'Create channel' }).click();
  await mia.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /^Chat/ }).click();
  await mia.getByLabel('Workspace', { exact: true }).selectOption({ label: 'Studio · General' });
  await mia.getByRole('button', { name: /Channel design/ }).click();
  await mia.getByRole('button', { name: 'Join channel' }).click();

  await page.locator('form input[type=file]').setInputFiles({ name: 'mock.png', mimeType: 'image/png', buffer: PNG });
  await expect(page.getByRole('button', { name: 'Remove mock.png' })).toBeVisible();
  await page.getByRole('button', { name: 'Send' }).click();
  const log = mia.getByRole('log', { name: 'Messages in design' });
  await expect(log.getByRole('img', { name: 'mock.png' })).toBeVisible();
  // The thumbnail actually loaded (served inline because the bytes are a real PNG).
  await expect.poll(() => log.getByRole('img', { name: 'mock.png' }).evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(1);
});
