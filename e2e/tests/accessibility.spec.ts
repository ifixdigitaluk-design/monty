import { readFileSync } from 'node:fs';
import { expect, Page, test } from '@playwright/test';
import { register } from '../helpers';

const AXE = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

interface Violation {
  id: string;
  impact: string | null;
  help: string;
  nodes: { target: string[] }[];
}
/** Runs axe-core (all default WCAG 2.x A/AA rules, nothing disabled) and returns the violations. */
async function axe(page: Page): Promise<Violation[]> {
  await page.waitForLoadState('networkidle');
  await page.addScriptTag({ content: AXE });
  return page.evaluate(async () => {
    const w = window as unknown as { axe: { run(ctx: Document, opts: object): Promise<{ violations: Violation[] }> } };
    return (await w.axe.run(document, { resultTypes: ['violations'] })).violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.map((n) => ({ target: n.target })) }));
  });
}
const summary = (v: Violation[]) => v.map((x) => `${x.impact} ${x.id}: ${x.help} (${x.nodes.length}× e.g. ${x.nodes[0]?.target.join(' ')})`);

test('no axe violations on the 13 main pages (desktop and phone width)', async ({ page }) => {
  test.setTimeout(120_000);
  const results: Record<string, string[]> = {};
  await page.goto('/login');
  results.login = summary(await axe(page));
  await register(page, 'Axel', `axe-${Date.now()}@example.com`);
  results.home = summary(await axe(page));
  const main = page.getByRole('navigation', { name: 'Main' });
  await main.getByRole('link', { name: 'Personal', exact: true }).click();
  await page.getByRole('button', { name: 'Create a project' }).click();
  results['new-project-modal'] = summary(await axe(page));
  await page.getByLabel('Project name').fill('Audit');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.waitForURL(/project\?id=/);
  await page.getByLabel('New task title').fill('Check a11y');
  await page.getByRole('button', { name: 'Add task' }).click();
  await expect(page.locator('table').getByRole('button', { name: 'Check a11y', exact: true })).toBeVisible();
  results.project = summary(await axe(page));
  // Give the calendar real content (a task and a milestone today) so its cells and day list are scanned populated.
  const projectId = new URL(page.url()).searchParams.get('id')!;
  const today = await page.evaluate(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; });
  const headers = { 'X-Monty-Client': 'web' };
  expect((await page.request.post(`/api/v1/projects/${projectId}/tasks`, { headers, data: { title: 'Due today', dueDate: today } })).status()).toBe(201);
  expect((await page.request.post(`/api/v1/projects/${projectId}/milestones`, { headers, data: { name: 'Beta', dueDate: today } })).status()).toBe(201);
  const ws = (await main.getByRole('link', { name: 'Personal', exact: true }).getAttribute('href'))!;
  const pages: [string, string][] = [
    ['inbox', '/inbox'],
    ['tasks', '/tasks'],
    ['calendar', '/calendar'],
    ['workspace', ws],
    ['docs', ws.replace('/workspace?id=', '/docs?ws=')],
    ['automations', ws.replace('/workspace?id=', '/automations?ws=')],
    ['sessions', '/settings/sessions'],
    ['account', '/settings/account'],
  ];
  for (const [name, url] of pages) {
    await page.goto(url);
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    if (name === 'calendar') await expect(page.getByRole('list', { name: /^Items on / })).toContainText('Due today');
    results[name] = summary(await axe(page));
  }
  await page.setViewportSize({ width: 390, height: 844 });
  for (const [name, url] of [['phone-home', '/home'], ['phone-calendar', '/calendar']] as const) {
    await page.goto(url);
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    results[name] = summary(await axe(page));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${name} scrolls sideways`).toBe(true);
  }
  console.log(JSON.stringify(results, null, 1));
  expect(Object.entries(results).filter(([, v]) => v.length)).toEqual([]);
});

test('calendar is operable by keyboard and announces the selected day', async ({ page }) => {
  await register(page, 'Kay', `kay-${Date.now()}@example.com`);
  await page.goto('/calendar');
  const grid = page.getByRole('grid');
  await expect(grid).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Monday' })).toBeVisible();
  // Exactly one day is in the tab order: the selected one (today).
  await expect(grid.locator('button[tabindex="0"]')).toHaveCount(1);
  const start = (await grid.locator('button[tabindex="0"]').getAttribute('data-day'))!;
  await grid.locator('button[tabindex="0"]').focus();
  await page.keyboard.press('ArrowRight');
  const next = new Date(Date.parse(`${start}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  await expect(page.locator(`button[data-day="${next}"]`)).toBeFocused();
  await expect(page.locator(`td[data-date="${next}"]`)).toHaveAttribute('aria-selected', 'true');
  const monthBefore = await page.locator('#calendar-month').textContent();
  await page.keyboard.press('PageDown');
  await expect(page.locator('#calendar-month')).not.toHaveText(monthBefore!);
  await expect(page.locator('button[tabindex="0"]')).toBeFocused();
  await page.keyboard.press('PageUp');
  await expect(page.locator(`button[data-day="${next}"]`)).toBeFocused();
  await page.keyboard.press('Home');
  const focusedDay = await page.evaluate(() => document.activeElement?.getAttribute('data-day'));
  expect(new Date(`${focusedDay}T00:00:00Z`).getUTCDay()).toBe(1); // Monday
  await expect(page.locator('#day-heading')).toContainText(new Date(`${focusedDay}T00:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' }));
});
