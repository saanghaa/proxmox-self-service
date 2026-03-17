#!/usr/bin/env bash
set -euo pipefail

# Download a cloud image into Proxmox storage content (default: import).
# Run on Proxmox host as root.
#
# Notes:
# - Proxmox Cloud Image 목록은 import 콘텐츠의 .img/.raw/.qcow2 파일을 표시합니다.
# - Ubuntu noble preset is an .img file (expected/normal).
#
# Presets:
# - ubuntu-noble
# - rocky-10

NODE="${HOSTNAME%%.*}"
STORAGE="local"
CONTENT="import"
PRESET="ubuntu-noble"
URL=""
PRESET_URL=""
PRESET_FILENAME=""
URL_SET=0
FILENAME=""
TIMEOUT_SEC=1800
INTERVAL_SEC=3
DRY_RUN=0
LIST_PRESETS=0

set_preset_defaults() {
  case "$PRESET" in
    ubuntu-noble)
      PRESET_URL="https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img"
      PRESET_FILENAME="noble-server-cloudimg-amd64.raw"
      ;;
    rocky-10)
      PRESET_URL="https://dl.rockylinux.org/pub/rocky/10/images/x86_64/Rocky-10-GenericCloud-Base.latest.x86_64.qcow2"
      PRESET_FILENAME=""
      ;;
    *)
      echo "ERROR: unknown preset '$PRESET'" >&2
      echo "Use --list-presets to see available presets." >&2
      exit 2
      ;;
  esac
}

print_presets() {
  cat <<'EOF'
Available presets:
  ubuntu-noble    Ubuntu 24.04 cloud image (download URL .img, saved as .raw for import)
  rocky-10        Rocky Linux 10 GenericCloud (.qcow2)
EOF
}

usage() {
  cat <<'EOF'
Usage: proxmox-download-cloud-image.sh [OPTIONS]

Options:
  --preset <name>      Image preset (default: ubuntu-noble)
  --list-presets       Show preset list and exit
  --node <name>         Proxmox node name (default: current hostname short)
  --storage <name>      Storage ID (default: local)
  --content <type>      Content type (default: import)
  --url <url>           Override image URL
  --filename <name>     Target file name (default: basename of --url)
  --timeout <sec>       Wait timeout in seconds (default: 1800)
  --interval <sec>      Poll interval in seconds (default: 3)
  --dry-run             Show planned actions only
  -h, --help            Show help

Examples:
  sudo ./proxmox-download-cloud-image.sh --preset ubuntu-noble --node pve01 --storage local
  sudo ./proxmox-download-cloud-image.sh --preset rocky-10 --node pve01 --storage local
  sudo ./proxmox-download-cloud-image.sh --node pve01 --storage local --url https://example.com/foo.qcow2
  sudo ./proxmox-download-cloud-image.sh --node pve01 --storage local --filename noble.img --dry-run
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --preset) PRESET="${2:-}"; shift 2 ;;
    --list-presets) LIST_PRESETS=1; shift ;;
    --node) NODE="${2:-}"; shift 2 ;;
    --storage) STORAGE="${2:-}"; shift 2 ;;
    --content) CONTENT="${2:-}"; shift 2 ;;
    --url) URL="${2:-}"; URL_SET=1; shift 2 ;;
    --filename) FILENAME="${2:-}"; shift 2 ;;
    --timeout) TIMEOUT_SEC="${2:-}"; shift 2 ;;
    --interval) INTERVAL_SEC="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ "$LIST_PRESETS" -eq 1 ]]; then
  print_presets
  exit 0
fi

set_preset_defaults

if [[ "$URL_SET" -eq 0 ]]; then
  URL="$PRESET_URL"
fi

if [[ -z "$URL" ]]; then
  echo "ERROR: preset URL is empty. Use --url manually." >&2
  exit 1
fi

if [[ -z "$FILENAME" ]]; then
  if [[ -n "$PRESET_FILENAME" ]]; then
    FILENAME="$PRESET_FILENAME"
  else
    FILENAME="$(basename "$URL")"
  fi
fi

# Some Proxmox versions reject .img for content=import; normalize to .raw.
if [[ "$CONTENT" == "import" && "${FILENAME,,}" == *.img ]]; then
  FILENAME="${FILENAME%.*}.raw"
  echo "INFO: normalized filename to '$FILENAME' for import content."
fi

if [[ -z "$NODE" || -z "$STORAGE" || -z "$CONTENT" || -z "$URL" || -z "$FILENAME" ]]; then
  echo "ERROR: required value is empty." >&2
  exit 1
fi

case "${FILENAME,,}" in
  *.img|*.raw|*.qcow2|*.vhd|*.vhdx) ;;
  *)
    echo "ERROR: unsupported filename extension: '$FILENAME'" >&2
    echo "Supported: .img .raw .qcow2 .vhd .vhdx" >&2
    exit 1
    ;;
esac

if [[ "$EUID" -ne 0 ]]; then
  echo "ERROR: run as root (sudo)." >&2
  exit 1
fi

if ! command -v pvesh >/dev/null 2>&1; then
  echo "ERROR: pvesh not found. Run on Proxmox host." >&2
  exit 1
fi

if ! command -v pvesm >/dev/null 2>&1; then
  echo "ERROR: pvesm not found. Run on Proxmox host." >&2
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "ERROR: python3 is required." >&2
  exit 1
fi

VOLID="${STORAGE}:${CONTENT}/${FILENAME}"

echo "Node:     $NODE"
echo "Storage:  $STORAGE"
echo "Content:  $CONTENT"
echo "Preset:   $PRESET"
echo "URL:      $URL"
echo "Filename: $FILENAME"
echo "Volid:    $VOLID"

if pvesm list "$STORAGE" --content "$CONTENT" 2>/dev/null | awk '{print $1}' | grep -Fxq "$VOLID"; then
  echo "OK: already exists, skip download: $VOLID"
  exit 0
fi

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "DRY RUN: would request download-url and wait for completion."
  exit 0
fi

echo "Submitting download task..."
UPID_RAW="$(pvesh create "/nodes/${NODE}/storage/${STORAGE}/download-url" \
  --url "$URL" \
  --filename "$FILENAME" \
  --content "$CONTENT" 2>&1 || true)"
# Show Proxmox output for troubleshooting.
echo "$UPID_RAW"

# pvesh output may include wget logs; extract the last UPID token only.
UPID="$(printf '%s\n' "$UPID_RAW" | sed -n 's/.*\(UPID:[^[:space:]]*\).*/\1/p' | tail -n1)"

if [[ -z "$UPID" ]]; then
  # Fallback: old/simple output style
  UPID="$(printf '%s' "$UPID_RAW" | tr -d '"' | tr -d '\r' | tr -d '\n')"
  if [[ "$UPID" != UPID:* ]]; then
    UPID=""
  fi
fi

if [[ -z "$UPID" ]]; then
  echo "ERROR: failed to parse UPID from Proxmox response." >&2
  echo "Hint: URL may be invalid or Proxmox rejected the download request." >&2
  exit 1
fi

echo "UPID: $UPID"
echo "Waiting for task completion..."

deadline=$(( $(date +%s) + TIMEOUT_SEC ))
while true; do
  now=$(date +%s)
  if (( now > deadline )); then
    echo "ERROR: timeout waiting for task $UPID (${TIMEOUT_SEC}s)." >&2
    exit 1
  fi

  status_json="$(pvesh get "/nodes/${NODE}/tasks/${UPID}/status" --output-format json 2>/dev/null || true)"
  if [[ -z "$status_json" ]]; then
    sleep "$INTERVAL_SEC"
    continue
  fi

  read -r task_status exit_status <<<"$(python3 - "$status_json" <<'PY'
import json, sys
obj = json.loads(sys.argv[1])
print(obj.get("status", ""), obj.get("exitstatus", ""))
PY
)"

  if [[ "$task_status" == "stopped" ]]; then
    if [[ "$exit_status" == "OK" ]]; then
      echo "OK: task completed successfully."
      break
    fi
    echo "ERROR: task failed. exitstatus=${exit_status:-unknown}" >&2
    exit 1
  fi

  sleep "$INTERVAL_SEC"
done

if pvesm list "$STORAGE" --content "$CONTENT" 2>/dev/null | awk '{print $1}' | grep -Fxq "$VOLID"; then
  echo "OK: image available: $VOLID"
  exit 0
fi

echo "WARN: task succeeded but target volid not found in pvesm list yet: $VOLID" >&2
echo "Try again after a few seconds:"
echo "  pvesm list $STORAGE --content $CONTENT | grep '$FILENAME'"
exit 0
