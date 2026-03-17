#!/usr/bin/env bash
# =============================================================================
# recover-admin-login.sh
# 전체 DB 복구(restoreFullDb) 완료 후 관리자 로그인이 불가할 때 수동으로 실행하는
# 운영 복구 스크립트입니다.
#
# 처리 항목:
#   1. 관리자 계정 isActive/isAdmin 보정 및 mustChangePassword 해제
#   2. TOTP(OTP) 비활성화 + 복구 코드 초기화
#   3. 기본 관리자 그룹(admin) 재매핑
#   4. 감사 로그 기록
#
# 사용법:
#   bash scripts/recover-admin-login.sh [ADMIN_EMAIL]
#
# 예시:
#   bash scripts/recover-admin-login.sh proxmox@proxmox.io
#
# 주의:
#   - PostgreSQL 클라이언트(psql)가 설치된 환경에서 실행하세요.
#   - DATABASE_URL 환경 변수가 설정되어 있거나 .env 파일이 있어야 합니다.
#   - Docker 컨테이너 내부에서 실행하거나 컨테이너에 exec하여 사용할 수 있습니다.
#     예: docker exec -it proxmox-app bash scripts/recover-admin-login.sh
# =============================================================================

set -euo pipefail

# ─── 환경 변수 로드 ──────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/../app/.env"

if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC2046
  export $(grep -v '^#' "$ENV_FILE" | xargs -d '\n') 2>/dev/null || true
fi

DATABASE_URL="${DATABASE_URL:-}"
if [[ -z "$DATABASE_URL" ]]; then
  echo "[ERROR] DATABASE_URL이 설정되지 않았습니다." >&2
  exit 1
fi

# ─── 연결 정보 파싱 ──────────────────────────────────────────────────────────
# postgresql://user:password@host:port/dbname
DB_USER=$(echo "$DATABASE_URL" | sed -E 's|postgresql://([^:]+):.*|\1|')
DB_PASS=$(echo "$DATABASE_URL" | sed -E 's|postgresql://[^:]+:([^@]+)@.*|\1|')
DB_HOST=$(echo "$DATABASE_URL" | sed -E 's|.*@([^:]+):.*|\1|')
DB_PORT=$(echo "$DATABASE_URL" | sed -E 's|.*:([0-9]+)/.*|\1|')
DB_NAME=$(echo "$DATABASE_URL" | sed -E 's|.*/([^?]+).*|\1|')

export PGPASSWORD="$DB_PASS"

PSQL_CMD="psql -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME -v ON_ERROR_STOP=1"

# ─── 관리자 이메일 결정 ──────────────────────────────────────────────────────
ADMIN_EMAIL="${1:-${INITIAL_ADMIN_EMAIL:-proxmox@proxmox.io}}"
echo "[INFO] 관리자 이메일: $ADMIN_EMAIL"

# ─── 사용자 존재 여부 확인 ───────────────────────────────────────────────────
USER_EXISTS=$($PSQL_CMD -tAc "SELECT COUNT(*) FROM \"User\" WHERE email = '$ADMIN_EMAIL';" 2>/dev/null || echo "0")
if [[ "$USER_EXISTS" == "0" ]]; then
  echo "[WARN] 해당 이메일의 사용자가 없습니다: $ADMIN_EMAIL"
  echo "       DB 복구 후 사용자 테이블이 올바르게 복원되었는지 확인하세요."
  exit 1
fi

# ─── 1. 관리자 계정 활성/권한 보정 + 비밀번호 변경 플래그 해제 ────────────────
echo "[INFO] 1/4 관리자 계정 상태 보정 중..."
$PSQL_CMD -c "
UPDATE \"User\"
SET
  \"isActive\"          = true,
  \"isAdmin\"           = true,
  \"mustChangePassword\" = false,
  \"updatedAt\"         = NOW()
WHERE email = '$ADMIN_EMAIL';
"
echo "       완료: isActive=true, isAdmin=true, mustChangePassword=false"

# ─── 2. OTP 비활성화 + 복구 코드 초기화 ─────────────────────────────────────
echo "[INFO] 2/4 OTP 비활성화 및 복구 코드 초기화 중..."
USER_ID=$($PSQL_CMD -tAc "SELECT id FROM \"User\" WHERE email = '$ADMIN_EMAIL';" | tr -d '[:space:]')

$PSQL_CMD -c "
UPDATE \"User\"
SET
  \"totpEnabled\" = false,
  \"totpSecret\"  = NULL,
  \"updatedAt\"   = NOW()
WHERE id = '$USER_ID';
"

$PSQL_CMD -c "
DELETE FROM \"OtpRecoveryCode\" WHERE \"userId\" = '$USER_ID';
"
echo "       완료: TOTP 비활성화 + 복구 코드 삭제"

# ─── 3. 기본 관리자 그룹 재매핑 ──────────────────────────────────────────────
echo "[INFO] 3/4 관리자 그룹 매핑 보장 중..."
ADMIN_GROUP_ID=$($PSQL_CMD -tAc "SELECT id FROM \"Group\" WHERE LOWER(name) LIKE '%admin%' LIMIT 1;" | tr -d '[:space:]')

if [[ -n "$ADMIN_GROUP_ID" ]]; then
  MEMBERSHIP_EXISTS=$($PSQL_CMD -tAc "
    SELECT COUNT(*) FROM \"GroupMembership\"
    WHERE \"userId\" = '$USER_ID' AND \"groupId\" = '$ADMIN_GROUP_ID';
  " | tr -d '[:space:]')

  if [[ "$MEMBERSHIP_EXISTS" == "0" ]]; then
    MEMBERSHIP_ID="gm-recover-$(date +%s)"
    $PSQL_CMD -c "
    INSERT INTO \"GroupMembership\" (id, \"userId\", \"groupId\", role)
    VALUES ('$MEMBERSHIP_ID', '$USER_ID', '$ADMIN_GROUP_ID', 'admin');
    "
    echo "       완료: 그룹 멤버십 신규 추가 (groupId=$ADMIN_GROUP_ID)"
  else
    $PSQL_CMD -c "
    UPDATE \"GroupMembership\"
    SET role = 'admin'
    WHERE \"userId\" = '$USER_ID' AND \"groupId\" = '$ADMIN_GROUP_ID';
    "
    echo "       완료: 기존 그룹 멤버십 role=admin 보정"
  fi
else
  echo "       [SKIP] admin 그룹이 존재하지 않음 (그룹 매핑 생략)"
fi

# ─── 4. 감사 로그 기록 ───────────────────────────────────────────────────────
echo "[INFO] 4/4 감사 로그 기록 중..."
LOG_ID="al-recover-$(date +%s)"
$PSQL_CMD -c "
INSERT INTO \"AuditLog\" (id, \"userId\", action, result, reason, \"requestIp\", \"createdAt\")
VALUES (
  '$LOG_ID',
  '$USER_ID',
  'ADMIN_RECOVERY',
  'SUCCESS',
  'recover-admin-login.sh: 백업 복구 후 관리자 계정 보정',
  '127.0.0.1',
  NOW()
);
" 2>/dev/null || echo "       [WARN] 감사 로그 기록 실패 (무시)"

echo ""
echo "======================================================"
echo " 관리자 로그인 복구 완료"
echo " 이메일  : $ADMIN_EMAIL"
echo " OTP     : 비활성화됨 (재설정 필요)"
echo " 상태    : 활성, 관리자 권한"
echo "======================================================"
echo " 앱 재시작 후 로그인하세요."
