#!/usr/bin/env sh
set -eu

if [ "${1:-}" = "" ]; then
  echo "Usage: $0 <domain>" >&2
  exit 1
fi

DOMAIN="$1"
ROOT_DIR="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
OUT_DIR="$ROOT_DIR/deploy/generated/$DOMAIN"
NGINX_TEMPLATE="$ROOT_DIR/deploy/nginx.site.conf.template"
ENV_TEMPLATE="$ROOT_DIR/.env.example"
SESSION_SECRET="${SESSION_SECRET:-}"

mkdir -p "$OUT_DIR"

if [ -z "$SESSION_SECRET" ]; then
  if command -v openssl >/dev/null 2>&1; then
    SESSION_SECRET="$(openssl rand -hex 32)"
  else
    SESSION_SECRET="$(date +%s)-replace-me"
  fi
fi

sed "s|__DOMAIN__|$DOMAIN|g" "$NGINX_TEMPLATE" > "$OUT_DIR/nginx.$DOMAIN.conf"
sed "s|^SESSION_SECRET=.*|SESSION_SECRET=$SESSION_SECRET|" "$ENV_TEMPLATE" > "$OUT_DIR/.env"

cat <<EOF
Generated deployment files in:
  $OUT_DIR

Files:
  $OUT_DIR/nginx.$DOMAIN.conf
  $OUT_DIR/.env

Next steps:
1. Review DATABASE_URL and WHISPER_API_URL in $OUT_DIR/.env
2. Copy the nginx file to /etc/nginx/sites-available/$DOMAIN
3. Request a TLS certificate for $DOMAIN
EOF
