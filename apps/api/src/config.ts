import { createHash } from 'node:crypto';
import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  API_PORT: z.coerce.number().int().positive().default(4000),
  ALLOWED_ORIGINS: z.string().default('http://localhost:3000'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  /** Postgres connections per API instance. Each authenticated request holds one for its duration (RLS transaction). */
  DB_POOL_MAX: z.coerce.number().int().min(2).max(200).default(10),
  RATE_LIMIT: z.coerce.number().int().positive().default(300),
  AUTH_RATE_LIMIT: z.coerce.number().int().positive().default(10),
  TRUST_PROXY: z.string().default('loopback'),
  /** Public origin of the web app, used in links inside emails. */
  APP_URL: z.url().default('http://localhost:3000'),
  /** 'log' keeps emails in memory and logs them (development/test). 'smtp' sends through any SMTP provider. */
  MAIL_TRANSPORT: z.enum(['log', 'smtp']).default('log'),
  MAIL_FROM: z.string().default('Monty <no-reply@localhost>'),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_SECURE: z.enum(['true', 'false']).default('false'),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  /** Only for local test SMTP servers with self-signed certificates. Refused in production. */
  SMTP_TLS_REJECT_UNAUTHORIZED: z.enum(['true', 'false']).default('true'),
  /** Email retry policy: first retry after MAIL_RETRY_BASE_MS, doubling, capped at 1 hour, at most MAIL_MAX_ATTEMPTS sends. */
  MAIL_RETRY_BASE_MS: z.coerce.number().int().min(10).default(30_000),
  MAIL_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(50).default(10),
  MAIL_POLL_MS: z.coerce.number().int().min(50).default(2_000),
  /** 32 random bytes, base64. Encrypts queued emails and data exports at rest. Required in production. */
  DATA_ENCRYPTION_KEY: z.string().optional(),
  /** Refuse to start unless Postgres row-level security is effective for the API's role. Defaults to on in production. */
  REQUIRE_RLS: z.enum(['true', 'false']).optional(),
  /** 'local' = built-in deterministic planner (no data leaves the server); 'anthropic' needs AI_API_KEY and AI_MODEL. */
  AI_PROVIDER: z.enum(['local', 'anthropic']).default('local'),
  AI_API_KEY: z.string().optional(),
  AI_MODEL: z.string().optional(),
});

export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  isProduction: boolean;
  databaseUrl: string;
  dbPoolMax: number;
  port: number;
  allowedOrigins: string[];
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  rateLimit: number;
  authRateLimit: number;
  trustProxy: string;
  cookieName: string;
  sessionTtlDays: number;
  appUrl: string;
  requireRls: boolean;
  ai: { provider: 'local' | 'anthropic'; apiKey?: string; model?: string };
  mail: {
    transport: 'log' | 'smtp';
    from: string;
    smtp?: { host: string; port: number; secure: boolean; user?: string; pass?: string; rejectUnauthorized: boolean };
    retryBaseMs: number;
    maxAttempts: number;
    pollMs: number;
  };
  /** 32-byte key for encryption at rest. */
  dataKey: Buffer;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid environment: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  const e = parsed.data;
  const isProduction = e.NODE_ENV === 'production';
  if (e.MAIL_TRANSPORT === 'smtp' && !e.SMTP_HOST) throw new Error('Invalid environment: SMTP_HOST is required when MAIL_TRANSPORT=smtp');
  if (isProduction && e.MAIL_TRANSPORT !== 'smtp') {
    throw new Error('Invalid environment: production requires MAIL_TRANSPORT=smtp (password reset and verification depend on email)');
  }
  if (e.AI_PROVIDER === 'anthropic' && (!e.AI_API_KEY || !e.AI_MODEL)) throw new Error('Invalid environment: AI_PROVIDER=anthropic requires AI_API_KEY and AI_MODEL');
  if (isProduction && e.SMTP_TLS_REJECT_UNAUTHORIZED === 'false') throw new Error('Invalid environment: SMTP_TLS_REJECT_UNAUTHORIZED=false is not allowed in production');
  let dataKey: Buffer;
  if (e.DATA_ENCRYPTION_KEY) {
    dataKey = Buffer.from(e.DATA_ENCRYPTION_KEY, 'base64');
    if (dataKey.length !== 32) throw new Error('Invalid environment: DATA_ENCRYPTION_KEY must be 32 bytes, base64-encoded (openssl rand -base64 32)');
  } else if (isProduction) {
    throw new Error('Invalid environment: production requires DATA_ENCRYPTION_KEY (openssl rand -base64 32)');
  } else {
    // Development/test only: a fixed, publicly known key. Never protects real data.
    dataKey = createHash('sha256').update('monty-development-only-key').digest();
  }
  if (isProduction && !e.APP_URL.startsWith('https://')) throw new Error('Invalid environment: APP_URL must be https in production');
  return {
    nodeEnv: e.NODE_ENV,
    isProduction,
    databaseUrl: e.DATABASE_URL,
    dbPoolMax: e.DB_POOL_MAX,
    port: e.API_PORT,
    allowedOrigins: e.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
    logLevel: e.LOG_LEVEL,
    rateLimit: e.RATE_LIMIT,
    authRateLimit: e.AUTH_RATE_LIMIT,
    trustProxy: e.TRUST_PROXY,
    // __Host- prefix forces Secure, path=/ and no Domain attribute in browsers.
    cookieName: isProduction ? '__Host-monty_session' : 'monty_session',
    sessionTtlDays: 30,
    appUrl: e.APP_URL.replace(/\/$/, ''),
    requireRls: e.REQUIRE_RLS ? e.REQUIRE_RLS === 'true' : isProduction,
    ai: { provider: e.AI_PROVIDER, apiKey: e.AI_API_KEY, model: e.AI_MODEL },
    mail: {
      transport: e.MAIL_TRANSPORT,
      from: e.MAIL_FROM,
      smtp: e.SMTP_HOST
        ? {
            host: e.SMTP_HOST,
            port: e.SMTP_PORT,
            secure: e.SMTP_SECURE === 'true',
            user: e.SMTP_USER,
            pass: e.SMTP_PASS,
            rejectUnauthorized: e.SMTP_TLS_REJECT_UNAUTHORIZED === 'true',
          }
        : undefined,
      retryBaseMs: e.MAIL_RETRY_BASE_MS,
      maxAttempts: e.MAIL_MAX_ATTEMPTS,
      pollMs: e.MAIL_POLL_MS,
    },
    dataKey,
  };
}

let current: AppConfig | null = null;

export function setConfig(config: AppConfig): void {
  current = config;
}

export function getConfig(): AppConfig {
  if (!current) current = loadConfig();
  return current;
}

export const CONFIG = Symbol('CONFIG');
