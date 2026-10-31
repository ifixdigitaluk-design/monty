import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  API_PORT: z.coerce.number().int().positive().default(4000),
  ALLOWED_ORIGINS: z.string().default('http://localhost:3000'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  RATE_LIMIT: z.coerce.number().int().positive().default(300),
  AUTH_RATE_LIMIT: z.coerce.number().int().positive().default(10),
  TRUST_PROXY: z.string().default('loopback'),
});

export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  isProduction: boolean;
  databaseUrl: string;
  port: number;
  allowedOrigins: string[];
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  rateLimit: number;
  authRateLimit: number;
  trustProxy: string;
  cookieName: string;
  sessionTtlDays: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid environment: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  const e = parsed.data;
  const isProduction = e.NODE_ENV === 'production';
  return {
    nodeEnv: e.NODE_ENV,
    isProduction,
    databaseUrl: e.DATABASE_URL,
    port: e.API_PORT,
    allowedOrigins: e.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
    logLevel: e.LOG_LEVEL,
    rateLimit: e.RATE_LIMIT,
    authRateLimit: e.AUTH_RATE_LIMIT,
    trustProxy: e.TRUST_PROXY,
    // __Host- prefix forces Secure, path=/ and no Domain attribute in browsers.
    cookieName: isProduction ? '__Host-monty_session' : 'monty_session',
    sessionTtlDays: 30,
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
