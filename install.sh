#!/usr/bin/env bash
set -euo pipefail

# Proxmox Horizon - Source-Based Installer
#
# Goal:
# - Deploy using this repo's source code and Docker build (no host-side npm required)
# - No hardcoded localhost/domain; BASE_URL is optional
#
# Usage (on Ubuntu host where this repo exists):
#   cd proxmox
#   bash install.sh
#
# Init from scratch (DESTROYS DB/Redis/app uploads + regenerates .env secrets):
#   bash install.sh --init
#   bash install.sh --init --user admin@example.com --passwd 'Example123!'
#
# Notes:
# - For HTTPS, place certs into ./servers/nginx/certs and update ./servers/nginx/default.conf
# - This script assumes docker-compose.yml is the repo version (services/postgres/redis/app/nginx).

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log()     { echo -e "${BLUE}[INFO]${NC} $*"; }
success() { echo -e "${GREEN}[OK]${NC} $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $*"; }
die()     { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

DEPLOY_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DEPLOY_DIR"

ts="$(date +%Y%m%d-%H%M%S)"

INIT=0
ADMIN_USER_OPT=""
ADMIN_PASS_OPT=""

urlencode() {
  # RFC 3986 percent-encoding (ASCII). Keeps alnum and -_.~
  local s="${1-}"
  local out="" c hex
  local i
  for ((i=0; i<${#s}; i++)); do
    c="${s:i:1}"
    case "$c" in
      [a-zA-Z0-9.~_-]) out+="$c" ;;
      *)
        printf -v hex '%%%02X' "'$c"
        out+="$hex"
        ;;
    esac
  done
  printf '%s' "$out"
}

fix_env_database_url_if_needed() {
  local env_file="./.env"
  [ -f "$env_file" ] || return 0

  local database_url pg_pass at_count new_url
  database_url="$(grep -E '^DATABASE_URL=' "$env_file" | head -1 | cut -d= -f2- || true)"
  pg_pass="$(grep -E '^POSTGRES_PASSWORD=' "$env_file" | head -1 | cut -d= -f2- || true)"

  [ -n "${database_url}" ] || return 0

  at_count="$(printf '%s' "${database_url}" | awk -F'@' '{print NF-1}')"
  if [ "${at_count}" -ge 2 ] && [ -n "${pg_pass}" ]; then
    # Fix common case: password contains '@' but URL isn't encoded.
    new_url="postgresql://proxmox:$(urlencode "${pg_pass}")@postgres:5432/proxmox"

    if [ "${database_url}" != "${new_url}" ]; then
      warn ".env DATABASE_URL looks invalid (${at_count} '@'). Auto-fixing by URL-encoding POSTGRES_PASSWORD."
      cp -f "$env_file" "${env_file}.backup.${ts}" 2>/dev/null || true
      # Busybox sed compatible.
      sed -i "s|^DATABASE_URL=.*$|DATABASE_URL=${new_url}|" "$env_file"
      success "DATABASE_URL updated (backup: ${env_file}.backup.${ts})"
    fi
  fi
}

print_build_id() {
  if [ -f "./BUILD_ID" ]; then
    local build_id
    build_id="$(head -n 1 ./BUILD_ID 2>/dev/null | tr -d '\r\n' || true)"
    if [ -n "${build_id}" ]; then
      echo "Build: ${build_id}"
      return 0
    fi
  fi
  echo "Build: (no BUILD_ID)"
}

preflight_repo() {
  if [ "${PROXMOX_SKIP_PREFLIGHT:-0}" = "1" ]; then
    warn "Skipping preflight checks (PROXMOX_SKIP_PREFLIGHT=1)."
    return 0
  fi

  # Fail fast if the uploaded source is stale/mismatched.
  # This prevents "it builds but runs old templates" situations on fresh installs.
  local otp_tpl="./app/src/views/otp-setup.ejs"
  local auth_route="./app/src/routes/auth.ts"

  [ -f "${otp_tpl}" ] || die "Missing ${otp_tpl}. Are you running install.sh from the proxmox repo root?"

  # OTP template compatibility:
  # - New template uses: `if (locals && locals.error) ... locals.error`
  # - Older template uses: `if (error) ... error`
  # The real runtime failure happens only when the template references `error`
  # but the route does not pass `error` (EJS throws ReferenceError).
  if grep -Fq "<% if (error)" "${otp_tpl}"; then
    if [ -f "${auth_route}" ]; then
      if ! grep -n -E "render\\([\"']otp-setup[\"'][^\\n]*\\{[^\\}]*\\berror\\b" "${auth_route}" >/dev/null 2>&1; then
        die "OTP template uses 'if (error)' but ${auth_route} does not appear to pass { error: ... }.\nThis combination causes 500 on /auth/otp-setup.\nPlease upload the latest source folder (or update auth route to pass error) and retry."
      fi
    else
      warn "OTP template uses 'if (error)'. Could not verify ${auth_route} exists to ensure it passes { error: ... }."
      warn "If /auth/otp-setup returns 500, update auth route to pass 'error' (at least null/empty string)."
    fi
  fi

  if ! grep -Fq "locals && locals.error" "${otp_tpl}"; then
    warn "OTP template does not use locals.error guard (ok if auth route always passes 'error')."
  fi

  # Ensure we are not accidentally pulling assets from CDNs in fresh installs.
  if grep -R --line-number -E "cdn\\.jsdelivr\\.net" ./app/src/views >/dev/null 2>&1; then
    warn "CDN references detected under ./app/src/views (cdn.jsdelivr.net)."
    warn "This may cause tracking-prevention warnings in some browsers. Latest source should use /vendor/* assets."
  fi

  # Optional: sanity check for admin page TDZ fix (won't block installs)
  if [ -f "./app/src/views/admin.ejs" ] && grep -Eq "^(const|let) IS_ENGLISH = " ./app/src/views/admin.ejs; then
    warn "admin.ejs declares IS_ENGLISH with const/let. This can cause TDZ crash in some browsers."
    warn "Recommended: use `var IS_ENGLISH = ...`."
  fi
}

usage() {
  cat <<'EOF'
Usage:
  bash install.sh --init [--user EMAIL --passwd PASS]

Options:
  --init           Initialize from scratch: destroys existing data (.env, DB/Redis data, uploads/logs) and reinstalls
  --user EMAIL     Create the first admin automatically during install
  --passwd PASS    Password for the first admin created during install

Examples:
  bash install.sh
  bash install.sh --init
  bash install.sh --init --user admin@example.com --passwd 'Example123!'

Notes:
  - Running without arguments only shows this help and exits.
  - If --user/--passwd are omitted, create the first admin on /setup in the web UI.
  - If --user/--passwd are provided, the first admin is created automatically during install.
EOF
}

[ $# -eq 0 ] && { usage; echo; exit 0; }

args=("$@")
idx=0
while [ $idx -lt $# ]; do
  a="${args[$idx]}"
  case "$a" in
    --init)
      INIT=1
      ;;
    --user)
      idx=$((idx + 1))
      [ $idx -lt $# ] || die "--user requires a value"
      ADMIN_USER_OPT="${args[$idx]}"
      ;;
    --passwd)
      idx=$((idx + 1))
      [ $idx -lt $# ] || die "--passwd requires a value"
      ADMIN_PASS_OPT="${args[$idx]}"
      ;;
    *)
      die "Unknown argument: $a"
      ;;
  esac
  idx=$((idx + 1))
done

if [ "${INIT}" != "1" ]; then
  die "No install mode selected. Use --init for a fresh/reset install."
fi

if [ -n "${ADMIN_USER_OPT}" ] && [ -z "${ADMIN_USER_OPT// }" ]; then
  die "--user cannot be empty"
fi
if [ -n "${ADMIN_PASS_OPT}" ] && [ -z "${ADMIN_PASS_OPT// }" ]; then
  die "--passwd cannot be empty"
fi
if { [ -n "${ADMIN_USER_OPT}" ] && [ -z "${ADMIN_PASS_OPT}" ]; } || { [ -z "${ADMIN_USER_OPT}" ] && [ -n "${ADMIN_PASS_OPT}" ]; }; then
  die "--user and --passwd must be provided together"
fi

if [ ! -f docker-compose.yml ]; then
  die "docker-compose.yml not found in: $DEPLOY_DIR"
fi

if ! command -v sudo >/dev/null 2>&1; then
  die "sudo not found (this script is intended for Ubuntu/Debian)."
fi

install_docker_if_needed() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    success "Docker + Docker Compose already installed"
    return 0
  fi

  log "Installing Docker Engine + Docker Compose plugin..."
  sudo apt-get update -qq
  sudo apt-get install -y -qq ca-certificates curl gnupg lsb-release

  sudo install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  sudo chmod a+r /etc/apt/keyrings/docker.gpg

  echo \
    "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
    $(. /etc/os-release && echo \"$VERSION_CODENAME\") stable" | \
    sudo tee /etc/apt/sources.list.d/docker.list >/dev/null

  sudo apt-get update -qq
  sudo apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

  sudo systemctl enable docker >/dev/null 2>&1 || true
  sudo systemctl start docker >/dev/null 2>&1 || true

  if command -v docker >/dev/null 2>&1; then
    success "Docker installed: $(docker --version 2>/dev/null || true)"
  fi
  if docker compose version >/dev/null 2>&1; then
    success "Docker Compose installed: $(docker compose version --short 2>/dev/null || true)"
  else
    die "docker compose is not available after install"
  fi

  # Allow non-root docker usage after re-login
  if id -nG "$USER" | tr ' ' '\n' | grep -qx docker; then
    :
  else
    warn "Adding user '$USER' to docker group (re-login required to take effect)"
    sudo usermod -aG docker "$USER" || true
  fi
}

ensure_dirs() {
  log "Preparing local persistent directories..."
  mkdir -p ./servers/{app/{logs,uploads},postgres/{data,backups},redis/data,nginx/{certs,logs},backups}
  # Avoid host-side permission issues on Linux; containers run as their own users.
  sudo chown -R "$USER:$USER" ./servers || true
  # The app container runs as node (UID 1000). Ensure the backups bind-mount
  # directory is writable by that UID regardless of the host installer's UID.
  sudo chown 1000:1000 ./servers/backups 2>/dev/null || chmod 777 ./servers/backups || true
}

init_guard() {
  if [ "${INIT}" != "1" ]; then
    return 0
  fi

  echo ""
  warn "INIT requested (--init). This will DESTROY existing data:"
  echo "  - PostgreSQL data (./servers/postgres/data)"
  echo "  - Redis data (./servers/redis/data)"
  echo "  - App uploads/logs (./servers/app/uploads, ./servers/app/logs)"
  echo "  - .env secrets will be regenerated (KEY_ENCRYPTION_SECRET changes)"
  echo ""
  warn "If you need to keep existing SSH keys stored in DB, DO NOT use --init."
  echo ""
  read -r -p "Type YES to continue: " ans
  if [ "$ans" != "YES" ]; then
    die "Cancelled."
  fi

  log "Creating backup snapshot under ./backups/ ..."
  mkdir -p ./backups
  local snap="backups/init-snapshot-${ts}.tar.gz"
  tar -czf "$snap" .env servers 2>/dev/null || true
  success "Snapshot created: ${snap}"

  log "Stopping stack and removing volumes..."
  sudo docker compose down -v --remove-orphans || true

  log "Wiping persisted data directories..."
  sudo rm -rf ./servers/postgres/data/* ./servers/redis/data/* ./servers/app/uploads/* ./servers/app/logs/* 2>/dev/null || true
  sudo rm -f ./.env 2>/dev/null || true

  success "Init cleanup complete"
}

ensure_env() {
  local env_file="./.env"
  if [ -f "$env_file" ]; then
    fix_env_database_url_if_needed
    success ".env exists; keeping current settings"
    if [ -n "${ADMIN_USER_OPT}" ] || [ -n "${ADMIN_PASS_OPT}" ]; then
      warn "NOTE: --user/--passwd are ignored. Initial admin is created on first web login (/setup)."
    fi
    return 0
  fi

  log "Generating .env (secrets only; first admin will be created on first web login)..."
  local pg_pass pg_pass_enc sess_secret key_secret
  # Use URL-safe password by default (hex only) to avoid DATABASE_URL parsing issues.
  pg_pass="$(openssl rand -hex 24)"
  pg_pass_enc="$(urlencode "${pg_pass}")"
  sess_secret="$(openssl rand -hex 32)"
  key_secret="$(openssl rand -hex 32)"
  if [ -n "${ADMIN_USER_OPT}" ] || [ -n "${ADMIN_PASS_OPT}" ]; then
    warn "NOTE: --user/--passwd are deprecated and will be ignored. Use the /setup page after install."
  fi

  cat >"$env_file" <<EOF
# [Database]
POSTGRES_PASSWORD=${pg_pass}
DATABASE_URL=postgresql://proxmox:${pg_pass_enc}@postgres:5432/proxmox

# [Cache]
REDIS_URL=redis://redis:6379

# [Security]
SESSION_SECRET=${sess_secret}
KEY_ENCRYPTION_SECRET=${key_secret}

# [App]
PORT=3000
# BASE_URL is optional. If empty, the app works behind reverse proxies for any domain.
# Example: BASE_URL=https://portal.example.com
BASE_URL=
NODE_ENV=production
EOF

  chmod 600 "$env_file" || true
  success ".env generated"
  warn "IMPORTANT: Backup KEY_ENCRYPTION_SECRET. Losing it makes stored keys unrecoverable."
  echo ""
  echo "First admin account will be created on first web login:"
  echo "  - Open the service URL after install"
  echo "  - You will be redirected to /setup"
  echo "  - Create the admin email and password there"
}

bring_up() {
  log "Starting services (build from source)..."
  if [ -n "${ADMIN_USER_OPT}" ] && [ -n "${ADMIN_PASS_OPT}" ]; then
    log "Auto admin bootstrap requested for: ${ADMIN_USER_OPT}"
    sudo --preserve-env=INITIAL_ADMIN_EMAIL,INITIAL_ADMIN_PASSWORD docker compose up -d --build
  else
    sudo docker compose up -d --build
  fi
  success "docker compose up completed"
}

health_check() {
  log "Waiting for postgres health..."
  local waited=0
  local max_wait=60
  until sudo docker compose exec -T postgres pg_isready -U proxmox >/dev/null 2>&1; do
    sleep 2
    waited=$((waited + 2))
    if [ "$waited" -ge "$max_wait" ]; then
      warn "Postgres not ready after ${max_wait}s. Showing last logs..."
      sudo docker compose logs --tail=200 postgres || true
      return 1
    fi
  done
  success "Postgres ready"
  return 0
}

get_primary_ip() {
  # Best-effort: pick the src IP used for the default route.
  # Works on most Ubuntu hosts and avoids hardcoding localhost.
  local ip
  ip="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++){if($i=="src"){print $(i+1); exit}}}')"
  if [ -n "${ip}" ]; then
    echo "${ip}"
    return 0
  fi
  ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  echo "${ip}"
}

main() {
  echo ""
  echo "=========================================="
  echo "  Proxmox Horizon - Source Installer"
  echo "=========================================="
  print_build_id
  echo ""

  install_docker_if_needed
  preflight_repo
  ensure_dirs
  init_guard
  ensure_env
  if [ -n "${ADMIN_USER_OPT}" ] && [ -n "${ADMIN_PASS_OPT}" ]; then
    export INITIAL_ADMIN_EMAIL="${ADMIN_USER_OPT}"
    export INITIAL_ADMIN_PASSWORD="${ADMIN_PASS_OPT}"
  else
    unset INITIAL_ADMIN_EMAIL 2>/dev/null || true
    unset INITIAL_ADMIN_PASSWORD 2>/dev/null || true
  fi
  bring_up
  health_check || true

  echo ""
  success "Install complete."
  local host_ip http_port
  host_ip="$(get_primary_ip)"
  http_port="${HTTP_PORT:-80}"
  local https_port
  https_port="${HTTPS_PORT:-443}"
  if [ -n "${host_ip}" ]; then
    if [ "${http_port}" = "80" ]; then
      echo "Open: http://${host_ip}/"
    else
      echo "Open: http://${host_ip}:${http_port}/"
    fi
    # Show HTTPS hint only when the port is explicitly published (may still require certs).
    if [ -n "${https_port}" ] && [ "${https_port}" != "0" ]; then
      if [ "${https_port}" = "443" ]; then
        echo "HTTPS: https://${host_ip}/  (requires certs + nginx 443 config)"
      else
        echo "HTTPS: https://${host_ip}:${https_port}/  (requires certs + nginx 443 config)"
      fi
    fi
  else
    echo "Open: http://<server-ip>/"
  fi
  echo ""
  echo "Applied config paths (this is what docker-compose.yml mounts):"
  echo "- Nginx:    ./servers/nginx/default.conf"
  echo "- Postgres: ./servers/postgres/config/postgresql.conf"
  echo "- Postgres: ./servers/postgres/config/pg_hba.conf"
  echo "- Redis:    ./servers/redis/redis.conf"
  echo ""
  echo "Persistent data paths:"
  echo "- Postgres data: ./servers/postgres/data"
  echo "- Redis data:    ./servers/redis/data"
  echo "- Uploads:       ./servers/app/uploads"
  echo "- App logs:      ./servers/app/logs"
  echo "- Backups:       ./servers/backups"
  echo "- Nginx logs:    ./servers/nginx/logs"
  echo ""
  echo "Backup management CLI:"
  echo "  bash scripts/backup-db.sh create          # 백업 생성"
  echo "  bash scripts/backup-db.sh list            # 백업 목록"
  echo "  bash scripts/backup-db.sh restore <file>  # 설정 복구"
  echo "  bash scripts/backup-db.sh help            # 전체 도움말"
  echo ""
  echo "If you will use a domain/HTTPS:"
  echo "- Set BASE_URL in .env (optional, but recommended for absolute links)"
  echo "- Put certs under ./servers/nginx/certs and update ./servers/nginx/default.conf for 443"
}

main "$@"
