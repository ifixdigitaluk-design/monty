import { expect, test } from '@playwright/test';
import { teamWithProject } from '../helpers';

test('CRM: company, contact, activity, follow-up for a colleague, deal through the pipeline, quote and print', async ({ page, browser }) => {
  const { mia } = await teamWithProject(page, browser);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'CRM' }).click();
  await page.getByLabel('Workspace', { exact: true }).selectOption({ label: 'Studio · General' });
  await expect(page.getByText('Your CRM is empty')).toBeVisible();

  // Company.
  await page.getByRole('button', { name: 'New company' }).click();
  await page.getByRole('dialog', { name: 'New company' }).getByLabel('Name').fill('Acme Ltd');
  await page.getByRole('button', { name: 'Create' }).click();
  const company = page.getByRole('dialog', { name: 'Company: Acme Ltd' });
  await company.getByLabel('Industry').fill('Manufacturing');
  await company.getByLabel('Industry').press('Enter');
  await company.getByRole('button', { name: 'Close' }).click();

  // Contact at the company, with a logged call and a follow-up for Mia.
  await page.getByRole('button', { name: 'New contact' }).click();
  const nc = page.getByRole('dialog', { name: 'New contact' });
  await nc.getByLabel('Name').fill('Jo Bloggs');
  await nc.getByLabel('Email').fill('jo@acme.test');
  await nc.getByLabel('Company').selectOption({ label: 'Acme Ltd' });
  await nc.getByRole('button', { name: 'Create' }).click();
  const contact = page.getByRole('dialog', { name: 'Contact: Jo Bloggs' });
  await contact.getByLabel('Activity type').selectOption('call');
  await contact.getByLabel('Activity summary').fill('Intro call');
  await contact.getByLabel('Activity details').fill('Wants a rollout in Q1');
  await contact.getByRole('button', { name: 'Log' }).click();
  await expect(contact.getByText('Wants a rollout in Q1')).toBeVisible();
  await contact.getByLabel('Activity summary').fill('Send pricing');
  const tomorrow = new Date(Date.now() + 86400_000);
  const local = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}T10:00`;
  await contact.getByLabel('Follow-up date and time').fill(local);
  await contact.getByLabel('Follow-up assignee').selectOption({ label: 'Mia' });
  await contact.getByRole('button', { name: 'Schedule' }).click();
  await expect(contact.getByText('for Mia')).toBeVisible();
  await contact.getByRole('button', { name: 'Close' }).click();

  // Deal, moved through the pipeline.
  await page.getByRole('button', { name: 'New deal' }).click();
  const nd = page.getByRole('dialog', { name: 'New deal' });
  await nd.getByLabel('Deal title').fill('Acme rollout');
  await nd.getByLabel('Company').selectOption({ label: 'Acme Ltd' });
  await nd.getByLabel('Contact').selectOption({ label: 'Jo Bloggs' });
  await nd.getByLabel('Value (GBP)').fill('12,500');
  await nd.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByRole('dialog', { name: 'Deal: Acme rollout' }).getByLabel('Deal value')).toHaveValue('12500.00');
  await page.getByRole('dialog', { name: 'Deal: Acme rollout' }).getByRole('button', { name: 'Close' }).click();
  await page.getByRole('tab', { name: 'Pipeline' }).click();
  await expect(page.locator('[data-stage="lead"]')).toContainText('Acme rollout');
  await page.getByLabel('Stage of Acme rollout').selectOption('proposal');
  await expect(page.locator('[data-stage="proposal"]')).toContainText('Acme rollout');
  await page.getByRole('tab', { name: 'Overview' }).click();
  await expect(page.locator('[data-stage="proposal"]')).toHaveCount(0); // pipeline gone, overview shown
  await expect(page.getByText('£12,500.00', { exact: true })).toBeVisible(); // open value
  await expect(page.getByText('£6,250.00', { exact: true })).toBeVisible(); // 50% weighted at Proposal

  // Mia gets the follow-up in her inbox and completes it.
  await mia.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /^Inbox/ }).click();
  await mia.getByText(/gave you a follow-up: “Send pricing”/).click();
  await expect(mia.getByRole('tab', { name: /My follow-ups/ })).toHaveAttribute('aria-selected', 'true');
  await mia.getByLabel('Mark “Send pricing” done').check();
  await expect(mia.getByText('No open follow-ups')).toBeVisible();

  // A quote with two lines; totals are computed for the user and by the server.
  await page.getByRole('tab', { name: 'Quotes' }).click();
  await page.getByRole('link', { name: 'New quote' }).click();
  await page.getByLabel('Title').fill('Rollout phase 1');
  await page.getByLabel('Company').selectOption({ label: 'Acme Ltd' });
  await page.getByLabel('Line 1 description').fill('Design');
  await page.getByLabel('Line 1 quantity').fill('1.5');
  await page.getByLabel('Line 1 unit price').fill('83.33');
  await page.getByRole('button', { name: '+ Add line' }).click();
  await page.getByLabel('Line 2 description').fill('Hosting (12 months)');
  await page.getByLabel('Line 2 quantity').fill('12');
  await page.getByLabel('Line 2 unit price').fill('9.99');
  await page.getByLabel('Line 2 tax rate').fill('0');
  await expect(page.getByTestId('quote-total')).toHaveText('£269.88');
  await page.getByRole('button', { name: 'Create quote' }).click();
  await expect(page.getByRole('heading', { name: 'Q-0001 · Rollout phase 1' })).toBeVisible();

  const [print] = await Promise.all([page.waitForEvent('popup'), page.getByRole('link', { name: 'Print / PDF' }).click()]);
  await expect(print.getByRole('heading', { name: 'Quote Q-0001' })).toBeVisible();
  await expect(print.getByText('Acme Ltd')).toBeVisible();
  await expect(print.getByText('£269.88')).toBeVisible();
});
