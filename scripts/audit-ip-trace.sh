#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE_MAIN="$PROJECT_DIR/docker-compose.yml"
COMPOSE_FRESH="$PROJECT_DIR/docker-compose.fresh-reset.yml"

LIMIT=20
TAIL_LINES=3000
SHOW_NGINX_LINES=3
USER_FILTER=""
ACTION_FILTER=""
RESULT_FILTER=""
FROM_FILTER=""
TO_FILTER=""

usage() {
  cat <<USAGE
Usage: $(basename "$0") [options]

Audit 로그와 Nginx access 로그를 시간/UA 기준으로 교차 확인합니다.

Options:
  --limit N            가져올 감사로그 개수 (default: 20)
  --tail N             Nginx access.log tail 라인 수 (default: 3000)
  --show-nginx N       로그별 표시할 Nginx 후보 라인 수 (default: 3)
  --user EMAIL         감사로그 사용자 이메일 필터
  --action TEXT        감사로그 동작 필터 (contains, case-insensitive)
  --result VALUE       SUCCESS | FAILURE (FAIL) | 전체(빈값)
  --from ISO_DATETIME  시작 시각 (예: 2026-02-13T00:00:00Z)
  --to ISO_DATETIME    종료 시각 (예: 2026-02-13T23:59:59Z)
  -h, --help           도움말

Examples:
  $(basename "$0") --limit 10 --action delete --result FAILURE
  $(basename "$0") --from 2026-02-13T00:00:00Z --to 2026-02-13T23:59:59Z --user proxmox@proxmox.io
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --limit) LIMIT="${2:-}"; shift 2 ;;
    --tail) TAIL_LINES="${2:-}"; shift 2 ;;
    --show-nginx) SHOW_NGINX_LINES="${2:-}"; shift 2 ;;
    --user) USER_FILTER="${2:-}"; shift 2 ;;
    --action) ACTION_FILTER="${2:-}"; shift 2 ;;
    --result) RESULT_FILTER="${2:-}"; shift 2 ;;
    --from) FROM_FILTER="${2:-}"; shift 2 ;;
    --to) TO_FILTER="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1"; usage; exit 1 ;;
  esac
done

if ! [[ "$LIMIT" =~ ^[0-9]+$ ]] || [[ "$LIMIT" -lt 1 ]]; then
  echo "[ERROR] --limit must be a positive integer"
  exit 1
fi
if ! [[ "$TAIL_LINES" =~ ^[0-9]+$ ]] || [[ "$TAIL_LINES" -lt 100 ]]; then
  echo "[ERROR] --tail must be integer >= 100"
  exit 1
fi
if ! [[ "$SHOW_NGINX_LINES" =~ ^[0-9]+$ ]] || [[ "$SHOW_NGINX_LINES" -lt 1 ]]; then
  echo "[ERROR] --show-nginx must be a positive integer"
  exit 1
fi

compose_cmd=(docker compose -f "$COMPOSE_MAIN" -f "$COMPOSE_FRESH")

if [[ ! -f "$COMPOSE_MAIN" ]]; then
  echo "[ERROR] Compose file not found: $COMPOSE_MAIN"
  exit 1
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
AUDIT_TSV="$TMP_DIR/audit.tsv"
NGINX_LOG="$TMP_DIR/access.log"

printf '[INFO] Fetching latest %s audit rows...\n' "$LIMIT"

"${compose_cmd[@]}" exec -T \
  -e LIMIT="$LIMIT" \
  -e USER_FILTER="$USER_FILTER" \
  -e ACTION_FILTER="$ACTION_FILTER" \
  -e RESULT_FILTER="$RESULT_FILTER" \
  -e FROM_FILTER="$FROM_FILTER" \
  -e TO_FILTER="$TO_FILTER" \
  app node -e '
const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();
(async () => {
  try {
    const limit = parseInt(process.env.LIMIT || "20", 10);
    const user = (process.env.USER_FILTER || "").trim();
    const action = (process.env.ACTION_FILTER || "").trim();
    const result = (process.env.RESULT_FILTER || "").trim();
    const from = (process.env.FROM_FILTER || "").trim();
    const to = (process.env.TO_FILTER || "").trim();

    const where = {};
    if (from || to) {
      where.createdAt = {};
      if (from) {
        const d = new Date(from);
        if (!isNaN(d.getTime())) where.createdAt.gte = d;
      }
      if (to) {
        const d = new Date(to);
        if (!isNaN(d.getTime())) where.createdAt.lte = d;
      }
      if (Object.keys(where.createdAt).length === 0) delete where.createdAt;
    }
    if (user) where.user = { email: { contains: user, mode: "insensitive" } };
    if (action) where.action = { contains: action, mode: "insensitive" };
    if (result === "SUCCESS") where.result = "SUCCESS";
    if (result === "FAILURE" || result === "FAIL") where.result = { not: "SUCCESS" };

    const rows = await p.auditLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
      include: { user: { select: { email: true } } },
    });

    for (const r of rows) {
      const line = [
        r.id,
        r.createdAt?.toISOString?.() || "",
        r.user?.email || "-",
        r.action || "-",
        r.result || "-",
        r.requestIp || "-",
        Buffer.from(r.userAgent || "", "utf8").toString("base64"),
        Buffer.from(r.reason || "", "utf8").toString("base64"),
      ].join("\t");
      console.log(line);
    }
  } catch (e) {
    console.error("ERR", e?.message || e);
    process.exit(1);
  } finally {
    await p.$disconnect();
  }
})();
' > "$AUDIT_TSV"

AUDIT_COUNT=$(wc -l < "$AUDIT_TSV" | tr -d ' ')
if [[ "$AUDIT_COUNT" == "0" ]]; then
  echo "[INFO] No audit logs matched filters"
  exit 0
fi

echo "[INFO] Matched audit rows: $AUDIT_COUNT"

echo "[INFO] Fetching nginx access.log tail ($TAIL_LINES lines)..."
"${compose_cmd[@]}" exec -T nginx sh -lc "tail -n $TAIL_LINES /var/log/nginx/access.log" > "$NGINX_LOG" || true

if [[ ! -s "$NGINX_LOG" ]]; then
  echo "[WARN] nginx access.log is empty or unavailable"
fi

echo ""
echo "================ AUDIT ↔ NGINX TRACE ================"

i=0
while IFS=$'\t' read -r id created_at email action result request_ip ua_b64 reason_b64; do
  i=$((i+1))

  if [[ -z "$created_at" ]]; then
    continue
  fi

  ua="$(printf '%s' "$ua_b64" | base64 -d 2>/dev/null || true)"
  reason="$(printf '%s' "$reason_b64" | base64 -d 2>/dev/null || true)"

  minute_key="$(date -u -d "$created_at" '+%d/%b/%Y:%H:%M' 2>/dev/null || true)"

  echo "[$i] $created_at | user=$email | action=$action | result=$result | audit_ip=$request_ip"
  if [[ -n "$reason" && "$reason" != "-" ]]; then
    echo "    reason: $reason"
  fi
  if [[ -n "$minute_key" ]]; then
    echo "    nginx minute key: $minute_key"
  else
    echo "    nginx minute key: (parse failed)"
  fi

  if [[ -s "$NGINX_LOG" && -n "$minute_key" ]]; then
    if [[ -n "$ua" ]]; then
      mapfile -t matches < <(grep -F "$minute_key" "$NGINX_LOG" | grep -F "$ua" | head -n "$SHOW_NGINX_LINES" || true)
    else
      mapfile -t matches < <(grep -F "$minute_key" "$NGINX_LOG" | head -n "$SHOW_NGINX_LINES" || true)
    fi

    if [[ ${#matches[@]} -gt 0 ]]; then
      echo "    nginx matches:"
      for line in "${matches[@]}"; do
        echo "      - $line"
      done
    else
      echo "    nginx matches: (none in tail window)"
    fi
  else
    echo "    nginx matches: (nginx log unavailable)"
  fi

  echo ""
done < "$AUDIT_TSV"

echo "======================================================"
echo "[DONE] If nginx matches are empty, increase --tail (e.g. --tail 10000)."
