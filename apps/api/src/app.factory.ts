import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/http-exception.filter';
import { JsonLogger, requestLogging } from './common/logging';
import { AppConfig, loadConfig, setConfig } from './config';
import type { NextFunction, Request, Response } from 'express';

/**
 * Answers 503 if a handler has not responded within `ms` (live-update streams are exempt).
 * Database work is separately bounded by statement / lock / idle-transaction timeouts; this is the outer limit
 * so a client never waits indefinitely. A handler that finishes later cannot write a second response.
 */
export function requestTimeout(ms: number, logger: { warn(message: string): void }) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (/\/events$/.test(req.path)) return next();
    const timer = setTimeout(() => {
      if (res.headersSent) return;
      logger.warn(JSON.stringify({ msg: 'request_timeout', path: req.path, method: req.method, ms }));
      res.setHeader('Retry-After', '5');
      res.status(503).json({
        error: { code: 'REQUEST_TIMEOUT', message: 'This took too long. Refresh to check whether your change was saved before trying again.' },
      });
      // Silence the late handler: its eventual response has nowhere to go.
      const noop = () => res;
      Object.assign(res, { json: noop, send: noop, status: noop, setHeader: noop, end: noop });
    }, ms);
    timer.unref();
    const clear = () => clearTimeout(timer);
    res.on('finish', clear);
    res.on('close', clear);
    next();
  };
}

export async function createApp(overrides: Partial<AppConfig> = {}): Promise<INestApplication> {
  const config = { ...loadConfig(), ...overrides };
  setConfig(config);
  const logger = new JsonLogger(config.logLevel);

  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(config), {
    logger,
    bodyParser: false,
  });
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');
  app.use(requestLogging(logger));
  app.use(requestTimeout(config.timeouts.requestMs, logger));
  app.use(helmet());
  // Server-Sent Events must not be compressed or buffered by proxies; nothing in the stack compresses today.
  app.useBodyParser('json', { limit: '1mb' });
  app.use(cookieParser());
  app.setGlobalPrefix('api/v1');
  app.useGlobalFilters(new AllExceptionsFilter());
  app.enableCors({
    origin: config.allowedOrigins,
    credentials: true,
    allowedHeaders: ['Content-Type', 'X-Monty-Client', 'Authorization', 'X-Request-Id'],
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  });
  app.enableShutdownHooks();
  return app;
}
