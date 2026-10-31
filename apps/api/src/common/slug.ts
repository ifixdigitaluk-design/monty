import { randomBytes } from 'node:crypto';

export function slugify(input: string): string {
  const s = input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return s || 'workspace';
}

export function randomSuffix(bytes = 3): string {
  return randomBytes(bytes).toString('hex');
}
