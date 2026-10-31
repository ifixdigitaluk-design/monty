import { createApp } from './app.factory';
import { getConfig } from './config';

async function main() {
  const app = await createApp();
  const { port } = getConfig();
  await app.listen(port);
  process.stdout.write(JSON.stringify({ level: 'info', msg: 'api_listening', port }) + '\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
