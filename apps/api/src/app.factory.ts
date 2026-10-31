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
  app.use(helmet());
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
