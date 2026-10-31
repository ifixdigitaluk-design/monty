import { runMigrations } from '@monty/database';

export default async function setup() {
  const url = process.env.TEST_DATABASE_URL ?? 'postgresql://monty:monty_dev@localhost:5432/monty_test';
  if (!/test/.test(url)) throw new Error(`Refusing to run tests against a non-test database: ${url}`);
  await runMigrations(url);
}
