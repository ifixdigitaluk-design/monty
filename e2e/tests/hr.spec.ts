import { expect, test } from '@playwright/test';
import { teamWithProject } from '../helpers';

const nextWeekday = (from: Date, offsetDays: number) => {
  const d = new Date(from.getTime() + offsetDays * 86400_000);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

test('HR: profile and private details, leave request and approval, onboarding steps, documents and a shared review', async ({ page, browser }) => {
  const { mia } = await teamWithProject(page, browser);
  const hrNav = (p: typeof page) => p.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'HR' });

  // Olivia (owner = HR admin) fills in Mia's profile.
  await hrNav(page).click();
  await expect(page.getByText('You’re an HR admin')).toBeVisible();
  await page.getByRole('button', { name: 'Mia', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Person: Mia' });
  await panel.getByLabel('Job title').fill('Designer');
  await panel.getByLabel('Job title').press('Enter');
  await panel.getByLabel('Manager', { exact: true }).selectOption({ label: 'Olivia' });
  await panel.getByLabel('Home address').fill('1 Secret Street');
  await panel.getByLabel('Home address').blur();
  await panel.getByLabel('Salary', { exact: true }).fill('42,000');
  await panel.getByLabel('Salary', { exact: true }).blur();
  await expect(panel.getByLabel('Salary', { exact: true })).toHaveValue('42000.00');

  // Private HR document.
  await panel.locator('input[type=file]').setInputFiles({ name: 'Mia contract.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7\ncontract') });
  await expect(panel.getByRole('link', { name: /Mia contract\.pdf/ })).toBeVisible();
  await panel.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByRole('row', { name: /Mia Designer/ })).toBeVisible();

  // Mia sees her own details (including pay) but can't change her job title.
  await hrNav(mia).click();
  await mia.getByRole('button', { name: 'My HR profile' }).click();
  const mine = mia.getByRole('dialog', { name: 'Person: Mia' });
  await expect(mine.getByLabel('Home address')).toHaveValue('1 Secret Street');
  await expect(mine.getByText('£42,000.00')).toBeVisible();
  await expect(mine.getByLabel('Job title')).toBeDisabled();
  await expect(mine.getByRole('link', { name: /Mia contract\.pdf/ })).toBeVisible();
  await mine.getByRole('button', { name: 'Close' }).click();
  // …and nobody else's private details.
  await mia.getByRole('button', { name: 'Olivia', exact: true }).click();
  await expect(mia.getByRole('dialog', { name: 'Person: Olivia' }).getByText(/Personal details are private/)).toBeVisible();
  await mia.getByRole('dialog', { name: 'Person: Olivia' }).getByRole('button', { name: 'Close' }).click();

  // Leave: Mia asks, Olivia (her manager) approves.
  await mia.getByRole('tab', { name: 'Leave' }).click();
  await mia.getByRole('button', { name: 'Request leave' }).click();
  const start = nextWeekday(new Date(), 14);
  await mia.getByLabel('First day').fill(start);
  await expect(mia.getByText('1 working day (weekends aren’t counted)')).toBeVisible();
  await mia.getByLabel('Note (optional)').fill('Dentist');
  await mia.getByRole('button', { name: 'Send request' }).click();
  await expect(mia.getByText('pending', { exact: true }).first()).toBeVisible();

  await page.getByRole('tab', { name: 'Leave' }).click();
  await expect(page.getByText('“Dentist”')).toBeVisible();
  await page.getByRole('button', { name: "Approve Mia's leave" }).click();
  await expect(page.getByText('Nothing to approve.')).toBeVisible();
  await mia.reload();
  await expect(mia.getByRole('region', { name: 'My leave' }).getByText('approved')).toBeVisible();

  // Onboarding: IT steps go to Mia; she ticks hers.
  await page.getByRole('tab', { name: 'Onboarding & leaving' }).click();
  await page.getByRole('button', { name: 'Start onboarding or leaving checklist' }).click();
  const nc = page.getByRole('dialog', { name: 'New checklist' });
  await nc.getByLabel('New joiner’s name').fill('Nina New');
  await nc.getByLabel('IT steps').selectOption({ label: 'Mia' });
  await nc.getByRole('button', { name: 'Create checklist' }).click();
  await expect(page.getByRole('region', { name: 'Onboarding: Nina New' })).toContainText('0 of 7 done');
  await mia.getByRole('tab', { name: 'Onboarding & leaving' }).click();
  const list = mia.getByRole('region', { name: 'Onboarding: Nina New' });
  await expect(list.getByLabel('Send contract and collect signed copy')).toBeDisabled(); // HR's step
  await list.getByLabel('Order laptop and accounts (email, Monty)').check();
  await expect(list).toContainText('1 of 7 done');

  // Review: Olivia writes and shares; Mia reads it without the private notes.
  await page.getByRole('tab', { name: 'Reviews' }).click();
  await page.getByRole('button', { name: 'Write a review' }).click();
  const rv = page.getByRole('dialog', { name: 'Write a review' });
  await rv.getByLabel('Overall rating').selectOption('4');
  await rv.getByLabel('What went well').fill('Great design work');
  await rv.getByLabel('Private notes').fill('Consider for promotion');
  page.once('dialog', (d) => void d.accept());
  await rv.getByRole('button', { name: 'Share with them' }).click();
  await expect(page.getByText(/shared/)).toBeVisible();
  await mia.getByRole('tab', { name: 'Reviews' }).click();
  await mia.getByRole('button', { name: /^Mia · / }).click();
  const read = mia.getByRole('dialog', { name: 'Review: Mia' });
  await expect(read.getByLabel('What went well')).toHaveValue('Great design work');
  await expect(read.getByText('Consider for promotion')).toHaveCount(0);
  await expect(read.getByLabel('Private notes')).toHaveCount(0);
});
