#!/usr/bin/env node
/* eslint-disable no-console -- CLI script: printing results is its job */
/**
 * Small, dependency-free load test against a running API.
 *
 *   API=http://localhost:4200 USERS=20 CONCURRENCY=40 DURATION=30 node infra/scripts/load-test.mjs
 *
 * Each virtual user registers, creates a project with tasks, then loops over a realistic mix:
 * list tasks (40%), home dashboard (20%), search (15%), update a task (15%), create a task (10%).
 * Reports throughput, latency percentiles and error counts per operation. The API's rate limits must be raised
 * for the run (RATE_LIMIT / AUTH_RATE_LIMIT), because all traffic comes from one IP.
 */
const API = (process.env.API ?? 'http://localhost:4200').replace(/\/$/, '') + '/api/v1';
const USERS = Number(process.env.USERS ?? 20);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 40);
const DURATION = Number(process.env.DURATION ?? 30) * 1000;

async function call(user, method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: { 'content-type': 'application/json', 'x-monty-client': 'web', ...(user?.cookie ? { cookie: user.cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}

async function setupUser(i) {
  const email = `load-${Date.now()}-${i}-${Math.random().toString(36).slice(2)}@example.com`;
  const reg = await call(null, 'POST', '/auth/register', { email, name: `Load ${i}`, password: 'correct-horse-battery' });
  if (reg.status !== 201) throw new Error(`register ${reg.status} ${JSON.stringify(reg.body)}`);
  const user = { cookie: reg.headers.get('set-cookie').split(';')[0] };
  const orgs = await call(user, 'GET', '/organisations');
  const ws = orgs.body.organisations[0].workspaces[0].id;
  const project = (await call(user, 'POST', `/workspaces/${ws}/projects`, { name: `Load project ${i}`, objective: 'Measure performance' })).body.project;
  user.projectId = project.id;
  user.tasks = [];
  for (let t = 0; t < 25; t++) user.tasks.push((await call(user, 'POST', `/projects/${project.id}/tasks`, { title: `Seed task ${t} alpha` })).body.task);
  return user;
}

const ops = {
  listTasks: (u) => call(u, 'GET', `/projects/${u.projectId}/tasks`),
  home: (u) => call(u, 'GET', '/me/home'),
  search: (u) => call(u, 'GET', '/search?q=alpha'),
  updateTask: async (u) => {
    const t = u.tasks[Math.floor(Math.random() * u.tasks.length)];
    const r = await call(u, 'PATCH', `/tasks/${t.id}`, { expectedVersion: t.version, priority: ['LOW', 'MEDIUM', 'HIGH'][Math.floor(Math.random() * 3)] });
    if (r.status === 200) Object.assign(t, r.body.task);
    else if (r.status === 409) t.version = r.body.error?.details?.current?.version ?? t.version; // expected under contention
    return r;
  },
  createTask: async (u) => {
    const r = await call(u, 'POST', `/projects/${u.projectId}/tasks`, { title: `Load task ${Date.now()}` });
    if (r.status === 201) u.tasks.push(r.body.task);
    return r;
  },
};
const SKIP = new Set((process.env.SKIP ?? '').split(',').filter(Boolean));
const MIX = [...Array(40).fill('listTasks'), ...Array(20).fill('home'), ...Array(15).fill('search'), ...Array(15).fill('updateTask'), ...Array(10).fill('createTask')].filter((op) => !SKIP.has(op));

const pct = (arr, p) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor((p / 100) * arr.length))] : 0);

async function main() {
  console.log(`Setting up ${USERS} users against ${API} …`);
  const users = [];
  for (let i = 0; i < USERS; i++) users.push(await setupUser(i));
  console.log(`Running ${CONCURRENCY} concurrent workers for ${DURATION / 1000}s …`);
  const stats = Object.fromEntries(Object.keys(ops).map((k) => [k, { lat: [], errors: 0, conflicts: 0, throttled: 0 }]));
  const end = Date.now() + DURATION;
  let total = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async (_, w) => {
      while (Date.now() < end) {
        const op = MIX[Math.floor(Math.random() * MIX.length)];
        const u = users[(w + total) % users.length];
        const t0 = performance.now();
        try {
          const r = await ops[op](u);
          const s = stats[op];
          s.lat.push(performance.now() - t0);
          if (r.status === 409) s.conflicts += 1;
          else if (r.status === 429) s.throttled += 1; // per-IP protection working as designed
          else if (r.status >= 400) s.errors += 1;
        } catch {
          stats[op].errors += 1;
        }
        total += 1;
      }
    }),
  );
  const rows = Object.entries(stats).map(([op, s]) => {
    s.lat.sort((a, b) => a - b);
    return { op, requests: s.lat.length, p50: pct(s.lat, 50).toFixed(1), p95: pct(s.lat, 95).toFixed(1), p99: pct(s.lat, 99).toFixed(1), errors: s.errors, conflicts409: s.conflicts, throttled429: s.throttled };
  });
  const all = Object.values(stats).flatMap((s) => s.lat).sort((a, b) => a - b);
  const errors = Object.values(stats).reduce((n, s) => n + s.errors, 0);
  console.table(rows);
  const summary = { requests: total, rps: Math.round(total / (DURATION / 1000)), p50: pct(all, 50).toFixed(1), p95: pct(all, 95).toFixed(1), p99: pct(all, 99).toFixed(1), errors };
  console.log(JSON.stringify(summary));
  if (errors > 0) process.exitCode = 1;
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
