#!/usr/bin/env bash
# Nightly logical backup of the Monty database (custom format, restorable with pg_restore).
# Keeps 14 days locally. Copy them off the server too (see docs/DEPLOYMENT_GUIDE.md "Oracle VM").
set -euo pipefail
cd "$(dirname "$0")/../.."
DEST=${BACKUP_DIR:-/var/backups/monty}
mkdir -p "$DEST" && chmod 700 "$DEST"
FILE="$DEST/monty-$(date -u +%Y%m%dT%H%M%SZ).dump"
docker compose --env-file infra/docker/.env -f compose.yaml -f infra/oracle/compose.oracle.yaml \
  exec -T postgres pg_dump -U monty -d monty --format=custom > "$FILE.partial"
mv "$FILE.partial" "$FILE"
# Uploaded files (attachments) live in a Docker volume; archive them alongside the database dump.
docker compose --env-file infra/docker/.env -f compose.yaml -f infra/oracle/compose.oracle.yaml \
  exec -T api tar -C /data -cf - uploads > "${FILE%.dump}-files.tar.partial"
mv "${FILE%.dump}-files.tar.partial" "${FILE%.dump}-files.tar"
find "$DEST" -name 'monty-*-files.tar' -mtime +14 -delete
find "$DEST" -name 'monty-*.dump' -mtime +14 -delete
echo "$(date -u +%FT%TZ) backup ok $(du -h "$FILE" | cut -f1) $FILE"
