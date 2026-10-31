import { Logger } from '@nestjs/common';
import { metrics } from './metrics';

export interface ErrorReport {
  error: unknown;
  requestId?: string;
  path?: string;
  method?: string;
  userId?: string;
  source: 'http' | 'job' | 'process';
}

/**
 * Integration point for an external error tracker. Every unhandled server error goes through `report`.
 * - Always: structured log line `unhandled_error` and the `monty_errors_total` counter.
 * - If ERROR_WEBHOOK_URL is set: a JSON POST (generic "incoming webhook" shape) with the error name, message, stack
 *   and request id — never request bodies, headers, cookies or query strings. At most 30 per minute; failures to
 *   deliver are logged and never affect the request.
 * Swap in a vendor SDK (Sentry, Rollbar, Datadog…) by implementing `deliver`; no vendor is assumed here.
 */
export class ErrorReporter {
  private readonly logger = new Logger('Errors');
  private windowStart = Date.now();
  private sentInWindow = 0;

  constructor(
    private readonly webhookUrl: string | undefined,
    private readonly service: { environment: string; release: string },
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  report(r: ErrorReport): void {
    metrics.inc('monty_errors_total', { source: r.source });
    const e = r.error instanceof Error ? r.error : new Error(String(r.error));
    this.logger.error(
      JSON.stringify({ msg: 'unhandled_error', source: r.source, requestId: r.requestId, path: r.path, error: { name: e.name, message: e.message, stack: e.stack } }),
    );
    if (!this.webhookUrl) return;
    if (Date.now() - this.windowStart > 60_000) {
      this.windowStart = Date.now();
      this.sentInWindow = 0;
    }
    if (++this.sentInWindow > 30) return;
    void this.deliver({
      service: 'monty-api',
      environment: this.service.environment,
      release: this.service.release,
      time: new Date().toISOString(),
      source: r.source,
      requestId: r.requestId ?? null,
      method: r.method ?? null,
      path: r.path ?? null,
      userId: r.userId ?? null,
      error: { name: e.name, message: e.message.slice(0, 1000), stack: (e.stack ?? '').slice(0, 8000) },
    });
  }

  private async deliver(body: unknown) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3_000);
    try {
      const res = await this.fetchImpl(this.webhookUrl!, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
        redirect: 'error',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      this.logger.warn(JSON.stringify({ msg: 'error_report_delivery_failed', error: String(err).slice(0, 200) }));
    } finally {
      clearTimeout(timer);
    }
  }
}

let current: ErrorReporter | null = null;
export const setErrorReporter = (r: ErrorReporter) => (current = r);
export const errorReporter = () => current;
