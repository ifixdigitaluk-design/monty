import { expect, test } from '@playwright/test';
import { teamWithProject } from '../helpers';

test('team chat: channel, live message with mention, thread reply, reaction, direct message', async ({ page, browser }) => {
  const { mia } = await teamWithProject(page, browser);

  // Olivia creates #general in the team workspace.
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /^Chat/ }).click();
  await page.getByLabel('Workspace', { exact: true }).selectOption({ label: 'Studio · General' });
  await page.getByRole('button', { name: 'New channel' }).click();
  const dlg = page.getByRole('dialog', { name: 'New channel' });
  await dlg.getByLabel('Name', { exact: true }).fill('General');
  await dlg.getByRole('button', { name: 'Create channel' }).click();
  await expect(page.getByRole('heading', { name: '# general' })).toBeVisible();

  // Mia opens chat and joins; she then watches live.
  await mia.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /^Chat/ }).click();
  await mia.getByLabel('Workspace', { exact: true }).selectOption({ label: 'Studio · General' });
  await mia.getByRole('button', { name: /Channel general/ }).click();
  await mia.getByRole('button', { name: 'Join channel' }).click();
  await expect(mia.getByLabel('Message #general')).toBeVisible();

  // Olivia mentions Mia using the @ picker.
  const box = page.getByLabel('Message #general');
  await box.fill('Morning @Mi');
  await page.getByRole('listbox', { name: 'Mention someone' }).getByRole('button', { name: 'Mia' }).click();
  await box.pressSequentially('can you review the homepage?');
  await box.press('Enter');
  await expect(page.getByRole('log', { name: 'Messages in general' })).toContainText('Morning @Mia can you review the homepage?');

  // Mia sees it live (no reload) and replies in a thread.
  const log = mia.getByRole('log', { name: 'Messages in general' });
  await expect(log).toContainText('Morning @Mia can you review the homepage?');
  await log.getByRole('button', { name: 'Reply in thread' }).click();
  const thread = mia.getByRole('complementary', { name: 'Thread' });
  await thread.getByLabel('Reply').fill('On it 👍');
  await thread.getByLabel('Reply').press('Enter');
  await expect(thread.getByRole('log', { name: 'Thread replies' })).toContainText('On it 👍');
  await expect(page.getByRole('log', { name: 'Messages in general' }).getByRole('button', { name: '1 reply' })).toBeVisible();

  // Reaction from Olivia, visible to Mia.
  await page.getByRole('log', { name: 'Messages in general' }).getByLabel('Add reaction').click();
  await page.getByRole('button', { name: 'React with 🎉' }).click();
  await expect(log.getByRole('button', { name: /🎉 1/ })).toBeVisible();

  // Direct message.
  await page.getByRole('button', { name: 'New direct message' }).click();
  await page.getByRole('dialog', { name: 'New direct message' }).getByLabel('Mia').check();
  await page.getByRole('button', { name: 'Open conversation' }).click();
  await page.getByLabel('Message Mia').fill('Thanks!');
  await page.getByLabel('Message Mia').press('Enter');
  await expect(mia.getByRole('button', { name: /Direct message with Olivia, 1 unread/ })).toBeVisible();
  await mia.getByRole('button', { name: /Direct message with Olivia/ }).click();
  await expect(mia.getByRole('log', { name: 'Messages in Olivia' })).toContainText('Thanks!');
});
