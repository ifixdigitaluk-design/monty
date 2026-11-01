#!/usr/bin/env bash
# Pull the latest main and redeploy (migrations run automatically before the API starts).
set -euo pipefail
cd "$(dirname "$0")/../.."
bash infra/oracle/backup.sh
git pull --ff-only
RELEASE=$(git rev-parse --short HEAD)
export RELEASE
docker compose --env-file infra/docker/.env -f compose.yaml -f infra/oracle/compose.oracle.yaml up -d --build
docker compose --env-file infra/docker/.env -f compose.yaml -f infra/oracle/compose.oracle.yaml ps
