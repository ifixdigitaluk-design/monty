import { ApiError, createApiClient } from '@monty/api-client';

export const api = createApiClient({ client: 'web' });
export { ApiError };

/** The user's local calendar date (YYYY-MM-DD) — used for due-date logic so "today" matches what they see. */
export function localToday(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    const details = Array.isArray(err.details) ? (err.details as { path: string; message: string }[]) : null;
    if (details?.length) return `${err.message}: ${details.map((d) => `${d.path || 'value'} — ${d.message}`).join('; ')}`;
    return err.message;
  }
  return 'Something went wrong. Please try again.';
}

export function formatDate(iso: string | null): string {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y!, m! - 1, d!).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}
