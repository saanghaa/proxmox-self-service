#!/bin/bash
#
# Nginx 로그 로테이션 스크립트
#
# 기능:
# - 날짜별로 로그 파일 이름 변경
# - 오래된 로그 압축
# - 지정된 기간 이상 로그 자동 삭제
# - Nginx 로그 재오픈
#
# 사용법: ./scripts/rotate-nginx-logs.sh
# 크론 설정: 0 0 * * * /path/to/proxmox/scripts/rotate-nginx-logs.sh
#

set -e

# 색상 정의
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# 스크립트 위치 기준으로 프로젝트 루트 찾기
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_ROOT"

# 설정
LOG_DIR="$PROJECT_ROOT/servers/nginx/logs"
RETENTION_DAYS=90         # 로그 보관 기간
COMPRESS_DAYS=1           # 며칠 지난 로그를 압축할지
YESTERDAY=$(date -d "yesterday" +%Y%m%d)
TODAY=$(date +%Y%m%d)

# 함수: 로그 출력
log() {
    echo -e "${GREEN}[$(date +'%Y-%m-%d %H:%M:%S')]${NC} $1"
}

warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

# 함수: Docker 컨테이너 확인
check_nginx_container() {
    if ! docker compose ps --services --filter "status=running" | grep -q "^nginx$"; then
        warn "Nginx 서비스가 실행 중이지 않습니다."
        return 1
    fi
    return 0
}

# 함수: 로그 파일 이동 및 이름 변경
rotate_logs() {
    log "로그 파일 로테이션 시작..."

    cd "$LOG_DIR"

    # access.log 로테이션
    if [ -f "access.log" ] && [ -s "access.log" ]; then
        log "access.log → access-$YESTERDAY.log"
        mv access.log "access-$YESTERDAY.log"
    fi

    # error.log 로테이션
    if [ -f "error.log" ] && [ -s "error.log" ]; then
        log "error.log → error-$YESTERDAY.log"
        mv error.log "error-$YESTERDAY.log"
    fi

    # 기타 로그 파일 로테이션 (있는 경우)
    for logfile in *.log; do
        if [ -f "$logfile" ] && [ "$logfile" != "access.log" ] && [ "$logfile" != "error.log" ]; then
            if [[ ! "$logfile" =~ -[0-9]{8}\.log$ ]]; then
                BASENAME="${logfile%.log}"
                log "$logfile → ${BASENAME}-$YESTERDAY.log"
                mv "$logfile" "${BASENAME}-$YESTERDAY.log"
            fi
        fi
    done

    log "✓ 로그 로테이션 완료"
}

# 함수: Nginx에게 로그 재오픈 신호 전송
reopen_nginx_logs() {
    log "Nginx 로그 재오픈 중..."

    if check_nginx_container; then
        # USR1 신호로 Nginx에게 로그 파일 재오픈 요청 (더 효율적)
        docker compose kill -s USR1 nginx >/dev/null 2>&1
        log "✓ Nginx 로그 재오픈 완료"
    else
        warn "Nginx 컨테이너를 찾을 수 없어 로그 재오픈을 건너뜁니다."
    fi
}

# 함수: 오래된 로그 압축
compress_old_logs() {
    log "오래된 로그 압축 중 (${COMPRESS_DAYS}일 이상)..."

    cd "$LOG_DIR"
    COMPRESS_COUNT=0

    # N일 이상 지난 압축되지 않은 로그 파일 찾기
    while IFS= read -r -d '' logfile; do
        if [[ "$logfile" =~ -[0-9]{8}\.log$ ]] && [ ! -f "$logfile.gz" ]; then
            log "압축 중: $logfile"
            gzip "$logfile"
            ((COMPRESS_COUNT++))
        fi
    done < <(find . -name "*-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9].log" -mtime +$COMPRESS_DAYS -print0 2>/dev/null)

    if [ $COMPRESS_COUNT -gt 0 ]; then
        log "✓ $COMPRESS_COUNT 개 로그 파일 압축 완료"
    else
        log "압축할 로그 파일 없음"
    fi
}

# 함수: 오래된 로그 삭제
cleanup_old_logs() {
    log "오래된 로그 삭제 중 (${RETENTION_DAYS}일 이상)..."

    cd "$LOG_DIR"
    DELETED_COUNT=0

    # N일 이상 지난 로그 파일 삭제 (.gz 포함)
    while IFS= read -r -d '' logfile; do
        log "삭제: $logfile"
        rm -f "$logfile"
        ((DELETED_COUNT++))
    done < <(find . -name "*-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9].log*" -mtime +$RETENTION_DAYS -print0 2>/dev/null)

    if [ $DELETED_COUNT -gt 0 ]; then
        log "✓ $DELETED_COUNT 개 로그 파일 삭제 완료"
    else
        log "삭제할 로그 파일 없음"
    fi
}

# 함수: 로그 통계 출력
print_log_stats() {
    log "로그 파일 현황:"

    cd "$LOG_DIR"

    # 현재 로그 파일
    CURRENT_LOGS=$(ls -1 *.log 2>/dev/null | wc -l)
    log "  현재 로그: $CURRENT_LOGS 개"

    # 날짜별 로그 파일
    DATED_LOGS=$(ls -1 *-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9].log 2>/dev/null | wc -l)
    log "  날짜별 로그: $DATED_LOGS 개"

    # 압축된 로그 파일
    COMPRESSED_LOGS=$(ls -1 *.log.gz 2>/dev/null | wc -l)
    log "  압축된 로그: $COMPRESSED_LOGS 개"

    # 총 용량
    TOTAL_SIZE=$(du -sh . 2>/dev/null | cut -f1)
    log "  총 용량: $TOTAL_SIZE"

    # 최신 로그 파일 목록 (최근 5개)
    echo ""
    log "최근 로그 파일 (최근 5개):"
    ls -lht *.log* 2>/dev/null | head -6 | tail -5 | awk '{printf "  %s %s %s\n", $6, $7, $9}'
}

# 메인 실행
main() {
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  Nginx 로그 로테이션"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""

    # 로그 디렉토리 확인
    if [ ! -d "$LOG_DIR" ]; then
        warn "로그 디렉토리가 없습니다: $LOG_DIR"
        exit 1
    fi

    # 1. 로그 파일 로테이션
    rotate_logs

    # 2. Nginx 로그 재오픈
    reopen_nginx_logs

    # 3. 오래된 로그 압축
    compress_old_logs

    # 4. 오래된 로그 삭제
    cleanup_old_logs

    # 5. 통계 출력
    print_log_stats

    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  로테이션 완료!"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
}

# 스크립트 실행
main "$@"
