import path from 'node:path';
import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import * as schema from './schema';

export * from './schema';
export { schema };

export type Database = NodePgDatabase<typeof schema>;
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
export type DbOrTx = Database | Transaction;

export interface DbHandle {
  db: Database;
  pool: Pool;
  close(): Promise<void>;
}

export interface DbOptions {
  max?: number;
  /** Server-side cap per statement (Postgres statement_timeout). Omit for no limit (migrations). */
  statementTimeoutMs?: number;
  /** Postgres idle_in_transaction_session_timeout: kills sessions that hold a transaction open but do nothing. */
  idleInTransactionTimeoutMs?: number;
  /** Postgres lock_timeout: how long a statement may wait for a row/table lock. */
  lockTimeoutMs?: number;
  /** Max wait to get a connection from the pool (or open a new one). */
  connectTimeoutMs?: number;
  /** Called for errors on idle pooled connections (e.g. the server restarted). Without a handler they crash the process. */
  onPoolError?: (err: Error) => void;
}

export function createDb(connectionString: string, opts: DbOptions = {}): DbHandle {
  const pool = new Pool({
    connectionString,
    max: opts.max ?? 10,
    idleTimeoutMillis: 30_000,
    ...(opts.connectTimeoutMs ? { connectionTimeoutMillis: opts.connectTimeoutMs } : {}),
    ...(opts.statementTimeoutMs
      ? {
          statement_timeout: opts.statementTimeoutMs,
          // Client-side backstop if the server can't answer at all (network partition): a little above the server limit.
          query_timeout: opts.statementTimeoutMs + 5_000,
        }
      : {}),
    ...(opts.idleInTransactionTimeoutMs ? { idle_in_transaction_session_timeout: opts.idleInTransactionTimeoutMs } : {}),
    ...(opts.lockTimeoutMs ? { lock_timeout: opts.lockTimeoutMs } : {}),
    keepAlive: true,
  });
  // Every connection gets one permanent error listener. pg-pool only listens while a client is idle, so a client that
  // is checked out (mid-transaction) when the server terminates it — idle_in_transaction_session_timeout, restart,
  // failover — would otherwise emit 'error' with no listener: an uncaught exception that kills the process.
  // The in-flight query still rejects (the request gets a 503) and the pool discards the broken client.
  pool.on('connect', (client) => client.on('error', (err) => opts.onPoolError?.(err)));
  // Idle-client errors are re-emitted on the pool; they were already reported by the listener above, so this one
  // only exists to keep the emit from throwing.
  pool.on('error', () => undefined);
  const db = drizzle(pool, { schema });
  return { db, pool, close: () => pool.end() };
}

export const MIGRATIONS_FOLDER = path.resolve(__dirname, '..', 'drizzle');

/** Applies committed migrations (forward-only). Safe to run repeatedly. */
export async function runMigrations(connectionString: string): Promise<void> {
  const handle = createDb(connectionString, { max: 1 });
  try {
    await migrate(handle.db, { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await handle.close();
  }
}

/** Postgres unique-violation detection, tolerant of driver error wrapping. */
export function isUniqueViolation(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && depth < 4; e = (e as { cause?: unknown }).cause, depth++) {
    if ((e as { code?: unknown }).code === '23505') return true;
  }
  return false;
}
