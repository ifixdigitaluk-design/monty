import { monitorEventLoopDelay } from 'node:perf_hooks';

/**
 * Minimal in-process metrics registry rendered in the Prometheus text format (no client library needed).
 * Counters/histograms are per instance; scrape every instance.
 */
const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];

class Registry {
  private readonly counters = new Map<string, number>();
  private readonly histograms = new Map<string, { buckets: number[]; sum: number; count: number }>();
  private readonly jobs = new Map<string, { lastSuccess: number | null; lastFailure: number | null; failures: number; runs: number; lastDurationMs: number }>();
  readonly loopDelay = monitorEventLoopDelay({ resolution: 20 });
  readonly startedAt = Date.now();

  constructor() {
    this.loopDelay.enable();
  }

  inc(name: string, labels: Record<string, string> = {}, by = 1) {
    const key = `${name}${fmt(labels)}`;
    this.counters.set(key, (this.counters.get(key) ?? 0) + by);
  }

  observe(name: string, labels: Record<string, string>, seconds: number) {
    const key = `${name}${fmt(labels)}`;
    const h = this.histograms.get(key) ?? { buckets: BUCKETS.map(() => 0), sum: 0, count: 0 };
    BUCKETS.forEach((b, i) => {
      if (seconds <= b) h.buckets[i]! += 1;
    });
    h.sum += seconds;
    h.count += 1;
    this.histograms.set(key, h);
  }

  /** Background jobs report every run so stalls and repeated failures are visible. */
  job(name: string, ok: boolean, durationMs: number) {
    const j = this.jobs.get(name) ?? { lastSuccess: null, lastFailure: null, failures: 0, runs: 0, lastDurationMs: 0 };
    j.runs += 1;
    j.lastDurationMs = durationMs;
    if (ok) j.lastSuccess = Date.now();
    else {
      j.failures += 1;
      j.lastFailure = Date.now();
    }
    this.jobs.set(name, j);
  }

  jobStatus() {
    return Object.fromEntries(this.jobs);
  }

  render(gauges: { name: string; help: string; value: number; labels?: Record<string, string> }[]): string {
    const out: string[] = [];
    const typed = new Set<string>();
    const header = (name: string, type: string, help: string) => {
      if (typed.has(name)) return;
      typed.add(name);
      out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    };
    for (const [key, v] of [...this.counters].sort()) {
      const name = key.split('{')[0]!;
      header(name, 'counter', HELP[name] ?? name);
      out.push(`${key} ${v}`);
    }
    for (const [key, h] of [...this.histograms].sort()) {
      const name = key.split('{')[0]!;
      const labels = key.slice(name.length);
      header(name, 'histogram', HELP[name] ?? name);
      const inner = labels ? labels.slice(1, -1) + ',' : '';
      BUCKETS.forEach((b, i) => out.push(`${name}_bucket{${inner}le="${b}"} ${h.buckets[i]}`));
      out.push(`${name}_bucket{${inner}le="+Inf"} ${h.count}`, `${name}_sum${labels} ${h.sum.toFixed(6)}`, `${name}_count${labels} ${h.count}`);
    }
    for (const [job, j] of [...this.jobs].sort()) {
      const l = fmt({ job });
      header('monty_job_runs_total', 'counter', 'Background job runs');
      out.push(`monty_job_runs_total${l} ${j.runs}`);
      header('monty_job_failures_total', 'counter', 'Background job runs that failed');
      out.push(`monty_job_failures_total${l} ${j.failures}`);
      header('monty_job_last_success_timestamp_seconds', 'gauge', 'Unix time of the last successful run (alert if stale)');
      out.push(`monty_job_last_success_timestamp_seconds${l} ${j.lastSuccess ? Math.floor(j.lastSuccess / 1000) : 0}`);
      header('monty_job_last_duration_seconds', 'gauge', 'Duration of the most recent run');
      out.push(`monty_job_last_duration_seconds${l} ${(j.lastDurationMs / 1000).toFixed(3)}`);
    }
    for (const g of gauges) {
      header(g.name, 'gauge', g.help);
      out.push(`${g.name}${fmt(g.labels ?? {})} ${Number.isFinite(g.value) ? g.value : 0}`);
    }
    return out.join('\n') + '\n';
  }
}

const HELP: Record<string, string> = {
  monty_http_requests_total: 'HTTP requests by method and status class',
  monty_http_request_duration_seconds: 'HTTP request duration (live-update streams excluded)',
  monty_errors_total: 'Unhandled server errors reported',
  monty_db_unavailable_total: 'Requests answered 503 because the database was busy or unreachable',
  monty_request_timeouts_total: 'Requests answered 503 because they exceeded REQUEST_TIMEOUT_MS',
};

function fmt(labels: Record<string, string>): string {
  const entries = Object.entries(labels);
  if (!entries.length) return '';
  return `{${entries.map(([k, v]) => `${k}="${String(v).replace(/["\\\n]/g, '_')}"`).join(',')}}`;
}

export const metrics = new Registry();

/** Times a background job and records the outcome; rethrows so callers keep their own error handling. */
export async function trackJob<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  try {
    const r = await fn();
    metrics.job(name, true, Date.now() - start);
    return r;
  } catch (err) {
    metrics.job(name, false, Date.now() - start);
    throw err;
  }
}
