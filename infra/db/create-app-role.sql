-- Run once per environment as a database administrator, BEFORE `pnpm db:migrate`.
-- Creates the API's runtime role. It must not own tables and must not bypass RLS,
-- otherwise row-level security silently stops applying (the API refuses to start in production if so).
--
--   psql "$ADMIN_DATABASE_URL" -v app_password="'change-me'" -v dbname=monty -f infra/db/create-app-role.sql
CREATE ROLE monty_app LOGIN PASSWORD :app_password NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
GRANT CONNECT ON DATABASE :dbname TO monty_app;
GRANT USAGE ON SCHEMA public TO monty_app;
