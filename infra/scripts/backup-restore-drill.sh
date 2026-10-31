#!/usr/bin/env bash
# Backup / restore drill: dumps a database, restores it into a scratch database and proves the copy is usable.
#
#   SOURCE_URL=postgresql://monty:pw@host:5432/monty  ADMIN_URL=postgresql://monty:pw@host:5432/postgres \
#     bash infra/scripts/backup-restore-drill.sh
#
# Checks: every table's row count matches, RLS is still enabled with the same policies, the migration journal is
# identical, and the restored database answers a tenant-scoped query as the restricted app role.
set -euo pipefail
SOURCE_URL="${SOURCE_URL:?set SOURCE_URL (owner connection to the database to back up)}"
ADMIN_URL="${ADMIN_URL:?set ADMIN_URL (connection allowed to CREATE/DROP DATABASE)}"
DRILL_DB="${DRILL_DB:-monty_restore_drill}"
OUT_DIR="${OUT_DIR:-$(mktemp -d)}"
DUMP="$OUT_DIR/monty-$(date -u +%Y%m%dT%H%M%SZ).dump"
restored_url() { echo "${SOURCE_URL%/*}/$DRILL_DB"; }

echo "1/5 dump → $DUMP"
start=$(date +%s)
pg_dump --format=custom --no-owner --no-privileges --file "$DUMP" "$SOURCE_URL"
echo "    $(du -h "$DUMP" | cut -f1) in $(( $(date +%s) - start ))s; sha256 $(sha256sum "$DUMP" | cut -c1-16)…"

echo "2/5 restore into $DRILL_DB"
psql -q "$ADMIN_URL" -c "DROP DATABASE IF EXISTS $DRILL_DB" -c "CREATE DATABASE $DRILL_DB"
start=$(date +%s)
pg_restore --no-owner --no-privileges --exit-on-error --dbname "$(restored_url)" "$DUMP"
# Privileges were not restored (they are environment-specific); re-grant the runtime role like migration 0003 does.
psql -q "$(restored_url)" -v ON_ERROR_STOP=1 <<'SQL'
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'monty_app') THEN
    GRANT USAGE ON SCHEMA public TO monty_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO monty_app;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO monty_app;
  END IF;
END $$;
SQL
echo "    restored in $(( $(date +%s) - start ))s"

counts() {
  psql -At "$1" -c "select string_agg(format('%s=%s', t, (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from %I', t), false, true, '')))[1]::text), ' ' order by t)
                    from (select tablename as t from pg_tables where schemaname = 'public') x"
}
echo "3/5 compare row counts"
a=$(counts "$SOURCE_URL"); b=$(counts "$(restored_url)")
if [[ "$a" != "$b" ]]; then echo "    MISMATCH"; diff <(tr ' ' '\n' <<<"$a") <(tr ' ' '\n' <<<"$b") || true; exit 1; fi
echo "    $(wc -w <<<"$a") tables match"

echo "4/5 compare RLS policies and migration journal"
pol() { psql -At "$1" -c "select string_agg(tablename||':'||policyname, ',' order by tablename, policyname) from pg_policies where schemaname='public'"; }
rls() { psql -At "$1" -c "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and c.relrowsecurity"; }
mig() { psql -At "$1" -c "select string_agg(hash, ',' order by created_at) from drizzle.__drizzle_migrations" 2>/dev/null || echo none; }
[[ "$(pol "$SOURCE_URL")" == "$(pol "$(restored_url)")" ]] || { echo "    policy mismatch"; exit 1; }
[[ "$(rls "$SOURCE_URL")" == "$(rls "$(restored_url)")" ]] || { echo "    RLS-enabled table count mismatch"; exit 1; }
[[ "$(mig "$SOURCE_URL")" == "$(mig "$(restored_url)")" ]] || { echo "    migration journal mismatch"; exit 1; }
echo "    $(rls "$(restored_url)") tables with RLS, policies and $(mig "$(restored_url)" | tr ',' '\n' | wc -l) migrations identical"

echo "5/5 restricted-role smoke test"
if [[ -n "${APP_ROLE_URL_TEMPLATE:-}" ]]; then
  APP_URL="${APP_ROLE_URL_TEMPLATE//\{db\}/$DRILL_DB}"
  visible=$(psql -At "$APP_URL" -c "select count(*) from projects")
  echo "    app role without a user context sees $visible projects (expected 0: RLS active)"
  [[ "$visible" == "0" ]] || { echo "    RLS NOT ACTIVE on restored copy"; exit 1; }
else
  echo "    skipped (set APP_ROLE_URL_TEMPLATE=postgresql://monty_app:pw@host:5432/{db})"
fi

[[ "${KEEP_DRILL_DB:-}" == "1" ]] || psql -q "$ADMIN_URL" -c "DROP DATABASE $DRILL_DB"
echo "Drill passed. Dump kept at $DUMP"
