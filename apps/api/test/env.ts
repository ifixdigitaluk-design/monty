process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://monty:monty_dev@localhost:5432/monty_test';
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.AUTH_RATE_LIMIT = '1000';
process.env.RATE_LIMIT = '10000';
process.env.ALLOWED_ORIGINS = 'http://localhost:3000';
