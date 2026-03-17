#!/usr/bin/env bash
set -euo pipefail

# Collects docker-compose status/logs + nginx/app checks into a tarball.
# Run this on the target server inside the Proxmox deployment directory:
#   bash scripts/diagnose-internal-error.sh

ts="$(date +%Y%m%d-%H%M%S)"
out_dir="diag-${ts}"
mkdir -p "${out_dir}"

log() { printf '%s %s\n' "$(date '+%F %T')" "$*" | tee -a "${out_dir}/_run.log" >/dev/null; }

detect_compose() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    echo "docker compose"
    return 0
  fi
  if command -v docker-compose >/dev/null 2>&1; then
    echo "docker-compose"
    return 0
  fi
  return 1
}

COMPOSE_BIN="$(detect_compose || true)"
if [ -z "${COMPOSE_BIN}" ]; then
  echo "ERROR: docker compose (or docker-compose) not found."
  exit 1
fi

if [ ! -f "docker-compose.yml" ]; then
  echo "ERROR: docker-compose.yml not found in current directory: $(pwd)"
  echo "Run this script from your proxmox deploy directory (where docker-compose.yml exists)."
  exit 1
fi

run_cmd() {
  local name="$1"; shift
  log "== ${name}"
  {
    echo "\$ $*"
    "$@"
  } >"${out_dir}/${name}.txt" 2>&1 || {
    echo "(command failed: $?)" >>"${out_dir}/${name}.txt"
    return 0
  }
}

run_sh() {
  local name="$1"; shift
  log "== ${name}"
  {
    echo "\$ $*"
    bash -lc "$*"
  } >"${out_dir}/${name}.txt" 2>&1 || {
    echo "(command failed: $?)" >>"${out_dir}/${name}.txt"
    return 0
  }
}

run_cmd "env" env | sed -E 's/(TOKEN|SECRET|PASSWORD|KEY)=.*/\\1=***REDACTED***/g' >"${out_dir}/env.txt" 2>/dev/null || true

run_sh "host_info" "uname -a; echo; id; echo; pwd; echo; date; echo; (lsb_release -a 2>/dev/null || true); echo; (ip -br a 2>/dev/null || true)"
run_sh "resources" "df -h; echo; free -h 2>/dev/null || true; echo; uptime 2>/dev/null || true"
run_sh "docker_versions" "docker version 2>/dev/null || true; echo; docker info 2>/dev/null | sed -n '1,120p' || true; echo; ${COMPOSE_BIN} version 2>/dev/null || true"

# Compose inventory
run_sh "compose_ps" "${COMPOSE_BIN} ps -a"
run_sh "compose_config_paths" "${COMPOSE_BIN} config --services"

# Logs (tail only)
run_sh "logs_app" "${COMPOSE_BIN} logs --tail=400 app"
run_sh "logs_nginx" "${COMPOSE_BIN} logs --tail=400 nginx"
run_sh "logs_postgres" "${COMPOSE_BIN} logs --tail=250 postgres"
run_sh "logs_redis" "${COMPOSE_BIN} logs --tail=250 redis"

# Nginx inside-container logs/config (no secrets expected)
run_sh "nginx_error_log" "${COMPOSE_BIN} exec -T nginx sh -lc 'ls -al /var/log/nginx 2>/dev/null || true; echo; tail -n 300 /var/log/nginx/error.log 2>/dev/null || true'"
run_sh "nginx_access_log" "${COMPOSE_BIN} exec -T nginx sh -lc 'tail -n 200 /var/log/nginx/access.log 2>/dev/null || true'"
run_sh "nginx_T" "${COMPOSE_BIN} exec -T nginx sh -lc 'nginx -T 2>/dev/null | sed -n \"1,240p\" || true'"

# App quick sanity checks
run_sh "app_versions" "${COMPOSE_BIN} exec -T app sh -lc 'node -p process.version 2>/dev/null || true; npm -v 2>/dev/null || true; ls -al dist 2>/dev/null | head -n 40 || true'"
run_sh "app_otp_grep" "${COMPOSE_BIN} exec -T app sh -lc 'grep -n \"OTP_SETUP\" -n dist/routes/auth.js 2>/dev/null | head -n 120 || true'"
run_sh "app_errors_grep" "${COMPOSE_BIN} exec -T app sh -lc 'grep -R \"Internal Server Error\\|Unhandled\\|ReferenceError\\|TypeError\\|Prisma\\|Sequelize\\|ECONN\\|ETIMEDOUT\" -n dist 2>/dev/null | head -n 200 || true'"

# HTTP status checks from within nginx container (works even if host firewall blocks)
run_sh "http_checks" "${COMPOSE_BIN} exec -T nginx sh -lc '\n  set -e\n+  paths=\"/ /auth/login /auth/otp-setup /auth/otp /api/health /health\"\n+  for p in ${paths}; do\n+    echo \"\"\n+    echo \"### GET ${p}\"\n+    (wget -S -O /dev/null \"http://127.0.0.1${p}\" 2>&1 | sed -n \"1,20p\") || true\n+  done\n+'"

tarball="${out_dir}.tar.gz"
tar -czf "${tarball}" "${out_dir}"
log "OK: wrote ${tarball}"
echo "${tarball}"
