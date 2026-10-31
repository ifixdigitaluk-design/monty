import { AsyncLocalStorage } from 'node:async_hooks';
import { Global, Inject, Injectable, Logger, Module, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { createDb, Database, DbHandle, Transaction } from '@monty/database';
import { AppConfig, CONFIG } from '../config';

interface RequestDbContext {
  tx: Transaction;
  userId: string | null;
}

/**
 * Database access with row-level security context.
 *
 * Authenticated requests run inside one transaction with `app.user_id` set (see RequestContextInterceptor),
 * so Postgres filters every row by the caller's memberships even if an API permission check were missing.
 * Services keep using `dbs.db`; it transparently returns the request's transaction when there is one.
 */
@Injectable()
export class DbService implements OnModuleInit, OnModuleDestroy {
  private readonly handle: DbHandle;
  private readonly als = new AsyncLocalStorage<RequestDbContext>();
  private readonly logger = new Logger('Db');

  constructor(@Inject(CONFIG) private readonly config: AppConfig) {
    this.handle = createDb(config.databaseUrl);
  }

  get db(): Database {
    const ctx = this.als.getStore();
    // A drizzle transaction exposes the same query API as the database object.
    return (ctx?.tx as unknown as Database | undefined) ?? this.handle.db;
  }

  /** Runs `fn` in a transaction scoped to `userId` (RLS context). */
  runAsUser<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    return this.handle.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`);
      return this.als.run({ tx, userId }, fn);
    });
  }

  /** Sets the RLS user inside the current transaction (used during sign-up, once the user row exists). */
  async setCurrentUser(tx: Transaction | Database, userId: string): Promise<void> {
    await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`);
  }

  /**
   * Runs `fn` with row filtering lifted. Only for operations that must work before the caller is a member,
   * e.g. previewing and accepting an invitation by its secret token. Keep every use small and reviewed.
   */
  async runAsSystem<T>(fn: () => Promise<T>): Promise<T> {
    const ctx = this.als.getStore();
    if (ctx) {
      await ctx.tx.execute(sql`select set_config('app.system', 'on', true)`);
      try {
        return await fn();
      } finally {
        await ctx.tx.execute(sql`select set_config('app.system', '', true)`);
      }
    }
    return this.handle.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.system', 'on', true)`);
      return this.als.run({ tx, userId: null }, fn);
    });
  }

  /**
   * RLS only protects anything if the API's database role neither owns the tables nor bypasses RLS.
   * Production refuses to start otherwise; other environments log a warning.
   */
  async onModuleInit() {
    const result = await this.handle.db.execute(sql`
      select r.rolsuper as superuser, r.rolbypassrls as bypass,
             (select pg_get_userbyid(c.relowner) = current_user from pg_class c where c.relname = 'projects' and c.relkind = 'r') as owner,
             (select c.relrowsecurity from pg_class c where c.relname = 'projects' and c.relkind = 'r') as rls_enabled
      from pg_roles r where r.rolname = current_user`);
    const row = result.rows[0] as { superuser: boolean; bypass: boolean; owner: boolean; rls_enabled: boolean } | undefined;
    const problems: string[] = [];
    if (!row) problems.push('could not inspect the database role');
    else {
      if (row.superuser) problems.push('the API connects as a superuser');
      if (row.bypass) problems.push('the API role has BYPASSRLS');
      if (row.owner) problems.push('the API role owns the tables (use the monty_app role; migrations use the owner)');
      if (!row.rls_enabled) problems.push('row-level security is not enabled (run migrations)');
    }
    if (problems.length === 0) {
      this.logger.log(JSON.stringify({ msg: 'rls_active' }));
      return;
    }
    const message = `Row-level security is NOT effective: ${problems.join('; ')}`;
    if (this.config.requireRls) {
      await this.handle.close();
      throw new Error(message);
    }
    this.logger.warn(JSON.stringify({ msg: 'rls_inactive', problems }));
  }

  async onModuleDestroy() {
    await this.handle.close();
  }
}

@Global()
@Module({ providers: [DbService], exports: [DbService] })
export class DbModule {}
