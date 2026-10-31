import { runMigrations } from './index';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

runMigrations(url)
  .then(() => {
    process.stdout.write('migrations applied\n');
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
