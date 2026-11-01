#!/usr/bin/env bash
# One-time setup of Monty on a fresh Ubuntu 22.04/24.04 server (Oracle Cloud Always Free ARM works well).
# Run from the repository folder:   sudo bash infra/oracle/install.sh
# Re-running is safe: secrets are generated only once and kept in infra/docker/.env.
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT=$(pwd)
ENV_FILE="$ROOT/infra/docker/.env"
[ "$(id -u)" -eq 0 ] || { echo "Run with sudo"; exit 1; }

echo "== 1/6 Docker"
if ! command -v docker >/dev/null; then
  apt-get update -q
  apt-get install -y -q ca-certificates curl gnupg
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" > /etc/apt/sources.list.d/docker.list
  apt-get update -q
  apt-get install -y -q docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
docker compose version

echo "== 2/6 Firewall (Oracle Ubuntu images block 80/443 in iptables by default)"
if command -v iptables >/dev/null; then
  for p in 80 443; do
    iptables -C INPUT -p tcp --dport $p -m state --state NEW -j ACCEPT 2>/dev/null || iptables -I INPUT 6 -p tcp --dport $p -m state --state NEW -j ACCEPT
  done
  if command -v netfilter-persistent >/dev/null; then netfilter-persistent save; else apt-get install -y -q iptables-persistent && netfilter-persistent save; fi
fi
echo "   Also open TCP 80 and 443 in the Oracle console: Networking → VCN → Security List → Ingress rules."

echo "== 3/6 Settings"
ask() { local var=$1 prompt=$2 secret=${3:-}; local cur; cur=$(grep -E "^$var=" "$ENV_FILE" 2>/dev/null | cut -d= -f2- || true)
  if [ -n "$cur" ]; then echo "   $var already set"; return; fi
  local val; if [ -n "$secret" ]; then read -r -s -p "   $prompt: " val; echo; else read -r -p "   $prompt: " val; fi
  echo "$var=$val" >> "$ENV_FILE"; }
gen() { local var=$1 val=$2; grep -qE "^$var=.+" "$ENV_FILE" 2>/dev/null || echo "$var=$val" >> "$ENV_FILE"; }
touch "$ENV_FILE"; chmod 600 "$ENV_FILE"
ask MONTY_DOMAIN "Your address without https (e.g. yourteam-monty.duckdns.org)"
ask ACME_EMAIL "Email for HTTPS certificate notices"
ask SMTP_USER "Gmail address that sends Monty's emails"
ask SMTP_PASS "Gmail app password (16 letters, input hidden)" secret
gen SMTP_HOST smtp.gmail.com
gen SMTP_PORT 587
gen SMTP_SECURE false
gen MAIL_FROM "Monty <$(grep -E '^SMTP_USER=' "$ENV_FILE" | cut -d= -f2-)>"
gen APP_URL "https://$(grep -E '^MONTY_DOMAIN=' "$ENV_FILE" | cut -d= -f2-)"
gen POSTGRES_PASSWORD "$(openssl rand -hex 24)"
gen MONTY_APP_DB_PASSWORD "$(openssl rand -hex 24)"
gen DATA_ENCRYPTION_KEY "$(openssl rand -base64 32)"
gen METRICS_TOKEN "$(openssl rand -hex 24)"
gen SIGNUP_MODE invite
gen AI_PROVIDER local
if ! grep -qE '^GOOGLE_CLIENT_ID=' "$ENV_FILE"; then
  echo "   Optional: \"Continue with Google\". Create an OAuth client first (see infra/oracle/README.md), or leave empty."
  read -r -p "   Google OAuth client ID (leave empty to skip): " gid
  echo "GOOGLE_CLIENT_ID=$gid" >> "$ENV_FILE"
  if [ -n "$gid" ]; then
    read -r -s -p "   Google OAuth client secret (input hidden): " gsec; echo
    echo "GOOGLE_CLIENT_SECRET=$gsec" >> "$ENV_FILE"
    read -r -p "   Only allow Google accounts from these domains (comma-separated, empty = any): " gdom
    echo "GOOGLE_ALLOWED_DOMAINS=$gdom" >> "$ENV_FILE"
  else
    echo "GOOGLE_CLIENT_SECRET=" >> "$ENV_FILE"
  fi
fi
echo "   Saved to $ENV_FILE (readable by root only). Back up DATA_ENCRYPTION_KEY somewhere safe."

echo "== 4/6 DuckDNS (optional: keeps your free address pointing at this server)"
if ! grep -qE '^DUCKDNS_TOKEN=' "$ENV_FILE"; then
  read -r -p "   DuckDNS token (leave empty to skip): " tok
  echo "DUCKDNS_TOKEN=$tok" >> "$ENV_FILE"
fi
TOKEN=$(grep -E '^DUCKDNS_TOKEN=' "$ENV_FILE" | cut -d= -f2-)
DOMAIN=$(grep -E '^MONTY_DOMAIN=' "$ENV_FILE" | cut -d= -f2-)
if [ -n "$TOKEN" ] && [[ "$DOMAIN" == *.duckdns.org ]]; then
  SUB=${DOMAIN%.duckdns.org}
  cat > /etc/cron.d/monty-duckdns <<CRON
*/5 * * * * root curl -fsS "https://www.duckdns.org/update?domains=${SUB}&token=${TOKEN}&ip=" -o /var/log/monty-duckdns.log
CRON
  curl -fsS "https://www.duckdns.org/update?domains=${SUB}&token=${TOKEN}&ip=" && echo "   DuckDNS updated"
fi

echo "== 5/6 Start Monty"
RELEASE=$(git rev-parse --short HEAD 2>/dev/null || echo unknown)
export RELEASE
docker compose --env-file "$ENV_FILE" -f compose.yaml -f infra/oracle/compose.oracle.yaml up -d --build

echo "== 6/6 Daily backups at 02:15 (kept 14 days in /var/backups/monty)"
cat > /etc/cron.d/monty-backup <<CRON
15 2 * * * root bash $ROOT/infra/oracle/backup.sh >> /var/log/monty-backup.log 2>&1
CRON

echo
echo "Done. In a minute or two open https://$DOMAIN"
echo "The first account you create becomes possible without an invitation; create yours now, then invite staff from Members & settings."
