import { createApp } from './app.factory';
import { getConfig } from './config';

async function main() {
  const app = await createApp();
  const { port, timeouts } = getConfig();
  await app.listen(port);
  const server = app.getHttpServer() as import('node:http').Server;
  server.headersTimeout = 20_000; // slowloris protection: request headers must arrive within 20 s
  server.requestTimeout = timeouts.requestMs + 5_000; // whole request body must arrive in time
  server.keepAliveTimeout = 65_000; // longer than typical load-balancer idle timeouts (60 s) to avoid 502s
  process.stdout.write(JSON.stringify({ level: 'info', msg: 'api_listening', port }) + '\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
