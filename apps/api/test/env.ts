// Owner connection: migrations, fixtures and assertions in tests.
process.env.TEST_DATABASE_URL ??= 'postgresql://monty:monty_dev@localhost:5432/monty_test';
// The API under test connects as the restricted runtime role, exactly like production, so RLS is exercised.
process.env.DATABASE_URL = process.env.TEST_APP_DATABASE_URL ?? 'postgresql://monty_app:monty_app_dev@localhost:5432/monty_test';
process.env.REQUIRE_RLS = 'true';
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.AUTH_RATE_LIMIT = '1000';
process.env.RATE_LIMIT = '10000';
process.env.ALLOWED_ORIGINS = 'http://localhost:3000';
