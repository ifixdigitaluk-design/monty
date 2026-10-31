import { expect, test } from '@playwright/test';
import { teamWithProject } from '../helpers';

test('owner fixes: chat channels manage/delete, database delete, plan change; meetings end to end', async ({ page, browser }) => {
  const { mia } = await teamWithProject(page, browser);
  const nav = (p: typeof page, name: string) => p.getByRole('navigation', { name: 'Main' }).getByRole('link', { name }).click();
  page.on('dialog', (d) => void d.accept(d.type() === 'prompt' ? 'sales' : undefined));

  // Chat: two channels, delete one (typed confirmation).
  await nav(page, 'Chat');
  await page.getByLabel('Workspace', { exact: true }).selectOption({ label: 'Studio · General' });
  for (const n of ['general', 'sales']) {
    await page.getByRole('button', { name: 'New channel' }).click();
    await page.getByRole('dialog', { name: 'New channel' }).getByLabel('Name', { exact: true }).fill(n);
    await page.getByRole('button', { name: 'Create channel' }).click();
    await expect(page.getByRole('heading', { name: `# ${n}` })).toBeVisible();
  }
  await page.getByRole('button', { name: 'Details' }).click();
  await page.getByRole('button', { name: 'Delete channel' }).click();
  await expect(page.getByRole('button', { name: /Channel sales/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Channel general/ })).toBeVisible();

  // Databases: visible delete.
  await nav(page, 'Databases');
  await page.getByLabel('Workspace', { exact: true }).selectOption({ label: 'Studio · General' });
  await page.getByRole('button', { name: 'New database' }).first().click();
  await page.getByRole('dialog', { name: 'New database' }).getByLabel('Name').fill('Temp');
  await page.getByRole('button', { name: 'Create database' }).click();
  await page.getByRole('button', { name: 'Delete database' }).click();
  await expect(page.getByRole('navigation', { name: 'Databases' }).getByText('None yet.')).toBeVisible();

  // Plan: owner switches to Enterprise.
  await page.getByRole('link', { name: 'Members & settings' }).click();
  await page.getByRole('tab', { name: 'Plan & usage' }).click();
  await page.getByLabel('Plan', { exact: true }).selectOption('ENTERPRISE');
  await page.getByRole('button', { name: 'Change plan' }).click();
  await expect(page.getByText('Current plan:')).toContainText('Enterprise');

  // Meetings: schedule with Mia → she's notified, writes minutes and an action.
  await nav(page, 'Meetings');
  await page.getByLabel('Workspace', { exact: true }).selectOption({ label: 'Studio · General' });
  await page.getByRole('button', { name: 'Schedule meeting' }).click();
  const dlg = page.getByRole('dialog', { name: 'Schedule meeting' });
  await dlg.getByLabel('Title').fill('Design review');
  await dlg.getByLabel('Mia').check();
  await dlg.getByLabel('Agenda').fill('Homepage options');
  await dlg.getByRole('button', { name: 'Schedule and invite' }).click();
  const panel = page.getByRole('dialog', { name: 'Meeting: Design review' });
  await expect(panel.getByRole('link', { name: 'Join video call' })).toHaveAttribute('href', /^https:\/\/meet\.jit\.si\/Monty-/);

  await nav(mia, 'Inbox');
  await mia.getByText(/invited you to “Design review”/).click();
  const mp = mia.getByRole('dialog', { name: 'Meeting: Design review' });
  await mp.getByRole('textbox', { name: 'Minutes' }).fill('Option B chosen');
  await mp.getByRole('textbox', { name: 'Minutes' }).blur();
  await expect(mia.getByText('Minutes saved')).toBeVisible();
  await mp.getByLabel('New action item').fill('Send mock-ups');
  await mp.getByRole('button', { name: 'Add' }).click();
  await expect(mp.getByRole('checkbox', { name: 'Send mock-ups' })).toBeVisible();
  await expect(mp.getByRole('button', { name: 'Cancel meeting' })).toHaveCount(0); // only organiser/admins
});
