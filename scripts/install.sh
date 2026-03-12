#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
CURRENT_USER="$(id -un)"
DEFAULT_APP_USER="${SUDO_USER:-$CURRENT_USER}"
SUDO=""
APT_UPDATED=0

if [[ $EUID -ne 0 ]]; then
  if command -v sudo >/dev/null 2>&1; then
    SUDO="sudo"
  else
    echo "Run this script as root or install sudo first." >&2
    exit 1
  fi
fi

run_root() {
  if [[ -n "$SUDO" ]]; then
    $SUDO bash -lc "$1"
  else
    bash -lc "$1"
  fi
}

run_app_user() {
  local app_user="$1"
  local command="$2"

  if [[ "$CURRENT_USER" == "$app_user" && -z "$SUDO" ]]; then
    bash -lc "cd '$APP_DIR' && $command"
  elif [[ $EUID -eq 0 ]]; then
    su - "$app_user" -c "cd '$APP_DIR' && $command"
  else
    $SUDO -u "$app_user" bash -lc "cd '$APP_DIR' && $command"
  fi
}

run_postgres_sql() {
  local sql="$1"

  if [[ $EUID -eq 0 ]]; then
    su - postgres -c "psql" <<SQL
$sql
SQL
  else
    $SUDO -u postgres psql <<SQL
$sql
SQL
  fi
}

confirm() {
  local prompt="$1"
  local default_answer="${2:-Y}"
  local answer

  while true; do
    read -r -p "$prompt [$default_answer/n] " answer
    answer="${answer:-$default_answer}"

    case "$answer" in
      Y|y|yes|YES) return 0 ;;
      N|n|no|NO) return 1 ;;
    esac
  done
}

prompt() {
  local label="$1"
  local default_value="${2:-}"
  local answer

  if [[ -n "$default_value" ]]; then
    read -r -p "$label [$default_value]: " answer
    echo "${answer:-$default_value}"
  else
    read -r -p "$label: " answer
    echo "$answer"
  fi
}

prompt_secret() {
  local label="$1"
  local answer
  read -r -s -p "$label: " answer
  echo
  echo "$answer"
}

ensure_apt() {
  if ! command -v apt-get >/dev/null 2>&1; then
    echo "This installer currently supports Debian/Ubuntu systems with apt." >&2
    exit 1
  fi
}

apt_install() {
  local packages=("$@")

  ensure_apt

  if [[ $APT_UPDATED -eq 0 ]]; then
    run_root "apt-get update"
    APT_UPDATED=1
  fi

  run_root "DEBIAN_FRONTEND=noninteractive apt-get install -y ${packages[*]}"
}

escape_sed() {
  printf '%s' "$1" | sed 's/[&|]/\\&/g'
}

sql_escape() {
  printf '%s' "$1" | sed "s/'/''/g"
}

uri_encode() {
  python3 - "$1" <<'PY'
import sys
from urllib.parse import quote
print(quote(sys.argv[1], safe=""))
PY
}

require_simple_identifier() {
  local value="$1"
  local label="$2"

  if [[ ! "$value" =~ ^[A-Za-z0-9_]+$ ]]; then
    echo "$label must only contain letters, numbers, and underscores." >&2
    exit 1
  fi
}

generate_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    date +%s | sha256sum | awk '{print $1}'
  fi
}

echo "Teleprompt interactive installer"
echo "Repository: $APP_DIR"
echo

mkdir -p "$APP_DIR/deploy/generated"

DOMAIN="$(prompt "Domain to serve" "teleprompt.example.com")"
APP_USER="$(prompt "Linux user to run the app" "$DEFAULT_APP_USER")"
APP_GROUP="$(id -gn "$APP_USER" 2>/dev/null || true)"

if [[ -z "$APP_GROUP" ]]; then
  echo "User $APP_USER does not exist." >&2
  exit 1
fi

APP_PORT="$(prompt "Internal app port" "3000")"
DB_NAME="$(prompt "PostgreSQL database name" "teleprompt")"
DB_USER="$(prompt "PostgreSQL database user" "teleprompt")"
DB_PASSWORD="$(prompt_secret "PostgreSQL database password")"
ADMIN_NAME="$(prompt "First admin name" "Admin")"
ADMIN_EMAIL="$(prompt "First admin email" "admin@$DOMAIN")"
ADMIN_PASSWORD="$(prompt_secret "First admin password")"
DEFAULT_PROJECT_NAME="$(prompt "Default project name" "General")"
SESSION_SECRET="$(generate_secret)"
ENCODED_DB_PASSWORD="$(uri_encode "$DB_PASSWORD")"

require_simple_identifier "$DB_NAME" "Database name"
require_simple_identifier "$DB_USER" "Database user"

if confirm "Install base system packages (nginx, postgresql, build tools, ffmpeg, curl, git)?" "Y"; then
  apt_install nginx postgresql postgresql-contrib git curl ca-certificates gnupg lsb-release \
    build-essential cmake pkg-config ffmpeg openssl python3
fi

if ! command -v node >/dev/null 2>&1 || [[ "$(node -v | sed 's/^v//; s/\..*$//')" -lt 20 ]]; then
  if confirm "Install Node.js 20 from NodeSource?" "Y"; then
    apt_install curl ca-certificates gnupg
    run_root "curl -fsSL https://deb.nodesource.com/setup_20.x | bash -"
    apt_install nodejs
  fi
fi

if confirm "Configure PostgreSQL database and user?" "Y"; then
  run_postgres_sql "
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '$DB_USER') THEN
    CREATE ROLE \"$DB_USER\" LOGIN PASSWORD '$(sql_escape "$DB_PASSWORD")';
  ELSE
    ALTER ROLE \"$DB_USER\" WITH LOGIN PASSWORD '$(sql_escape "$DB_PASSWORD")';
  END IF;
END
\$\$;
SELECT 'CREATE DATABASE \"$DB_NAME\" OWNER \"$DB_USER\"' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '$DB_NAME')\\gexec
"
fi

if confirm "Write application .env configuration?" "Y"; then
  cat > "$APP_DIR/.env" <<EOF
PORT=$APP_PORT
HOST=127.0.0.1
UPLOAD_DIR=./uploads
DATABASE_URL=postgres://$DB_USER:$ENCODED_DB_PASSWORD@127.0.0.1:5432/$DB_NAME
SESSION_SECRET=$SESSION_SECRET
SESSION_COOKIE_NAME=teleprompt_session
SESSION_DURATION_DAYS=30
WHISPER_API_URL=http://127.0.0.1:8080/inference
WHISPER_API_TIMEOUT_MS=45000
TRANSCRIBE_COMMAND=
TRANSCRIBE_INTERVAL_MS=1300
TRANSCRIBE_WINDOW_SECONDS=12
TRANSCRIBE_MIN_CHUNK_SECONDS=2
TRANSCRIBE_SILENCE_MS=900
EOF
  chown "$APP_USER:$APP_GROUP" "$APP_DIR/.env" 2>/dev/null || true
fi

if confirm "Install npm dependencies and build the app?" "Y"; then
  run_app_user "$APP_USER" "npm install"
  run_app_user "$APP_USER" "npm run build"
fi

if confirm "Run database migration?" "Y"; then
  run_app_user "$APP_USER" "node dist/server/migrate.js"
fi

if confirm "Create the first admin account in the database?" "Y"; then
  run_app_user "$APP_USER" \
    "node dist/server/bootstrap-admin.js --name $(printf '%q' "$ADMIN_NAME") --email $(printf '%q' "$ADMIN_EMAIL") --password $(printf '%q' "$ADMIN_PASSWORD") --project-name $(printf '%q' "$DEFAULT_PROJECT_NAME")"
fi

if confirm "Install and configure whisper.cpp?" "Y"; then
  WHISPER_DIR="$(prompt "Whisper install directory" "/opt/whisper.cpp")"
  WHISPER_MODEL="$(prompt "Whisper model (base.en or small.en)" "base.en")"
  WHISPER_THREADS="$(prompt "Whisper thread count" "$(nproc 2>/dev/null || echo 4)")"
  WHISPER_PROCESSORS="$(prompt "Whisper processor count" "1")"

  if [[ -d "$WHISPER_DIR/.git" ]]; then
    run_root "git -C '$WHISPER_DIR' pull --ff-only"
  else
    run_root "git clone https://github.com/ggml-org/whisper.cpp.git '$WHISPER_DIR'"
  fi

  run_root "cmake -S '$WHISPER_DIR' -B '$WHISPER_DIR/build'"
  run_root "cmake --build '$WHISPER_DIR/build' -j"
  run_root "'$WHISPER_DIR/models/download-ggml-model.sh' '$WHISPER_MODEL'"

  run_root "mkdir -p /etc/teleprompt"
  cat > "$APP_DIR/deploy/generated/whisper.env" <<EOF
WHISPER_DIR=$WHISPER_DIR
MODEL_PATH=$WHISPER_DIR/models/ggml-$WHISPER_MODEL.bin
HOST=127.0.0.1
PORT=8080
LANGUAGE=en
THREADS=$WHISPER_THREADS
PROCESSORS=$WHISPER_PROCESSORS
EXTRA_ARGS=
EOF
  run_root "cp '$APP_DIR/deploy/generated/whisper.env' /etc/teleprompt/whisper.env"
  run_root "sed -e 's|__APP_DIR__|$(escape_sed "$APP_DIR")|g' -e 's|__APP_USER__|$(escape_sed "$APP_USER")|g' -e 's|__APP_GROUP__|$(escape_sed "$APP_GROUP")|g' '$APP_DIR/deploy/teleprompt-whisper.service.template' > /etc/systemd/system/teleprompt-whisper.service"
  run_root "systemctl daemon-reload"
  run_root "systemctl enable --now teleprompt-whisper"
fi

if confirm "Install and configure the Teleprompt app systemd service?" "Y"; then
  run_root "sed -e 's|__APP_DIR__|$(escape_sed "$APP_DIR")|g' -e 's|__APP_USER__|$(escape_sed "$APP_USER")|g' -e 's|__APP_GROUP__|$(escape_sed "$APP_GROUP")|g' '$APP_DIR/deploy/teleprompt-app.service.template' > /etc/systemd/system/teleprompt-app.service"
  run_root "systemctl daemon-reload"
  run_root "systemctl enable --now teleprompt-app"
fi

if confirm "Configure nginx site for $DOMAIN?" "Y"; then
  NGINX_SITE="/etc/nginx/sites-available/$DOMAIN"
  run_root "cat > '$NGINX_SITE' <<EOF
server {
    listen 80;
    server_name $DOMAIN;

    client_max_body_size 32m;

    location / {
        proxy_pass http://127.0.0.1:$APP_PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    location /ws/ {
        proxy_pass http://127.0.0.1:$APP_PORT;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \"upgrade\";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF"
  run_root "ln -sfn '$NGINX_SITE' /etc/nginx/sites-enabled/$DOMAIN"
  run_root "nginx -t"
  run_root "systemctl reload nginx"
fi

if confirm "Install Certbot and request a Let's Encrypt certificate for $DOMAIN?" "Y"; then
  LE_EMAIL="$(prompt "Let's Encrypt email address" "$ADMIN_EMAIL")"
  apt_install certbot python3-certbot-nginx
  run_root "certbot --nginx -d '$DOMAIN' -m '$LE_EMAIL' --agree-tos --redirect --non-interactive"
fi

echo
echo "Installer complete."
echo "App directory: $APP_DIR"
echo "Domain: $DOMAIN"
echo "App service: teleprompt-app"
echo "Whisper service: teleprompt-whisper"
