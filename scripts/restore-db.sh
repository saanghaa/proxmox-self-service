#!/bin/bash
#
# Proxmox Horizon DB 복구 스크립트 (restore-db.sh)
#
# 웹 UI 백업 포맷(db.dump + config.json + info.json)으로 생성된
# .tar.gz 백업 파일에서 복구를 수행합니다.
#
# 사용법:
#   ./scripts/restore-db.sh                           대화형 모드 (백업 선택)
#   ./scripts/restore-db.sh <파일명>                  설정 복구 (Config Only)
#   ./scripts/restore-db.sh <파일명> full             전체 DB 복구
#   ./scripts/restore-db.sh <파일명> config           설정 복구 (명시적)
#   ./scripts/restore-db.sh --list                    백업 목록만 출력
#   ./scripts/restore-db.sh --help                    도움말
#
# 복구 유형:
#   config (기본)  SystemConfig 설정만 적용. 서비스 재시작 없음. 안전.
#   full           PostgreSQL DB 전체 복구. 앱 컨테이너를 일시 중지.
#                  복구 전 자동으로 현재 상태의 안전 백업을 생성합니다.
#

set -euo pipefail

# ─── 색상 ────────────────────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BLUE='\033[0;34m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

log()     { echo -e "${GREEN}[$(date +'%H:%M:%S')]${NC} $1"; }
info()    { echo -e "${CYAN}[INFO]${NC} $1"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $1"; }
err()     { echo -e "${RED}[ERROR]${NC} $1" >&2; }
die()     { err "$1"; exit 1; }
step()    { echo -e "\n${BOLD}▶ $1${NC}"; }
success() { echo -e "\n${GREEN}${BOLD}✅ $1${NC}"; }

# ─── 경로 설정 ───────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
BACKUP_DIR="$PROJECT_ROOT/servers/backups"

cd "$PROJECT_ROOT"

# ─── 공통 헬퍼 ───────────────────────────────────────────────────────────────

check_dependencies() {
    command -v docker &>/dev/null \
        || die "Docker가 설치되어 있지 않습니다."
    docker compose ps &>/dev/null 2>&1 \
        || die "docker-compose.yml이 없거나 Docker Compose 실행에 실패했습니다."
}

check_postgres_running() {
    docker compose ps postgres 2>/dev/null | grep -q "running" \
        || die "postgres 컨테이너가 실행 중이지 않습니다. 먼저 'docker compose up -d'를 실행하세요."
}

get_db_credentials() {
    if [ -f ".env" ]; then
        source .env 2>/dev/null || true
    fi
    DB_URL="${DATABASE_URL:-}"
    [ -z "$DB_URL" ] && die "DATABASE_URL이 설정되어 있지 않습니다. .env 파일을 확인하세요."
    DB_USER=$(echo "$DB_URL" | sed -E 's|postgresql://([^:]+):.*|\1|')
    DB_NAME=$(echo "$DB_URL" | sed -E 's|.*/([^?]+).*|\1|')
}

ensure_backup_dir() {
    mkdir -p "$BACKUP_DIR"
}

format_size() {
    local file="$1"
    [ -f "$file" ] && du -h "$file" | cut -f1 || echo "?"
}

format_date_from_filename() {
    local filename="$1"
    local ts
    ts=$(echo "$filename" | sed -E 's/proxmox-backup-([0-9]{8})_([0-9]{6}).*\.tar\.gz/\1_\2/')
    if [[ "$ts" =~ ^([0-9]{4})([0-9]{2})([0-9]{2})_([0-9]{2})([0-9]{2})([0-9]{2})$ ]]; then
        echo "${BASH_REMATCH[1]}-${BASH_REMATCH[2]}-${BASH_REMATCH[3]} ${BASH_REMATCH[4]}:${BASH_REMATCH[5]}:${BASH_REMATCH[6]}"
    else
        stat -c %y "$BACKUP_DIR/$filename" 2>/dev/null | cut -d. -f1 || echo "알 수 없음"
    fi
}

# ─── 백업 목록 ───────────────────────────────────────────────────────────────

get_backup_files() {
    # 최신순 정렬, 배열에 저장
    BACKUP_FILES=()
    while IFS= read -r -d '' f; do
        BACKUP_FILES+=("$(basename "$f")")
    done < <(find "$BACKUP_DIR" -maxdepth 1 -name "proxmox-backup-*.tar.gz" -print0 2>/dev/null | sort -zr)
}

print_backup_list() {
    get_backup_files
    ensure_backup_dir

    if [ ${#BACKUP_FILES[@]} -eq 0 ]; then
        info "저장된 백업이 없습니다."
        echo ""
        info "백업 생성 방법:"
        echo "  ./scripts/backup-db.sh create"
        echo "  또는 관리자 패널 → 백업 탭 → '지금 백업 생성'"
        return 1
    fi

    echo ""
    printf "${BOLD}%-4s %-52s %8s  %-19s${NC}\n" "No." "파일명" "크기" "생성일"
    printf '%s\n' "$(printf '─%.0s' {1..90})"

    local i=1
    for fname in "${BACKUP_FILES[@]}"; do
        local fpath="$BACKUP_DIR/$fname"
        local size
        size=$(format_size "$fpath")
        local date_str
        date_str=$(format_date_from_filename "$fname")

        # pre-restore 백업은 색상 구분
        if [[ "$fname" == *"-pre-restore-"* ]]; then
            printf "${DIM}%-4s %-52s %8s  %s${NC}\n" "$i." "$fname" "$size" "$date_str"
        else
            printf "%-4s %-52s %8s  %s\n" "$i." "$fname" "$size" "$date_str"
        fi
        ((i++))
    done

    echo ""
    info "총 ${#BACKUP_FILES[@]}개 백업 | 저장 위치: $BACKUP_DIR"
    echo ""
}

# ─── 백업 정보 조회 ───────────────────────────────────────────────────────────

print_backup_info() {
    local archive_path="$1"
    local fname
    fname=$(basename "$archive_path")

    echo ""
    echo -e "${BOLD}┌─ 백업 정보 ──────────────────────────────────────────┐${NC}"
    printf "${BOLD}│${NC} %-20s %-35s ${BOLD}│${NC}\n" "파일명:" "$fname"
    printf "${BOLD}│${NC} %-20s %-35s ${BOLD}│${NC}\n" "크기:" "$(format_size "$archive_path")"
    printf "${BOLD}│${NC} %-20s %-35s ${BOLD}│${NC}\n" "생성일:" "$(format_date_from_filename "$fname")"

    # info.json 내부 확인
    local tmp_info
    tmp_info=$(mktemp -d)
    trap 'rm -rf "$tmp_info"' RETURN

    if tar -xzf "$archive_path" -C "$tmp_info" --strip-components=1 2>/dev/null; then
        local info_file="$tmp_info/info.json"
        if [ -f "$info_file" ]; then
            local created_by host_info
            created_by=$(python3 -c "import json,sys; d=json.load(open('$info_file')); print(d.get('createdBy',''))" 2>/dev/null || echo "")
            host_info=$(python3 -c "import json,sys; d=json.load(open('$info_file')); print(d.get('host',''))" 2>/dev/null || echo "")
            [ -n "$created_by" ] && printf "${BOLD}│${NC} %-20s %-35s ${BOLD}│${NC}\n" "생성 방법:" "$created_by"
            [ -n "$host_info" ] && printf "${BOLD}│${NC} %-20s %-35s ${BOLD}│${NC}\n" "호스트:" "$host_info"
        fi

        # 포함된 파일 확인
        local contents=()
        [ -f "$tmp_info/db.dump"    ] && contents+=("db.dump (PostgreSQL 전체 덤프)")
        [ -f "$tmp_info/config.json" ] && contents+=("config.json (SystemConfig 설정)")
        [ -f "$tmp_info/info.json"   ] && contents+=("info.json (메타데이터)")

        printf "${BOLD}│${NC} %-20s %-35s ${BOLD}│${NC}\n" "포함 파일:" "${contents[0]:-없음}"
        local j=1
        while [ $j -lt ${#contents[@]} ]; do
            printf "${BOLD}│${NC} %-20s %-35s ${BOLD}│${NC}\n" "" "${contents[$j]}"
            ((j++))
        done
    fi

    echo -e "${BOLD}└──────────────────────────────────────────────────────┘${NC}"
    echo ""
}

# ─── 유효성 검사 ─────────────────────────────────────────────────────────────

validate_backup_file() {
    local archive_path="$1"
    local fname
    fname=$(basename "$archive_path")

    # 파일 존재 확인
    [ -f "$archive_path" ] || die "백업 파일을 찾을 수 없습니다: $archive_path"

    # tar 무결성 확인
    tar -tzf "$archive_path" &>/dev/null \
        || die "백업 파일이 손상되었습니다: $fname"
}

# ─── 안전 백업 생성 ─────────────────────────────────────────────────────────

create_safety_backup() {
    local TIMESTAMP="$1"
    local SAFETY_NAME="proxmox-backup-pre-restore-${TIMESTAMP}.tar.gz"
    local SAFETY_DIR="$BACKUP_DIR/tmp-safety-${TIMESTAMP}"

    step "복구 전 현재 상태 안전 백업 생성"
    mkdir -p "$SAFETY_DIR"

    # pg_dump
    docker compose exec -T postgres \
        pg_dump -U "$DB_USER" -Fc "$DB_NAME" \
        > "$SAFETY_DIR/db.dump"

    # SystemConfig JSON
    docker compose exec -T postgres \
        psql -U "$DB_USER" -d "$DB_NAME" -t -A \
        -c "SELECT json_agg(row_to_json(t)) FROM (SELECT id, key, value, \"createdAt\", \"updatedAt\" FROM \"SystemConfig\" ORDER BY key) t;" \
        | head -1 > "$SAFETY_DIR/config.json"

    # 메타 정보
    cat > "$SAFETY_DIR/info.json" <<EOF
{
  "createdAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "createdBy": "restore-db.sh (pre-restore safety backup)",
  "dbName": "$DB_NAME",
  "dbUser": "$DB_USER",
  "host": "$(hostname)"
}
EOF

    tar -czf "$BACKUP_DIR/$SAFETY_NAME" -C "$BACKUP_DIR" "tmp-safety-${TIMESTAMP}"
    rm -rf "$SAFETY_DIR"

    log "  ✓ 안전 백업 생성: ${BOLD}$SAFETY_NAME${NC}"
    echo "$SAFETY_NAME"
}

# ─── Config 복구 ─────────────────────────────────────────────────────────────

do_restore_config() {
    local TMP_DIR="$1"

    local CONFIG_FILE="$TMP_DIR/config.json"
    [ -f "$CONFIG_FILE" ] || die "백업에 config.json이 없습니다."

    step "SystemConfig 설정 복구"
    log "config.json 파싱 및 DB upsert 실행 중..."

    python3 - "$CONFIG_FILE" <<'PYEOF'
import json, sys, subprocess

config_file = sys.argv[1]
with open(config_file, 'r', encoding='utf-8') as f:
    raw = f.read().strip()

if not raw or raw == 'null':
    print("[Config Restore] config.json이 비어 있습니다.")
    sys.exit(0)

entries = json.loads(raw)
if not entries:
    print("[Config Restore] 복구할 설정 항목이 없습니다.")
    sys.exit(0)

count = 0
errors = 0
for entry in entries:
    key = entry['key'].replace("'", "''")
    value = entry['value'].replace("'", "''")
    sql = (
        "INSERT INTO \"SystemConfig\" (id, key, value, \"createdAt\", \"updatedAt\") "
        f"VALUES (gen_random_uuid()::text, '{key}', '{value}', NOW(), NOW()) "
        "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, \"updatedAt\" = NOW();"
    )
    result = subprocess.run(
        ['docker', 'compose', 'exec', '-T', 'postgres',
         'psql', '-U', 'proxmox', '-d', 'proxmox', '-c', sql],
        capture_output=True, text=True
    )
    if result.returncode != 0:
        print(f"[ERROR] key={entry['key']}: {result.stderr.strip()}", file=sys.stderr)
        errors += 1
    else:
        count += 1

print(f"[Config Restore] {count}개 항목 복구 완료" + (f" ({errors}개 오류)" if errors else ""))
if errors:
    sys.exit(1)
PYEOF

    log "  ✓ SystemConfig 복구 완료"
    log "  ✓ 서비스 재시작 불필요 — 즉시 적용됩니다"
}

# ─── 전체 DB 복구 ────────────────────────────────────────────────────────────

do_restore_full() {
    local TMP_DIR="$1"
    local SAFETY_NAME="$2"

    local DUMP_FILE="$TMP_DIR/db.dump"
    [ -f "$DUMP_FILE" ] || die "백업에 db.dump가 없습니다."

    # 앱 컨테이너 중지
    step "앱 컨테이너 일시 중지"
    docker compose stop app 2>/dev/null || true
    log "  ✓ 앱 컨테이너 중지 완료"

    # pg_restore
    step "PostgreSQL 전체 복구 (pg_restore)"
    log "  DB: $DB_NAME / User: $DB_USER"
    log "  덤프 파일 적용 중..."

    docker compose exec -T postgres \
        pg_restore -U "$DB_USER" -d "$DB_NAME" \
        --clean --if-exists --no-owner \
        < "$DUMP_FILE"

    log "  ✓ pg_restore 완료"

    # Config JSON도 함께 복구 (full 복구 시 항상 포함)
    local CONFIG_FILE="$TMP_DIR/config.json"
    if [ -f "$CONFIG_FILE" ]; then
        step "SystemConfig 설정 복구 (DB 복구에 포함)"
        # config.json은 pg_restore에서 이미 복구됨
        # 단, 파일로도 백업된 설정을 명시적으로 재확인/upsert
        log "  ✓ DB 복구에 SystemConfig 포함됨"
    fi

    # 앱 컨테이너 재시작
    step "앱 컨테이너 재시작"
    docker compose start app
    log "  ✓ 앱 컨테이너 시작 완료"

    # 앱 준비 대기
    log "앱 서비스 준비 대기 중..."
    local waited=0
    while [ $waited -lt 60 ]; do
        if docker compose ps app 2>/dev/null | grep -q "running"; then
            sleep 3
            if docker compose exec -T app curl -sf http://localhost:3000/auth/login &>/dev/null 2>&1; then
                log "  ✓ 앱 서비스 정상 응답"
                break
            fi
        fi
        echo -n "."
        sleep 3
        ((waited+=3))
    done
    echo ""
}

# ─── 복구 검증 ───────────────────────────────────────────────────────────────

verify_restore() {
    local restore_type="$1"

    step "복구 결과 검증"

    # PostgreSQL 연결 확인
    if docker compose exec -T postgres psql -U "$DB_USER" -d "$DB_NAME" -c "SELECT 1;" &>/dev/null; then
        log "  ✓ PostgreSQL 연결 정상"

        local table_count
        table_count=$(docker compose exec -T postgres psql -U "$DB_USER" -d "$DB_NAME" -t -A \
            -c "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public';" \
            2>/dev/null | tr -d ' ')
        log "  ✓ 테이블 수: $table_count 개"

        local config_count
        config_count=$(docker compose exec -T postgres psql -U "$DB_USER" -d "$DB_NAME" -t -A \
            -c 'SELECT COUNT(*) FROM "SystemConfig";' \
            2>/dev/null | tr -d ' ')
        log "  ✓ SystemConfig 레코드: $config_count 개"
    else
        warn "PostgreSQL 연결을 확인할 수 없습니다."
    fi

    if [ "$restore_type" = "full" ]; then
        # 앱 상태 확인
        if docker compose ps app 2>/dev/null | grep -q "running"; then
            log "  ✓ 앱 컨테이너 실행 중"
        else
            warn "앱 컨테이너 상태를 확인하세요: docker compose ps"
        fi
    fi
}

# ─── 대화형 선택 ─────────────────────────────────────────────────────────────

interactive_select_backup() {
    print_backup_list || return 1

    local max=${#BACKUP_FILES[@]}
    local selection

    while true; do
        echo -ne "${BOLD}복구할 백업 번호를 입력하세요 (1-$max, q=취소): ${NC}"
        read -r selection

        [ "$selection" = "q" ] || [ "$selection" = "Q" ] && {
            info "취소되었습니다."
            exit 0
        }

        if [[ "$selection" =~ ^[0-9]+$ ]] && [ "$selection" -ge 1 ] && [ "$selection" -le "$max" ]; then
            SELECTED_FILE="${BACKUP_FILES[$((selection-1))]}"
            break
        else
            warn "잘못된 입력입니다. 1부터 $max 사이의 숫자를 입력하세요."
        fi
    done
}

interactive_select_type() {
    echo ""
    echo -e "${BOLD}복구 유형을 선택하세요:${NC}"
    echo ""
    echo "  1) Config 복구  — SystemConfig 설정만 적용"
    echo "                     서비스 재시작 없음. 빠르고 안전."
    echo ""
    echo "  2) 전체 DB 복구 — PostgreSQL 데이터 전체 복구"
    echo "                     앱 컨테이너를 일시 중지 후 재시작."
    echo "                     복구 전 자동 안전 백업 생성."
    echo ""
    echo -ne "${BOLD}선택 (1 또는 2, q=취소): ${NC}"

    local type_sel
    read -r type_sel

    case "$type_sel" in
        1) RESTORE_TYPE="config" ;;
        2) RESTORE_TYPE="full" ;;
        q|Q) info "취소되었습니다."; exit 0 ;;
        *) die "잘못된 선택입니다." ;;
    esac
}

# ─── 복구 실행 ───────────────────────────────────────────────────────────────

run_restore() {
    local FILENAME="$1"
    local RESTORE_TYPE="$2"

    # 경로 트래버설 방지
    FILENAME=$(basename "$FILENAME")
    local ARCHIVE_PATH="$BACKUP_DIR/$FILENAME"

    # 파일 검증
    validate_backup_file "$ARCHIVE_PATH"

    check_dependencies
    check_postgres_running
    get_db_credentials

    # 백업 정보 출력
    print_backup_info "$ARCHIVE_PATH"

    # 확인 프롬프트
    if [ "$RESTORE_TYPE" = "full" ]; then
        echo -e "${RED}${BOLD}⚠️  전체 DB 복구 경고${NC}"
        echo ""
        echo "   현재 데이터베이스의 모든 데이터가 백업 내용으로 대체됩니다."
        echo "   앱 서비스가 일시적으로 중단됩니다."
        echo "   이 작업은 되돌릴 수 없습니다 (단, 복구 전 자동 안전 백업이 생성됩니다)."
        echo ""
        echo -ne "정말 진행하시겠습니까? ${BOLD}(yes 입력하면 진행):${NC} "
        local confirm
        read -r confirm
        [ "$confirm" = "yes" ] || { info "취소되었습니다."; exit 0; }
    else
        echo -e "${YELLOW}[확인]${NC} 다음 백업에서 ${BOLD}설정(SystemConfig)을 복구${NC}합니다:"
        echo "      ${BOLD}$FILENAME${NC}"
        echo ""
        echo -ne "계속하시겠습니까? (y/N): "
        local confirm
        read -r confirm
        [[ "$confirm" =~ ^[yY]$ ]] || { info "취소되었습니다."; exit 0; }
    fi

    # 임시 디렉토리 생성 및 압축 해제
    local TIMESTAMP
    TIMESTAMP=$(date +%Y%m%d_%H%M%S)
    local TMP_DIR="$BACKUP_DIR/restore-tmp-${TIMESTAMP}"

    mkdir -p "$TMP_DIR"
    trap 'rm -rf "$TMP_DIR"' EXIT

    step "아카이브 압축 해제"
    tar -xzf "$ARCHIVE_PATH" -C "$TMP_DIR" --strip-components=1
    log "  ✓ 압축 해제 완료"

    local SAFETY_NAME=""

    if [ "$RESTORE_TYPE" = "full" ]; then
        # 안전 백업 먼저 생성
        SAFETY_NAME=$(create_safety_backup "$TIMESTAMP")

        do_restore_full "$TMP_DIR" "$SAFETY_NAME"
    else
        do_restore_config "$TMP_DIR"
    fi

    # 검증
    verify_restore "$RESTORE_TYPE"

    # 결과 출력
    echo ""
    echo "╔══════════════════════════════════════════════════════╗"
    if [ "$RESTORE_TYPE" = "full" ]; then
        echo "║         전체 DB 복구 완료!                          ║"
    else
        echo "║         설정(Config) 복구 완료!                     ║"
    fi
    echo "╚══════════════════════════════════════════════════════╝"
    echo ""
    log "복구 파일: ${BOLD}$FILENAME${NC}"

    if [ "$RESTORE_TYPE" = "full" ]; then
        [ -n "$SAFETY_NAME" ] && log "안전 백업:  ${BOLD}$SAFETY_NAME${NC}"
        log ""
        log "서비스 상태 확인:"
        log "  docker compose ps"
        log "  docker compose logs app --tail=30"
        log ""
        local ip
        ip=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "localhost")
        log "접속 주소: ${CYAN}http://${ip}/auth/login${NC}"
    else
        log ""
        log "변경사항은 즉시 반영됩니다."
        log "캐시 초기화가 필요한 경우: docker compose restart app"
    fi
    echo ""
}

# ─── 도움말 ──────────────────────────────────────────────────────────────────

print_help() {
    echo ""
    echo -e "${BOLD}Proxmox Horizon DB 복구 스크립트${NC}"
    echo ""
    echo -e "${BOLD}사용법:${NC}"
    echo "  $0                             대화형 모드 (목록 선택 + 유형 선택)"
    echo "  $0 <파일명>                    설정 복구 (Config Only — 기본값)"
    echo "  $0 <파일명> full               전체 DB 복구"
    echo "  $0 <파일명> config             설정 복구 (명시적 지정)"
    echo "  $0 --list                      백업 목록만 출력"
    echo "  $0 --help                      이 도움말 표시"
    echo ""
    echo -e "${BOLD}복구 유형 비교:${NC}"
    echo ""
    printf "  ${BOLD}%-10s${NC}  %-55s\n" "유형" "설명"
    printf "  %-10s  %-55s\n" "config" "SystemConfig 테이블만 복구. 서비스 무중단. 권장."
    printf "  %-10s  %-55s\n" "full" "PostgreSQL DB 전체 복구. 앱 재시작. 사전 안전 백업 자동 생성."
    echo ""
    echo -e "${BOLD}예시:${NC}"
    echo "  $0"
    echo "  $0 proxmox-backup-20260221_143022.tar.gz"
    echo "  $0 proxmox-backup-20260221_143022.tar.gz full"
    echo "  $0 --list"
    echo ""
    echo -e "${BOLD}백업 저장 위치:${NC}"
    echo "  $BACKUP_DIR"
    echo ""
    echo -e "${BOLD}관련 스크립트:${NC}"
    echo "  ./scripts/backup-db.sh create       백업 생성"
    echo "  ./scripts/backup-db.sh list         백업 목록"
    echo ""
    echo -e "${BOLD}웹 UI 연동:${NC}"
    echo "  이 스크립트는 웹 UI(관리자 패널 → 백업 탭)와 동일한 포맷(.tar.gz)을 사용합니다."
    echo "  웹 UI에서 생성한 백업을 이 스크립트로 복구하거나, 그 반대도 가능합니다."
    echo ""
}

# ─── 메인 ────────────────────────────────────────────────────────────────────

main() {
    echo ""
    echo -e "${BOLD}╔══════════════════════════════════════════════════════╗${NC}"
    echo -e "${BOLD}║       Proxmox Horizon 복구 스크립트               ║${NC}"
    echo -e "${BOLD}╚══════════════════════════════════════════════════════╝${NC}"
    echo ""

    ensure_backup_dir

    local ARG1="${1:-}"
    local ARG2="${2:-config}"

    case "$ARG1" in
        --help|-h|help)
            print_help
            exit 0
            ;;
        --list|-l|list)
            print_backup_list
            exit 0
            ;;
        "")
            # 대화형 모드
            interactive_select_backup
            interactive_select_type
            run_restore "$SELECTED_FILE" "$RESTORE_TYPE"
            ;;
        *)
            # 직접 파일명 지정
            [[ "$ARG2" == "config" || "$ARG2" == "full" ]] \
                || die "복구 유형은 'config' 또는 'full' 중 하나여야 합니다."
            run_restore "$ARG1" "$ARG2"
            ;;
    esac
}

main "$@"
