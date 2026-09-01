#!/bin/sh

# Back up the self-hosted auth/template metadata database before deployment.
# The Docker deployment stores /app/data/auth-db.json in this volume.

set -e

COMPOSE_PROJECT=${COMPOSE_PROJECT:-krug-sites-project}
AUTH_VOLUME=${AUTH_VOLUME:-${COMPOSE_PROJECT}_sites-auth-data-prod}
BACKUP_ROOT=${BACKUP_ROOT:-/root/krug-sites-backups}
BACKUP_KEEP=${BACKUP_KEEP:-30}
BACKUP_PREFIX=${BACKUP_PREFIX:-auth-db}

timestamp=$(date +%Y%m%d-%H%M%S)
backup_name="${BACKUP_PREFIX}-${timestamp}.json"

if ! docker volume inspect "$AUTH_VOLUME" >/dev/null 2>&1; then
  echo "SKIP: Docker volume not found: $AUTH_VOLUME"
  exit 0
fi

mkdir -p "$BACKUP_ROOT"

set +e
docker run --rm \
  -v "$AUTH_VOLUME:/data:ro" \
  -v "$BACKUP_ROOT:/backup" \
  alpine sh -c '[ -s /data/auth-db.json ] || exit 2; cp /data/auth-db.json "/backup/$0"' "$backup_name"
status=$?
set -e

if [ "$status" -eq 2 ]; then
  echo "SKIP: /data/auth-db.json is missing or empty in $AUTH_VOLUME"
  exit 0
fi

if [ "$status" -ne 0 ]; then
  echo "ERROR: failed to back up $AUTH_VOLUME/auth-db.json" >&2
  exit "$status"
fi

if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "$BACKUP_ROOT/$backup_name" > "$BACKUP_ROOT/$backup_name.sha256" || true
fi

if [ "$BACKUP_KEEP" -gt 0 ] 2>/dev/null; then
  find "$BACKUP_ROOT" -type f -name "${BACKUP_PREFIX}-*.json" \
    | sort -r \
    | awk "NR>${BACKUP_KEEP}" \
    | while IFS= read -r old_backup; do
        rm -f "$old_backup" "$old_backup.sha256"
      done
fi

echo "OK: $BACKUP_ROOT/$backup_name"
