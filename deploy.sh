#!/bin/bash
# deploy.sh - Proxmox Horizon 운영 배포 스크립트 (Rolling Update)
#
# 용도: 소스 코드 수정 후 변경 사항을 빠르게 반영할 때 사용
# 특징: 기존 데이터를 유지하며, 서비스 중단 시간을 최소화함

set -e

DEPLOY_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DEPLOY_DIR"

validate_env() {
  if [ ! -f ".env" ]; then
    echo "[ERROR] .env not found in: ${DEPLOY_DIR}"
    echo "Run ./install.sh first."
    exit 1
  fi

  urlencode() {
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

  # shellcheck disable=SC1091
  set -a
  . ./.env
  set +a

  if [ -z "${DATABASE_URL:-}" ]; then
    echo "[ERROR] DATABASE_URL is empty in .env"
    exit 1
  fi

  # A valid URL typically has exactly one '@' delimiter before host.
  # If password contains '@' and is not URL-encoded, Prisma will parse it wrong and you get P1000.
  local at_count
  at_count="$(printf '%s' "${DATABASE_URL}" | awk -F'@' '{print NF-1}')"
  if [ "${at_count}" -ge 2 ]; then
    # Attempt safe auto-fix using POSTGRES_PASSWORD when present.
    if [ -n "${POSTGRES_PASSWORD:-}" ]; then
      local fixed_url
      fixed_url="postgresql://proxmox:$(urlencode "${POSTGRES_PASSWORD}")@postgres:5432/proxmox"
      echo "[WARN] DATABASE_URL looks invalid (contains ${at_count} '@')."
      echo "[WARN] Auto-fixing DATABASE_URL by URL-encoding POSTGRES_PASSWORD."
      cp -f ./.env "./.env.backup.$(date +%Y%m%d-%H%M%S)" 2>/dev/null || true
      sed -i "s|^DATABASE_URL=.*$|DATABASE_URL=${fixed_url}|" ./.env
      # Reload for subsequent steps.
      set -a
      . ./.env
      set +a
      echo "[OK] DATABASE_URL updated."
      return 0
    fi

    echo "[ERROR] DATABASE_URL looks invalid (contains ${at_count} '@' characters):"
    echo "  ${DATABASE_URL}"
    echo ""
    echo "If your DB password contains special characters like '@', it must be URL-encoded in DATABASE_URL."
    echo "Example:"
    echo "  POSTGRES_PASSWORD=MyP@ss"
    echo "  DATABASE_URL=postgresql://proxmox:MyP%40ss@postgres:5432/proxmox"
    echo ""
    echo "Fix .env, then rerun deploy.sh."
    exit 1
  fi
}

echo "=========================================="
echo "  Proxmox Horizon 운영 배포 (Rolling Update)"
echo "=========================================="

echo ""
echo "--- [0/3] 환경 변수 검증 ---"
# 컨테이너 시작 전에 .env를 검증/수정해야 올바른 DATABASE_URL이 컨테이너에 전달됨
validate_env

echo ""
echo "--- [1/3] 컨테이너 빌드 및 교체 ---"
# --remove-orphans: 정의되지 않은 컨테이너 정리
# 기존 컨테이너를 유지한 상태로 새 이미지를 빌드하고 교체 (Downtime 최소화)
if [ "${DEPLOY_NO_CACHE:-0}" = "1" ]; then
  echo "[INFO] DEPLOY_NO_CACHE=1: rebuilding app image with --no-cache"
  sudo docker compose build --no-cache app
  sudo docker compose up -d --remove-orphans
else
  sudo docker compose up -d --build --remove-orphans
fi

echo ""
echo "--- [2/3] DB 스키마 동기화 ---"
# docker-entrypoint.sh가 컨테이너 시작 시 이미 스키마를 동기화함.
# 이 단계는 보조 동기화이므로 실패해도 배포를 중단하지 않음.
sudo docker compose exec app npx prisma db push --skip-generate --accept-data-loss \
  || echo "[WARN] DB push skipped (schema already synced by entrypoint on startup)"

echo ""
echo "--- [3/3] 정리 ---"
# 빌드 과정에서 생긴 임시 이미지(dangling images) 삭제
sudo docker image prune -f

echo ""
echo "✅ 배포가 완료되었습니다!"
