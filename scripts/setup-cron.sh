#!/bin/bash
#
# 크론 자동 설정 스크립트
#
# 기능:
# - 백업 스크립트 크론 등록
# - 로그 로테이션 크론 등록
# - 기존 크론 보존
#
# 사용법: ./scripts/setup-cron.sh
#

set -e

# 색상 정의
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

# 스크립트 위치 기준으로 프로젝트 루트 찾기
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_ROOT"

# 함수: 로그 출력
log() {
    echo -e "${GREEN}[✓]${NC} $1"
}

warn() {
    echo -e "${YELLOW}[!]${NC} $1"
}

error() {
    echo -e "${RED}[✗]${NC} $1"
}

# 함수: 크론 확인
check_cron() {
    if ! command -v crontab &> /dev/null; then
        error "cron이 설치되어 있지 않습니다."
        echo "설치: sudo apt-get install cron"
        exit 1
    fi
}

# 함수: 중복 확인
is_cron_exists() {
    local pattern="$1"
    crontab -l 2>/dev/null | grep -F "$pattern" &>/dev/null
    return $?
}

# 함수: 크론 추가
add_cron_job() {
    local cron_line="$1"
    local description="$2"

    # 기존 크론탭 가져오기 (없으면 빈 문자열)
    local current_cron=$(crontab -l 2>/dev/null || echo "")

    # 중복 확인
    if echo "$current_cron" | grep -F "$cron_line" &>/dev/null; then
        warn "$description 이미 등록되어 있습니다."
        return 0
    fi

    # 크론 추가
    (echo "$current_cron"; echo "$cron_line") | crontab -
    log "$description 등록 완료"
}

# 함수: 크론탭 설정
setup_crontab() {
    log "크론 자동화 설정 시작..."

    # 백업 스크립트 크론
    local backup_cron="0 3 * * * $PROJECT_ROOT/scripts/backup.sh >> $PROJECT_ROOT/servers/backups/backup.log 2>&1"
    add_cron_job "$backup_cron" "매일 새벽 3시 전체 백업"

    # 로그 로테이션 크론
    local rotate_cron="0 0 * * * $PROJECT_ROOT/scripts/rotate-nginx-logs.sh >> $PROJECT_ROOT/servers/nginx/logs/rotation.log 2>&1"
    add_cron_job "$rotate_cron" "매일 자정 Nginx 로그 로테이션"

    log "✓ 크론 설정 완료!"
}

# 함수: 크론 확인
verify_cron() {
    echo ""
    log "등록된 크론 작업 목록:"
    echo ""
    crontab -l 2>/dev/null | grep -E "(backup.sh|rotate-nginx-logs.sh)" || echo "  (등록된 작업 없음)"
    echo ""
}

# 함수: 크론 테스트
test_cron() {
    log "크론 스크립트 실행 권한 확인..."

    # 백업 스크립트 권한
    if [ -x "$PROJECT_ROOT/scripts/backup.sh" ]; then
        log "backup.sh 실행 권한 OK"
    else
        warn "backup.sh 실행 권한 없음. 권한 부여 중..."
        chmod +x "$PROJECT_ROOT/scripts/backup.sh"
    fi

    # 로그 로테이션 스크립트 권한
    if [ -x "$PROJECT_ROOT/scripts/rotate-nginx-logs.sh" ]; then
        log "rotate-nginx-logs.sh 실행 권한 OK"
    else
        warn "rotate-nginx-logs.sh 실행 권한 없음. 권한 부여 중..."
        chmod +x "$PROJECT_ROOT/scripts/rotate-nginx-logs.sh"
    fi
}

# 함수: 크론 삭제 (옵션)
remove_cron() {
    warn "기존 proxmox 관련 크론 작업을 삭제하시겠습니까? (y/N)"
    read -r response
    if [[ "$response" =~ ^[Yy]$ ]]; then
        crontab -l 2>/dev/null | grep -v "backup.sh" | grep -v "rotate-nginx-logs.sh" | crontab -
        log "크론 작업 삭제 완료"
    fi
}

# 함수: 사용자 안내
print_info() {
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  크론 자동화 설정 완료!"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    log "다음 작업이 자동으로 실행됩니다:"
    echo ""
    echo "  📦 매일 새벽 3시: 전체 백업 (backup.sh)"
    echo "      → 로그: $PROJECT_ROOT/servers/backups/backup.log"
    echo ""
    echo "  📋 매일 자정: Nginx 로그 로테이션 (rotate-nginx-logs.sh)"
    echo "      → 로그: $PROJECT_ROOT/servers/nginx/logs/rotation.log"
    echo ""
    log "수동 실행 방법:"
    echo ""
    echo "  # 백업 즉시 실행"
    echo "  $PROJECT_ROOT/scripts/backup.sh"
    echo ""
    echo "  # 로그 로테이션 즉시 실행"
    echo "  $PROJECT_ROOT/scripts/rotate-nginx-logs.sh"
    echo ""
    log "크론 확인: crontab -l"
    log "크론 편집: crontab -e"
    echo ""
}

# 메인 함수
main() {
    echo ""
    echo "╔════════════════════════════════════════════════════╗"
    echo "║   Proxmox Horizon 크론 자동화 설정               ║"
    echo "╚════════════════════════════════════════════════════╝"
    echo ""

    # 옵션 확인
    if [ "$1" == "--remove" ] || [ "$1" == "-r" ]; then
        remove_cron
        exit 0
    fi

    # 1. cron 설치 확인
    check_cron

    # 2. 스크립트 실행 권한 확인
    test_cron

    # 3. 크론 설정
    setup_crontab

    # 4. 크론 확인
    verify_cron

    # 5. 사용자 안내
    print_info
}

# 스크립트 실행
main "$@"
