import { expect, Page, test } from '@playwright/test';
import { teamWithProject } from '../helpers';

async function addRow(page: Page, name: string) {
  await page.getByRole('button', { name: '+ New row' }).click();
  const input = page.getByLabel('Name of Untitled');
  await input.fill(name);
  await input.press('Enter');
  await expect(page.getByLabel(`Name of ${name}`)).toBeVisible();
}

test('databases: fields, rows, live updates, saved filter, board, row page, CSV export and import', async ({ page, browser }) => {
  const { mia } = await teamWithProject(page, browser);

  // Olivia creates a database in the team workspace.
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Databases' }).click();
  await page.getByLabel('Workspace', { exact: true }).selectOption({ label: 'Studio · General' });
  await page.getByRole('button', { name: 'New database' }).first().click();
  await page.getByRole('dialog', { name: 'New database' }).getByLabel('Name').fill('Clients');
  await page.getByRole('button', { name: 'Create database' }).click();
  await expect(page.getByLabel('Database name')).toHaveValue('Clients');

  // A number field.
  await page.getByRole('button', { name: 'Add a field' }).click();
  const fd = page.getByRole('dialog', { name: 'New field' });
  await fd.getByLabel('Field name').fill('Deal value');
  await fd.getByLabel('Type').selectOption('number');
  await fd.getByRole('button', { name: 'Create field' }).click();
  await expect(page.getByRole('columnheader', { name: 'Deal value' })).toBeVisible();

  await addRow(page, 'Acme');
  await page.getByLabel('Status of Acme').selectOption({ label: 'In progress' });
  await page.getByLabel('Deal value of Acme').fill('1200');
  await page.getByLabel('Deal value of Acme').press('Enter');
  await addRow(page, 'Globex');
  await page.getByLabel('Deal value of Globex').fill('300');
  await page.getByLabel('Deal value of Globex').press('Enter');
  await expect(page.getByText('2 rows')).toBeVisible();

  // Mia opens it; a row Olivia adds appears for her without reloading.
  const dbUrl = page.url();
  await mia.goto(dbUrl);
  await expect(mia.getByLabel('Name of Acme')).toBeVisible();
  await addRow(page, 'Initech');
  await expect(mia.getByLabel('Name of Initech')).toBeVisible();
  await expect(mia.getByLabel('Deal value of Acme')).toHaveValue('1200');

  // A filter on the view is saved: Deal value > 500.
  await page.getByText('Filter', { exact: true }).click();
  const filter = page.getByRole('group', { name: 'Filter' });
  await filter.getByRole('button', { name: '+ Add filter' }).click();
  await filter.getByLabel('Filter 1 field').selectOption({ label: 'Deal value' });
  await filter.getByLabel('Filter 1 condition').selectOption('gt');
  await filter.getByLabel('Filter 1 value').fill('500');
  await expect(page.getByText('1 of 3 rows')).toBeVisible();
  await expect(page.getByLabel('Name of Globex')).toHaveCount(0);
  await page.waitForTimeout(1000); // debounced save of the view
  await page.reload();
  await expect(page.getByText('1 of 3 rows')).toBeVisible();

  // Board grouped by Status; open a card as a page, write notes, move it to Done.
  await page.getByRole('tab', { name: /Board/ }).click();
  await expect(page.locator('[data-column="doing"]')).toContainText('Acme');
  await page.locator('[data-column="doing"]').getByRole('button', { name: 'Acme' }).click();
  const drawer = page.getByRole('dialog', { name: 'Row: Acme' });
  await drawer.getByLabel('Row page (Markdown)').fill('Kickoff on **Monday**');
  await expect(drawer.getByText('All changes saved')).toBeVisible();
  await drawer.getByLabel('Status of Acme').selectOption({ label: 'Done' });
  await drawer.getByRole('button', { name: 'Close row' }).click();
  await expect(page.locator('[data-column="done"]')).toContainText('Acme');
  await expect(mia.getByLabel('Status of Acme')).toHaveValue('done');

  // CSV export contains readable values.
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: 'Export CSV' }).click()]);
  expect(download.suggestedFilename()).toBe('Clients.csv');
  const chunks: Buffer[] = [];
  for await (const c of await download.createReadStream()) chunks.push(c as Buffer);
  const csv = Buffer.concat(chunks).toString('utf8').replace(/^\ufeff/, '');
  expect(csv.split('\r\n')[0]).toBe('Name,Status,Deal value');
  expect(csv).toContain('Acme,Done,1200');
  expect(csv).toContain('Globex,,300');

  // Import a Notion-style CSV as a new database; types are guessed.
  await page.getByRole('button', { name: 'Import CSV…' }).first().click();
  const imp = page.getByRole('dialog', { name: 'Import CSV' });
  await imp.getByLabel('CSV file').setInputFiles({
    name: 'Leads 0123456789abcdef0123456789abcdef.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('Name,Stage,Next call,Budget\nDunder,Hot,"March 4, 2026",5000\nVance,Cold,2026-04-01,120\nSabre,Hot,,\n'),
  });
  await expect(imp.getByLabel('Database name')).toHaveValue('Leads');
  await expect(imp.getByLabel('Type of Stage')).toHaveValue('select');
  await expect(imp.getByLabel('Type of Next call')).toHaveValue('date');
  await expect(imp.getByLabel('Type of Budget')).toHaveValue('number');
  await imp.getByRole('button', { name: 'Import' }).click();
  await expect(imp).toHaveCount(0);
  await expect(page.getByLabel('Database name')).toHaveValue('Leads');
  await expect(page.getByText('3 rows')).toBeVisible();
  await expect(page.getByLabel('Next call of Dunder')).toHaveValue('2026-03-04');
  await expect(page.getByLabel('Stage of Vance')).toHaveValue(/.+/);
  await expect(page.getByRole('navigation', { name: 'Databases' }).getByRole('link', { name: /Leads/ })).toBeVisible();
});
