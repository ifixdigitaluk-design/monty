/**
 * Recognises database failures that mean "the system is temporarily overloaded or unavailable" rather than a bug,
 * so the API can answer 503 with Retry-After instead of a generic 500.
 */
export type TransientDbFailure = 'statement_timeout' | 'lock_timeout' | 'idle_transaction_timeout' | 'pool_timeout' | 'connection_lost' | 'conflict_retry';

const CODES: Record<string, TransientDbFailure> = {
  '57014': 'statement_timeout', // query_canceled (statement_timeout)
  '55P03': 'lock_timeout', // lock_not_available
  '25P03': 'idle_transaction_timeout', // idle_in_transaction_session_timeout
  '40001': 'conflict_retry', // serialization_failure
  '40P01': 'conflict_retry', // deadlock_detected
  '57P01': 'connection_lost', // admin_shutdown
  '57P02': 'connection_lost', // crash_shutdown
  '57P03': 'connection_lost', // cannot_connect_now
  '08000': 'connection_lost',
  '08003': 'connection_lost',
  '08006': 'connection_lost',
};

export function transientDbFailure(err: unknown): TransientDbFailure | null {
  for (let e: unknown = err, depth = 0; e && depth < 5; e = (e as { cause?: unknown }).cause, depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' && CODES[code]) return CODES[code]!;
    const message = String((e as { message?: unknown }).message ?? '');
    if (/timeout exceeded when trying to connect/i.test(message)) return 'pool_timeout';
    if (/Query read timeout/i.test(message)) return 'statement_timeout';
    if (/Connection terminated|ECONNREFUSED|ECONNRESET|server closed the connection|not queryable|terminating connection/i.test(message)) return 'connection_lost';
  }
  return null;
}
