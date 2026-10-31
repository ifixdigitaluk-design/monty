import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { transientDbFailure } from './db-errors';
import { errorReporter } from '../observability/error-reporter';
import { metrics } from '../observability/metrics';
import type { AuthedRequest } from './auth-context';

const STATUS_CODES: Record<number, string> = {
  400: 'VALIDATION_FAILED',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  413: 'VALIDATION_FAILED',
  429: 'RATE_LIMITED',
};

/** Converts every error into the documented `{ error: { code, message } }` shape. Never leaks internals. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exceptions');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'object') {
        res.status(status).json(body);
        return;
      }
      const message =
        status === 429
          ? 'Too many requests. Please wait and try again.'
          : typeof body === 'string'
            ? body
            : ((body as { message?: unknown }).message?.toString() ?? exception.message);
      res.status(status).json({ error: { code: STATUS_CODES[status] ?? 'ERROR', message } });
      return;
    }

    // Body-parser errors (malformed JSON, payload too large) carry a status.
    const maybeStatus = (exception as { status?: unknown })?.status;
    if (typeof maybeStatus === 'number' && maybeStatus >= 400 && maybeStatus < 500) {
      res.status(maybeStatus).json({ error: { code: STATUS_CODES[maybeStatus] ?? 'ERROR', message: 'Malformed request' } });
      return;
    }

    const transient = transientDbFailure(exception);
    if (transient) {
      this.logger.warn(JSON.stringify({ msg: 'db_unavailable', reason: transient, requestId: req.headers['x-request-id'], path: req.path }));
      metrics.inc('monty_db_unavailable_total', { reason: transient });
      if (!res.headersSent) {
        res.setHeader('Retry-After', '2');
        res
          .status(503)
          .json({ error: { code: 'SERVICE_UNAVAILABLE', message: 'The service is busy right now. Nothing was saved — please try again in a moment.' } });
      }
      return;
    }

    const reporter = errorReporter();
    const report = { error: exception, requestId: req.headers['x-request-id'] as string | undefined, path: req.path, method: req.method, userId: (req as AuthedRequest).auth?.userId, source: 'http' as const };
    if (reporter) reporter.report(report);
    else
      this.logger.error(
        JSON.stringify({
          msg: 'unhandled_error',
          requestId: report.requestId,
          path: req.path,
          error: exception instanceof Error ? { name: exception.name, message: exception.message, stack: exception.stack } : String(exception),
        }),
      );

    if (!res.headersSent) res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong. Please try again.' } });
  }
}
