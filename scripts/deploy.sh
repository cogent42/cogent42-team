#!/usr/bin/env bash
# Deploy cogent42-team to the configured production server.
#
# Pulls master, applies any new database migrations, then rebuilds + recreates
# only the services whose code (or transitively their shared packages) changed
# since the last deploy. Bot image rebuilds + per-user bot restarts only when
# the bot or a shared package was actually touched.
#
# Configuration: copy `deploy.env.example` to `deploy.env` at the repo root and
# fill in your server's details. Every value can also come from the real
# environment, so this script works the same in CI.
#
# Usage:  ./scripts/deploy.sh         (or `npm run deploy`)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$REPO_ROOT/deploy.env"
if [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  source "$ENV_FILE"
fi

# Required config — fail fast with a useful message.
: "${DEPLOY_SSH_TARGET:?Set DEPLOY_SSH_TARGET in deploy.env (copy deploy.env.example) or export it as an env var}"
: "${DEPLOY_APP_DIR:?Set DEPLOY_APP_DIR in deploy.env}"
: "${DEPLOY_ADMIN_TOKEN:?Set DEPLOY_ADMIN_TOKEN in deploy.env}"
: "${DEPLOY_CONTROL_PLANE_URL:=http://127.0.0.1:8080}"
: "${DEPLOY_PG_USER:=cogent}"
: "${DEPLOY_PG_DB:=cogent42_team}"

ssh "$DEPLOY_SSH_TARGET" \
  APP_DIR="$DEPLOY_APP_DIR" \
  ADMIN_TOKEN="$DEPLOY_ADMIN_TOKEN" \
  CP_URL="$DEPLOY_CONTROL_PLANE_URL" \
  PG_USER="$DEPLOY_PG_USER" \
  PG_DB="$DEPLOY_PG_DB" \
  bash -s <<'REMOTE'
set -euo pipefail
cd "$APP_DIR"

OLD=$(git rev-parse HEAD)
echo "==> git pull"
git pull --ff-only origin master
NEW=$(git rev-parse HEAD)

if [ "$OLD" = "$NEW" ]; then
  echo "==> already up-to-date (HEAD = $NEW)"
  exit 0
fi

CHANGED=$(git diff --name-only "$OLD" "$NEW")
echo "==> changed since last deploy:"
echo "$CHANGED" | sed 's/^/    /'

# 1. Migrations first — new code may need the new schema.
NEW_MIGRATIONS=$(echo "$CHANGED" | grep -E '^packages/db/migrations/.*\.sql$' || true)
if [ -n "$NEW_MIGRATIONS" ]; then
  while IFS= read -r m; do
    [ -z "$m" ] && continue
    echo "==> migrate: $m"
    docker compose exec -T postgres psql -U "$PG_USER" -d "$PG_DB" -f - < "$m"
  done <<< "$NEW_MIGRATIONS"
fi

# 2. Rebuild + recreate the compose services whose code (or shared packages they
#    depend on) changed. Shared-package changes fan out to every service.
REBUILD=()
if echo "$CHANGED" | grep -qE '^(apps/extractor-worker|packages/(db|shared))/'; then REBUILD+=("extractor-worker"); fi
if echo "$CHANGED" | grep -qE '^(apps/control-plane|packages/(db|shared))/';   then REBUILD+=("control-plane");   fi
if echo "$CHANGED" | grep -qE '^(apps/gmail-worker|packages/(db|shared))/';    then REBUILD+=("gmail-worker");    fi

if echo "$CHANGED" | grep -q '^docker-compose.yml$'; then
  echo "==> docker-compose.yml changed — recreating all services"
  docker compose up -d --build
elif [ ${#REBUILD[@]} -gt 0 ]; then
  echo "==> rebuilding: ${REBUILD[*]}"
  docker compose up -d --build "${REBUILD[@]}"
fi

# 3. Bot — rebuild image (declared in compose under the build-only profile so
#    it never starts as a compose service) and restart each provisioned user
#    bot via the admin API. The user list is fetched live from the database so
#    this script doesn't need to know who's onboarded.
if echo "$CHANGED" | grep -qE '^(apps/bot|packages/(db|shared))/'; then
  echo "==> rebuilding bot image"
  docker compose --profile build-only build bot

  USERS=$(docker compose exec -T postgres psql -U "$PG_USER" -d "$PG_DB" -tAc \
    "SELECT id FROM users WHERE status = 'active' AND telegram_bot_name IS NOT NULL" \
    | tr -d '\r')
  if [ -z "$USERS" ]; then
    echo "==> no active bots to restart"
  else
    while IFS= read -r u; do
      [ -z "$u" ] && continue
      echo "==> restart bot for user ${u:0:8}…"
      curl -fsS -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
        "$CP_URL/api/users/$u/restart" >/dev/null
    done <<< "$USERS"
  fi
fi

echo "==> done (HEAD = $NEW)"
REMOTE
