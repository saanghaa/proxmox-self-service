#!/bin/bash
#
# Proxmox Horizon DB 백업/복구 관리 스크립트
#
# 웹 UI의 백업 기능과 동일한 포맷으로 백업/복구를 수행합니다.
# 백업 파일은 ./servers/backups/ 에 저장됩니다 (웹 UI와 공유).
#
# 사용법:
#   ./scripts/backup-db.sh create              백업 생성
#   ./scripts/backup-db.sh list                백업 목록 조회
#   ./scripts/backup-db.sh restore <파일명>    설정 복구 (Config Only)
#   ./scripts/backup-db.sh restore <파일명> full  전체 DB 복구
#   ./scripts/backup-db.sh delete <파일명>     백업 삭제
#   ./scripts/backup-db.sh prune [days]        보존 기간 초과 백업 삭제 (기본 7일)
#   ./scripts/backup-db.sh help                도움말
#

set -euo pipefail

# ─── 색상 ────────────────────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

log()  { echo -e "${GREEN}[$(date +'%H:%M:%S')]${NC} $1"; }
info() { echo -e "${CYAN}[INFO]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
err()  { echo -e "${RED}[ERROR]${NC} $1" >&2; }
die()  { err "$1"; exit 1; }

# ─── 경로 설정 ───────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
BACKUP_DIR="$PROJECT_ROOT/servers/backups"

cd "$PROJECT_ROOT"

# ─── 공통 헬퍼 ───────────────────────────────────────────────────────────────

check_dependencies() {
    command -v docker &>/dev/null || die "Docker가 설치되어 있지 않습니다."
    docker compose ps &>/dev/null 2>&1 || die "docker-compose.yml이 없거나 Docker Compose 실행에 실패했습니다."
}

check_postgres_running() {
    docker compose ps postgres 2>/dev/null | grep -q "running" \
        || die "postgres 컨테이너가 실행 중이지 않습니다. 먼저 'docker compose up -d'를 실행하세요."
}

get_db_credentials() {
    # .env에서 DATABASE_URL 파싱
    if [ -f ".env" ]; then
        source .env 2>/dev/null || true
    fi

    DB_URL="${DATABASE_URL:-}"
    if [ -z "$DB_URL" ]; then
        die "DATABASE_URL 환경변수가 설정되어 있지 않습니다. .env 파일을 확인하세요."
    fi

    # postgresql://user:password@host:port/dbname 파싱
    # sed로 각 컴포넌트 추출
    DB_USER=$(echo "$DB_URL" | sed -E 's|postgresql://([^:]+):.*|\1|')
    DB_NAME=$(echo "$DB_URL" | sed -E 's|.*/([^?]+).*|\1|')
}

ensure_backup_dir() {
    mkdir -p "$BACKUP_DIR"
}

format_size() {
    local file="$1"
    if [ -f "$file" ]; then
        du -h "$file" | cut -f1
    else
        echo "?"
    fi
}

format_date() {
    # 파일명에서 날짜 파싱: proxmox-backup-YYYYMMDD_HHmmss.tar.gz
    local filename="$1"
    local ts
    ts=$(echo "$filename" | sed -E 's/proxmox-backup-([0-9]{8})_([0-9]{6})\.tar\.gz/\1_\2/')
    if [[ "$ts" =~ ^([0-9]{4})([0-9]{2})([0-9]{2})_([0-9]{2})([0-9]{2})([0-9]{2})$ ]]; then
        echo "${BASH_REMATCH[1]}-${BASH_REMATCH[2]}-${BASH_REMATCH[3]} ${BASH_REMATCH[4]}:${BASH_REMATCH[5]}:${BASH_REMATCH[6]}"
    else
        echo "$filename"
    fi
}

# ─── 명령: create ─────────────────────────────────────────────────────────────

cmd_create() {
    check_dependencies
    check_postgres_running
    ensure_backup_dir
    get_db_credentials

    local TIMESTAMP
    TIMESTAMP=$(date +%Y%m%d_%H%M%S)
    local ARCHIVE_NAME="proxmox-backup-${TIMESTAMP}.tar.gz"
    local TMP_DIR="$BACKUP_DIR/tmp-${TIMESTAMP}"
    local ARCHIVE_PATH="$BACKUP_DIR/$ARCHIVE_NAME"

    log "백업 생성 시작: ${BOLD}$ARCHIVE_NAME${NC}"

    # 1. 임시 디렉토리 생성
    mkdir -p "$TMP_DIR"

    trap 'rm -rf "$TMP_DIR"' EXIT

    # 2. pg_dump (custom 포맷)
    log "PostgreSQL 덤프 중..."
    docker compose exec -T postgres \
        pg_dump -U "$DB_USER" -Fc "$DB_NAME" \
        > "$TMP_DIR/db.dump"
    local DUMP_SIZE
    DUMP_SIZE=$(format_size "$TMP_DIR/db.dump")
    log "  ✓ db.dump 생성 완료 ($DUMP_SIZE)"

    # 3. SystemConfig JSON 추출
    log "SystemConfig 추출 중..."
    docker compose exec -T postgres \
        psql -U "$DB_USER" -d "$DB_NAME" -t -A \
        -c "SELECT json_agg(row_to_json(t)) FROM (SELECT id, key, value, \"createdAt\", \"updatedAt\" FROM \"SystemConfig\" ORDER BY key) t;" \
        | head -1 > "$TMP_DIR/config.json"
    log "  ✓ config.json 생성 완료"

    # 4. 메타데이터 생성
    cat > "$TMP_DIR/info.json" <<EOF
{
  "createdAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "createdBy": "backup-db.sh",
  "dbName": "$DB_NAME",
  "dbUser": "$DB_USER",
  "host": "$(hostname)"
}
EOF
    log "  ✓ info.json 생성 완료"

    # 5. tar.gz 압축
    log "아카이브 압축 중..."
    tar -czf "$ARCHIVE_PATH" -C "$BACKUP_DIR" "tmp-${TIMESTAMP}"
    local ARCHIVE_SIZE
    ARCHIVE_SIZE=$(format_size "$ARCHIVE_PATH")

    log ""
    log "${GREEN}${BOLD}✅ 백업 생성 완료!${NC}"
    log "   파일: ${BOLD}$ARCHIVE_PATH${NC}"
    log "   크기: $ARCHIVE_SIZE"
    log ""

    echo "$ARCHIVE_NAME"
}

# ─── 명령: list ──────────────────────────────────────────────────────────────

cmd_list() {
    ensure_backup_dir

    local files=()
    while IFS= read -r -d '' f; do
        files+=("$f")
    done < <(find "$BACKUP_DIR" -maxdepth 1 -name "proxmox-backup-*.tar.gz" -print0 2>/dev/null | sort -zr)

    if [ ${#files[@]} -eq 0 ]; then
        info "저장된 백업이 없습니다."
        return 0
    fi

    echo ""
    printf "${BOLD}%-50s %8s  %-19s${NC}\n" "파일명" "크기" "생성일"
    printf '%s\n' "$(printf '─%.0s' {1..82})"

    local total_size=0
    for f in "${files[@]}"; do
        local fname
        fname=$(basename "$f")
        local size
        size=$(format_size "$f")
        local date_str
        date_str=$(format_date "$fname")
        printf "%-50s %8s  %s\n" "$fname" "$size" "$date_str"
    done

    echo ""
    info "총 ${#files[@]}개 백업 | 저장 위치: $BACKUP_DIR"
    echo ""
}

# ─── 명령: restore ───────────────────────────────────────────────────────────

cmd_restore() {
    local FILENAME="${1:-}"
    local RESTORE_TYPE="${2:-config}"

    [ -z "$FILENAME" ] && die "복구할 파일명을 지정하세요.\n  사용법: $0 restore <파일명> [config|full]"
    [[ "$RESTORE_TYPE" == "config" || "$RESTORE_TYPE" == "full" ]] \
        || die "복구 유형은 'config' 또는 'full' 중 하나여야 합니다."

    # 경로 트래버설 방지
    FILENAME=$(basename "$FILENAME")
    local ARCHIVE_PATH="$BACKUP_DIR/$FILENAME"

    [ -f "$ARCHIVE_PATH" ] || die "백업 파일을 찾을 수 없습니다: $ARCHIVE_PATH"

    check_dependencies
    check_postgres_running
    get_db_credentials

    echo ""
    info "복구 대상 파일: ${BOLD}$FILENAME${NC}"
    info "복구 유형:      ${BOLD}$RESTORE_TYPE${NC}"

    if [ "$RESTORE_TYPE" = "full" ]; then
        echo ""
        echo -e "${RED}${BOLD}⚠️  경고: 전체 DB 복구${NC}"
        echo "   현재 DB의 모든 데이터가 삭제되고 백업 내용으로 대체됩니다."
        echo "   이 작업은 되돌릴 수 없습니다."
        echo ""
        read -r -p "정말 진행하시겠습니까? (yes 입력): " CONFIRM
        [ "$CONFIRM" = "yes" ] || { info "취소되었습니다."; exit 0; }
    fi

    local TIMESTAMP
    TIMESTAMP=$(date +%Y%m%d_%H%M%S)
    local TMP_DIR="$BACKUP_DIR/restore-tmp-${TIMESTAMP}"

    mkdir -p "$TMP_DIR"
    trap 'rm -rf "$TMP_DIR"' EXIT

    # 압축 해제
    log "아카이브 압축 해제 중..."
    tar -xzf "$ARCHIVE_PATH" -C "$TMP_DIR" --strip-components=1
    log "  ✓ 압축 해제 완료"

    if [ "$RESTORE_TYPE" = "config" ]; then
        # ── Config 복구 ──────────────────────────────────────────────────────
        local CONFIG_FILE="$TMP_DIR/config.json"
        [ -f "$CONFIG_FILE" ] || die "백업에 config.json이 없습니다."

        log "SystemConfig 복구 중..."

        # Python으로 JSON 파싱 후 upsert (psql 사용)
        python3 - "$CONFIG_FILE" <<'PYEOF'
import json, sys, subprocess

config_file = sys.argv[1]
with open(config_file, 'r', encoding='utf-8') as f:
    entries = json.load(f)

if not entries:
    print("[Config Restore] config.json이 비어 있습니다.")
    sys.exit(0)

count = 0
for entry in entries:
    key = entry['key'].replace("'", "''")
    value = entry['value'].replace("'", "''")
    sql = f"""
INSERT INTO "SystemConfig" (id, key, value, "createdAt", "updatedAt")
VALUES (gen_random_uuid()::text, '{key}', '{value}', NOW(), NOW())
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, "updatedAt" = NOW();
"""
    result = subprocess.run(
        ['docker', 'compose', 'exec', '-T', 'postgres',
         'psql', '-U', 'proxmox', '-d', 'proxmox', '-c', sql],
        capture_output=True, text=True
    )
    if result.returncode != 0:
        print(f"[ERROR] key={key}: {result.stderr}", file=sys.stderr)
    else:
        count += 1

print(f"[Config Restore] {count}개 설정 복구 완료")
PYEOF

        log ""
        log "${GREEN}${BOLD}✅ 설정 복구 완료!${NC}"
        log "   서비스 재시작 없이 즉시 적용됩니다."
        log "   변경사항 확인: 관리자 패널 → 메뉴 설정 탭"

    else
        # ── 전체 DB 복구 ─────────────────────────────────────────────────────
        local DUMP_FILE="$TMP_DIR/db.dump"
        [ -f "$DUMP_FILE" ] || die "백업에 db.dump가 없습니다."

        # 현재 상태 자동 백업 (안전장치)
        log "복구 전 현재 상태 자동 백업 중..."
        local SAFETY_NAME
        SAFETY_NAME="proxmox-backup-pre-restore-${TIMESTAMP}.tar.gz"
        SAFETY_DIR="$BACKUP_DIR/tmp-safety-${TIMESTAMP}"
        mkdir -p "$SAFETY_DIR"

        docker compose exec -T postgres \
            pg_dump -U "$DB_USER" -Fc "$DB_NAME" \
            > "$SAFETY_DIR/db.dump"

        echo '{"note":"auto-backup before restore","createdAt":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'"}' \
            > "$SAFETY_DIR/info.json"
        echo "[]" > "$SAFETY_DIR/config.json"

        tar -czf "$BACKUP_DIR/$SAFETY_NAME" -C "$BACKUP_DIR" "tmp-safety-${TIMESTAMP}"
        rm -rf "$SAFETY_DIR"
        log "  ✓ 안전 백업 생성: $SAFETY_NAME"

        # 앱 컨테이너 중지 (DB 사용 최소화)
        log "앱 컨테이너 중지 중..."
        docker compose stop app 2>/dev/null || true

        # pg_restore
        log "DB 복구 중 (pg_restore)..."
        docker compose exec -T postgres \
            pg_restore -U "$DB_USER" -d "$DB_NAME" \
            --clean --if-exists --no-owner \
            < "$DUMP_FILE"

        log "  ✓ DB 복구 완료"

        # 앱 컨테이너 재시작
        log "앱 컨테이너 재시작 중..."
        docker compose start app

        log ""
        log "${GREEN}${BOLD}✅ 전체 DB 복구 완료!${NC}"
        log "   앱이 재시작 중입니다. 약 30~60초 후 접속 가능합니다."
        log "   안전 백업 위치: $BACKUP_DIR/$SAFETY_NAME"
        log ""
        log "   서비스 상태 확인:"
        log "   docker compose ps"
        log "   docker compose logs app --tail=20"
    fi
}

# ─── 명령: delete ─────────────────────────────────────────────────────────────

cmd_delete() {
    local FILENAME="${1:-}"
    [ -z "$FILENAME" ] && die "삭제할 파일명을 지정하세요.\n  사용법: $0 delete <파일명>"

    FILENAME=$(basename "$FILENAME")
    local ARCHIVE_PATH="$BACKUP_DIR/$FILENAME"

    [[ "$FILENAME" == proxmox-backup-*.tar.gz ]] \
        || die "올바른 백업 파일명이 아닙니다: $FILENAME"
    [ -f "$ARCHIVE_PATH" ] || die "파일을 찾을 수 없습니다: $ARCHIVE_PATH"

    read -r -p "정말 삭제하시겠습니까? '$FILENAME' (y/N): " CONFIRM
    [[ "$CONFIRM" =~ ^[yY]$ ]] || { info "취소되었습니다."; exit 0; }

    rm -f "$ARCHIVE_PATH"
    log "✅ 삭제 완료: $FILENAME"
}

# ─── 명령: prune ─────────────────────────────────────────────────────────────

cmd_prune() {
    local DAYS="${1:-7}"
    [[ "$DAYS" =~ ^[0-9]+$ ]] || die "보존 기간은 숫자(일)로 지정하세요."

    ensure_backup_dir

    local count=0
    local cutoff
    # macOS는 -v-${DAYS}d, Linux는 -d "${DAYS} days ago"
    if date -v -1d &>/dev/null 2>&1; then
        cutoff=$(date -v -"${DAYS}"d +%s 2>/dev/null || date -d "${DAYS} days ago" +%s)
    else
        cutoff=$(date -d "${DAYS} days ago" +%s)
    fi

    info "${DAYS}일 초과 백업 정리 중..."

    while IFS= read -r -d '' f; do
        local fname
        fname=$(basename "$f")
        # 파일 수정 시간
        local fmtime
        fmtime=$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f" 2>/dev/null || echo 0)

        if [ "$fmtime" -lt "$cutoff" ]; then
            rm -f "$f"
            log "  삭제: $fname"
            ((count++)) || true
        fi
    done < <(find "$BACKUP_DIR" -maxdepth 1 -name "proxmox-backup-*.tar.gz" -print0 2>/dev/null)

    if [ "$count" -eq 0 ]; then
        info "삭제할 파일이 없습니다 (기준: ${DAYS}일 이상된 파일)."
    else
        log "✅ $count개 파일 삭제 완료"
    fi
}

# ─── 명령: help ──────────────────────────────────────────────────────────────

cmd_help() {
    echo ""
    echo -e "${BOLD}Proxmox Horizon DB 백업/복구 관리 스크립트${NC}"
    echo ""
    echo -e "${BOLD}사용법:${NC}"
    echo "  $0 <명령> [옵션]"
    echo ""
    echo -e "${BOLD}명령:${NC}"
    echo "  create                  백업 생성 (db.dump + config.json)"
    echo "  list                    백업 목록 조회"
    echo "  restore <파일명>        설정 복구 (Config Only — 서비스 재시작 없음)"
    echo "  restore <파일명> full   전체 DB 복구 (서비스 재시작 필요)"
    echo "  delete  <파일명>        백업 파일 삭제"
    echo "  prune   [일수]          보존 기간 초과 백업 삭제 (기본: 7일)"
    echo "  help                    이 도움말 표시"
    echo ""
    echo -e "${BOLD}예시:${NC}"
    echo "  $0 create"
    echo "  $0 list"
    echo "  $0 restore proxmox-backup-20260221_143022.tar.gz"
    echo "  $0 restore proxmox-backup-20260221_143022.tar.gz full"
    echo "  $0 delete  proxmox-backup-20260210_020000.tar.gz"
    echo "  $0 prune 30"
    echo ""
    echo -e "${BOLD}백업 저장 위치:${NC}"
    echo "  $BACKUP_DIR"
    echo ""
    echo -e "${BOLD}복구 유형 비교:${NC}"
    echo "  config (기본)  SystemConfig 설정만 복구. 서비스 재시작 없음. 안전."
    echo "  full           PostgreSQL DB 전체 복구. 앱 컨테이너 재시작 수행."
    echo "                 복구 전 자동으로 현재 상태 백업 생성."
    echo ""
    echo -e "${BOLD}웹 UI와의 관계:${NC}"
    echo "  이 스크립트는 웹 UI(관리자 패널 → 백업 탭)와 동일한 포맷을 사용합니다."
    echo "  ./servers/backups/ 디렉토리를 공유하므로:"
    echo "  - CLI로 생성한 백업 → 웹 UI 목록에서 확인 가능"
    echo "  - 웹 UI에서 생성한 백업 → CLI로 복구 가능"
    echo ""
}

# ─── 메인 ────────────────────────────────────────────────────────────────────

COMMAND="${1:-help}"

case "$COMMAND" in
    create)  cmd_create ;;
    list)    cmd_list ;;
    restore) cmd_restore "${2:-}" "${3:-config}" ;;
    delete)  cmd_delete "${2:-}" ;;
    prune)   cmd_prune "${2:-7}" ;;
    help|--help|-h) cmd_help ;;
    *)
        err "알 수 없는 명령: $COMMAND"
        cmd_help
        exit 1
        ;;
esac
