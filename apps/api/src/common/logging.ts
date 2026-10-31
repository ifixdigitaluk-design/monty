import { LoggerService } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { AuthedRequest } from './auth-context';
import { metrics } from '../observability/metrics';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

/** Structured JSON logs to stdout. Never pass secrets, tokens, passwords or document content. */
export class JsonLogger implements LoggerService {
  constructor(private readonly minLevel: Level = 'info') {}

  private write(level: Level, message: unknown, context?: string) {
    if (LEVELS[level] < LEVELS[this.minLevel]) return;
    let payload: Record<string, unknown>;
    if (typeof message === 'string' && message.startsWith('{')) {
      try {
        payload = JSON.parse(message) as Record<string, unknown>;
      } catch {
        payload = { msg: message };
      }
    } else {
      payload = { msg: message };
    }
    const line = JSON.stringify({ time: new Date().toISOString(), level, context, ...payload });
    (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
  }

  log(message: unknown, context?: string) {
    this.write('info', message, context);
  }
  error(message: unknown, _trace?: string, context?: string) {
    this.write('error', message, context);
  }
  warn(message: unknown, context?: string) {
    this.write('warn', message, context);
  }
  debug(message: unknown, context?: string) {
    this.write('debug', message, context);
  }
  verbose(message: unknown, context?: string) {
    this.write('debug', message, context);
  }
}

const REQUEST_ID = /^[A-Za-z0-9-]{8,64}$/;

export function requestLogging(logger: JsonLogger) {
  return (req: Request, res: Response, next: NextFunction) => {
    const incoming = req.header('x-request-id');
    const requestId = incoming && REQUEST_ID.test(incoming) ? incoming : randomUUID();
    req.headers['x-request-id'] = requestId;
    res.setHeader('X-Request-Id', requestId);
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      const statusClass = `${Math.floor(res.statusCode / 100)}xx`;
      metrics.inc('monty_http_requests_total', { method: req.method, status: statusClass });
      if (!/\/events$/.test(req.path)) metrics.observe('monty_http_request_duration_seconds', { method: req.method }, ms / 1000);
      logger.log(
        JSON.stringify({
          msg: 'request',
          requestId,
          method: req.method,
          path: req.path,
          status: res.statusCode,
          durationMs: Math.round(ms * 10) / 10,
          userId: (req as AuthedRequest).auth?.userId,
        }),
        'HTTP',
      );
    });
    next();
  };
}
