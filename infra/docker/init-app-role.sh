#!/bin/sh
# Runs once when the Postgres volume is first initialised (docker-entrypoint-initdb.d).
# Creates the API's restricted runtime role BEFORE migrations, so migration 0003 grants it table access.
set -eu
: "${MONTY_APP_DB_PASSWORD:?MONTY_APP_DB_PASSWORD is required}"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -v pw="$MONTY_APP_DB_PASSWORD" <<'SQL'
CREATE ROLE monty_app LOGIN PASSWORD :'pw' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
GRANT CONNECT ON DATABASE monty TO monty_app;
GRANT USAGE ON SCHEMA public TO monty_app;
SQL
