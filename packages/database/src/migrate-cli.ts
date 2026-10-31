import { runMigrations } from './index';

// Migrations need the schema owner; the API itself connects as the restricted monty_app role.
const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error('MIGRATION_DATABASE_URL (or DATABASE_URL) is not set');
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
