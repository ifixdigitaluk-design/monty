import { createServer, IncomingMessage } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { MailService } from '../src/mail/mail.service';
import { ErrorReporter } from '../src/observability/error-reporter';
import { metrics, trackJob } from '../src/observability/metrics';
import { createTestApp, query, resetDb, send, signUp } from './helpers';

let app: INestApplication | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});
beforeEach(async () => {
  await resetDb();
});
const TOKEN = 'm'.repeat(32);

describe('metrics endpoint', () => {
  it('is disabled without METRICS_TOKEN and requires the bearer token when enabled', async () => {
    app = await createTestApp({ metricsToken: undefined });
    expect((await request(app.getHttpServer()).get('/api/v1/metrics')).status).toBe(404);
    await app.close();
    app = await createTestApp({ metricsToken: TOKEN });
    const server = app.getHttpServer();
    expect((await request(server).get('/api/v1/metrics')).status).toBe(401);
    expect((await request(server).get('/api/v1/metrics').set('Authorization', `Bearer ${'x'.repeat(32)}`)).status).toBe(401);
    const ok = await request(server).get('/api/v1/metrics').set('Authorization', `Bearer ${TOKEN}`);
    expect(ok.status).toBe(200);
    expect(ok.headers['content-type']).toMatch(/^text\/plain/);
    expect(ok.headers['content-type']).toContain('version=0.0.4');
  });

  it('reports HTTP, database pool, email queue, failed automations and job health without personal data', async () => {
    app = await createTestApp({ metricsToken: TOKEN });
    const u = await signUp(app, 'Metric');
    await app.get(MailService).drain();
    await query(`update email_outbox set status = 'FAILED', finished_at = now()`);
    const ws = u.workspaceId;
    const rule = (await send(u.agent, 'post', `/api/v1/workspaces/${ws}/automations`, { name: 'R', trigger: 'task.created', actions: [{ type: 'set_priority', priority: 'LOW' }] })).body.automation;
    await query(`insert into automation_runs (rule_id, organisation_id, workspace_id, event_key, status) values ($1, $2, $3, 'k', 'FAILED')`, [rule.id, u.personalOrgId, ws]);
    await query(`insert into automation_runs (rule_id, organisation_id, workspace_id, event_key, status, created_at) values ($1, $2, $3, 'k2', 'RUNNING', now() - interval '1 hour')`, [rule.id, u.personalOrgId, ws]);
    await trackJob('test_job', async () => undefined);
    await trackJob('test_job', async () => Promise.reject(new Error('boom'))).catch(() => undefined);

    const text = (await request(app.getHttpServer()).get('/api/v1/metrics').set('Authorization', `Bearer ${TOKEN}`)).text;
    expect(text).toMatch(/monty_http_requests_total\{method="POST",status="2xx"\} \d+/);
    expect(text).toMatch(/monty_http_request_duration_seconds_bucket\{method="GET",le="0.5"\} \d+/);
    expect(text).toContain('monty_db_up 1');
    expect(text).toMatch(/monty_db_pool_connections\{state="total"\} \d+/);
    expect(text).toContain('monty_db_pool_waiting_requests 0');
    expect(text).toContain('monty_email_queue_messages{status="FAILED"} 1');
    expect(text).toContain('monty_email_failed_last_24h 1');
    expect(text).toContain('monty_automation_runs_failed{window="1h"} 1');
    expect(text).toContain('monty_automation_runs_stuck 1');
    expect(text).toContain('monty_realtime_listener_up 1');
    expect(text).toMatch(/monty_job_runs_total\{job="test_job"\} 2/);
    expect(text).toMatch(/monty_job_failures_total\{job="test_job"\} 1/);
    expect(text).toMatch(/monty_job_last_success_timestamp_seconds\{job="mail_delivery"\} [1-9]\d+/);
    expect(text).not.toContain(u.email);
    expect(text).not.toContain(u.user.id);
  });
});

describe('error reporting', () => {
  it('posts unhandled errors to the configured webhook without request bodies, cookies or queries, and rate-limits', async () => {
    const received: { body: Record<string, unknown>; headers: IncomingMessage['headers'] }[] = [];
    const sink = createServer((req, res) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => {
        received.push({ body: JSON.parse(data), headers: req.headers });
        res.end('ok');
      });
    });
    await new Promise<void>((r) => sink.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(sink.address() as { port: number }).port}/intake`;
    const reporter = new ErrorReporter(url, { environment: 'test', release: 'abc123' });
    const err = new Error('database exploded');
    reporter.report({ error: err, requestId: 'req-1', path: '/api/v1/x', method: 'POST', userId: 'u1', source: 'http' });
    await new Promise((r) => setTimeout(r, 200));
    expect(received).toHaveLength(1);
    expect(received[0]!.body).toMatchObject({ service: 'monty-api', environment: 'test', release: 'abc123', requestId: 'req-1', path: '/api/v1/x', error: { name: 'Error', message: 'database exploded' } });
    expect(JSON.stringify(received[0]!.body)).not.toMatch(/cookie|password|token=/i);
    for (let i = 0; i < 40; i++) reporter.report({ error: new Error(`e${i}`), source: 'job' });
    await new Promise((r) => setTimeout(r, 300));
    expect(received.length).toBe(30); // 1 + 29 more within the minute
    await new Promise<void>((r) => sink.close(() => r()));
  });

  it('a failing error tracker never affects the request', async () => {
    const reporter = new ErrorReporter('http://127.0.0.1:1/unreachable', { environment: 'test', release: 'x' });
    expect(() => reporter.report({ error: new Error('x'), source: 'http' })).not.toThrow();
    await new Promise((r) => setTimeout(r, 100));
    expect(metrics.render([])).toMatch(/monty_errors_total\{source="http"\} \d+/);
  });

  it('production requires https for the error webhook and a long metrics token', () => {
    const base = { DATABASE_URL: 'postgresql://x', NODE_ENV: 'production', MAIL_TRANSPORT: 'smtp', SMTP_HOST: 's', APP_URL: 'https://a.example', DATA_ENCRYPTION_KEY: Buffer.alloc(32, 2).toString('base64') };
    expect(() => loadConfig({ ...base, ERROR_WEBHOOK_URL: 'http://errors.example/intake' })).toThrow(/https/);
    expect(() => loadConfig({ ...base, METRICS_TOKEN: 'short' })).toThrow(/METRICS_TOKEN/);
    expect(loadConfig({ ...base, METRICS_TOKEN: '' }).metricsToken).toBeUndefined();
  });
});
