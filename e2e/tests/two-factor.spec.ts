import { createHmac } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { register } from '../helpers';

/** RFC 6238 TOTP, computed independently of the app's implementation. */
function totp(secretB32: string, offsetSteps = 0): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of secretB32.replace(/\s/g, '')) bits += alphabet.indexOf(c).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000) + offsetSteps));
  const mac = createHmac('sha1', key).update(counter).digest();
  const o = mac[19]! & 15;
  return String((mac.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

test('turn on two-factor, sign in with a code, then with a recovery code', async ({ page }) => {
  const email = `tfa-${Date.now()}@example.com`;
  await register(page, 'Tara', email);
  await page.getByRole('link', { name: 'Sessions & security' }).click();
  await page.getByLabel('Your password').fill('correct-horse-battery');
  await page.getByRole('button', { name: 'Set up two-factor' }).click();
  await expect(page.getByAltText('QR code for your authenticator app')).toBeVisible();
  const secret = (await page.getByLabel('Setup key').textContent())!.replace(/\s/g, '');
  await page.getByLabel('2. Enter the 6-digit code it shows').fill(totp(secret));
  await page.getByRole('button', { name: 'Turn on' }).click();
  const codes = (await page.getByRole('list', { name: 'Recovery codes' }).locator('li').allTextContents()).map((c) => c.trim());
  expect(codes).toHaveLength(10);
  await page.getByRole('button', { name: 'I’ve saved them' }).click();
  await expect(page.getByRole('heading', { name: /Two-factor authentication/ })).toContainText('On');

  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password').fill('correct-horse-battery');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Two-step verification' })).toBeVisible();
  await page.getByLabel('Authentication code').fill(totp(secret, 1));
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();

  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password').fill('correct-horse-battery');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('button', { name: 'Lost your device? Use a recovery code' }).click();
  await page.getByLabel('Recovery code').fill(codes[0]!);
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
});
