#!/usr/bin/env bash
set -euo pipefail

# Proxmox local storage bootstrap helper for Proxmox.
# - Ensures selected content types (import/snippets)
# - Optionally creates default cloud-init snippet file
#
# Run on Proxmox host as root.
#
# Examples:
#   sudo ./proxmox-enable-content.sh
#   sudo ./proxmox-enable-content.sh --all
#   sudo ./proxmox-enable-content.sh --interactive
#   sudo ./proxmox-enable-content.sh --storage local --dry-run

STORAGE="local"
DRY_RUN="0"
INTERACTIVE="0"
SELECTION_EXPLICIT="0"

ENSURE_IMPORT="1"
ENSURE_SNIPPETS="1"
CREATE_SNIPPET="1"
SNIPPET_PATH="/var/lib/vz/snippets/proxmox-cloud-init.yaml"
FORCE_SNIPPET="0"
SSH_PORT="2211"

usage() {
  cat <<'HELP'
Usage: proxmox-enable-content.sh [OPTIONS]

Options:
  --all                  Full setup (import + snippets + default snippet)
  --interactive          Ask interactively (full setup or per-item)
  --storage <name>       Storage id (default: local)
  --dry-run              Print actions only
  --snippet-path <path>  Snippet target path (default: /var/lib/vz/snippets/proxmox-cloud-init.yaml)
  --ssh-port <port>      SSH port for cloud-init snippet (default: 2211)
  --force-snippet        Overwrite snippet file even if it already exists
  --no-import            Skip enabling import content
  --no-snippets          Skip enabling snippets content
  --no-snippet           Skip creating default snippet file
  -h, --help             Show help
HELP
}

prompt_yes_no() {
  local message="$1"
  local default_yes="${2:-1}" # 1=yes, 0=no
  local answer

  while true; do
    if [[ "$default_yes" == "1" ]]; then
      read -r -p "${message} [Y/n]: " answer || true
      answer="${answer:-Y}"
    else
      read -r -p "${message} [y/N]: " answer || true
      answer="${answer:-N}"
    fi

    case "${answer,,}" in
      y|yes) return 0 ;;
      n|no) return 1 ;;
      *) echo "Please answer y or n." ;;
    esac
  done
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --all)
      ENSURE_IMPORT="1"
      ENSURE_SNIPPETS="1"
      CREATE_SNIPPET="1"
      SELECTION_EXPLICIT="1"
      shift
      ;;
    --interactive)
      INTERACTIVE="1"
      shift
      ;;
    --storage)
      STORAGE="${2:-}"
      shift 2
      ;;
    --dry-run)
      DRY_RUN="1"
      shift
      ;;
    --snippet-path)
      SNIPPET_PATH="${2:-}"
      shift 2
      ;;
    --force-snippet)
      FORCE_SNIPPET="1"
      shift
      ;;
    --ssh-port)
      SSH_PORT="${2:-}"
      shift 2
      ;;
    --no-import)
      ENSURE_IMPORT="0"
      SELECTION_EXPLICIT="1"
      shift
      ;;
    --no-snippets)
      ENSURE_SNIPPETS="0"
      SELECTION_EXPLICIT="1"
      shift
      ;;
    --no-snippet)
      CREATE_SNIPPET="0"
      SELECTION_EXPLICIT="1"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

# If interactive requested, or no explicit selection and tty available, ask user.
if [[ "${INTERACTIVE}" == "1" ]] || { [[ "${SELECTION_EXPLICIT}" == "0" ]] && [[ -t 0 ]]; }; then
  echo ""
  echo "=== Proxmox content/snippet setup ==="
  echo "Storage: ${STORAGE}"
  echo ""

  if prompt_yes_no "Run full setup (import + snippets + default snippet)?" 1; then
    ENSURE_IMPORT="1"
    ENSURE_SNIPPETS="1"
    CREATE_SNIPPET="1"
  else
    if prompt_yes_no "Enable 'import' content?" 1; then ENSURE_IMPORT="1"; else ENSURE_IMPORT="0"; fi
    if prompt_yes_no "Enable 'snippets' content?" 1; then ENSURE_SNIPPETS="1"; else ENSURE_SNIPPETS="0"; fi
    if prompt_yes_no "Create default snippet file?" 1; then CREATE_SNIPPET="1"; else CREATE_SNIPPET="0"; fi
  fi
fi

if [[ "$EUID" -ne 0 ]]; then
  echo "ERROR: run as root (sudo)." >&2
  exit 1
fi

if ! command -v pvesh >/dev/null 2>&1; then
  echo "ERROR: pvesh not found. This script must run on a Proxmox VE host." >&2
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "ERROR: python3 not found." >&2
  exit 1
fi

if [[ ! -f /etc/pve/storage.cfg ]]; then
  echo "ERROR: /etc/pve/storage.cfg not found. Are you on a PVE host?" >&2
  exit 1
fi

if [[ -z "${STORAGE}" ]]; then
  echo "ERROR: storage name is empty." >&2
  exit 1
fi

if [[ "${CREATE_SNIPPET}" == "1" && "${ENSURE_SNIPPETS}" == "0" ]]; then
  echo "INFO: snippet file creation selected; forcing snippets content enable."
  ENSURE_SNIPPETS="1"
fi

json="$(pvesh get "/storage/${STORAGE}" --output-format json 2>/dev/null || true)"
if [[ -z "$json" ]]; then
  echo "ERROR: storage '${STORAGE}' not found (pvesh get /storage/${STORAGE} failed)." >&2
  exit 1
fi

current_content="$(python3 - "$json" <<'PY'
import json,sys
raw=sys.argv[1]
o=json.loads(raw)
print(o.get("content","") or "")
PY
)"

if [[ -z "$current_content" ]]; then
  echo "ERROR: failed to read current content for storage '${STORAGE}'." >&2
  exit 1
fi

new_content="$(python3 - "$current_content" "$ENSURE_IMPORT" "$ENSURE_SNIPPETS" <<'PY'
import sys
s=sys.argv[1]
need_import=sys.argv[2] == "1"
need_snippets=sys.argv[3] == "1"
items=[x.strip() for x in s.split(",") if x.strip()]
if need_import and "import" not in items:
    items.append("import")
if need_snippets and "snippets" not in items:
    items.append("snippets")
print(",".join(items))
PY
)"

if [[ -z "${new_content}" ]]; then
  echo "ERROR: failed to compute new content list." >&2
  exit 1
fi

if [[ "${ENSURE_IMPORT}" == "0" && "${ENSURE_SNIPPETS}" == "0" ]]; then
  echo "INFO: content update skipped (--no-import and --no-snippets)."
elif [[ "${new_content}" == "${current_content}" ]]; then
  echo "OK: storage '${STORAGE}' already satisfies selected content options."
  echo "Current content: ${current_content}"
else
  echo "Storage: ${STORAGE}"
  echo "Current content: ${current_content}"
  echo "New content:     ${new_content}"

  if [[ "${DRY_RUN}" == "1" ]]; then
    echo "DRY RUN: would apply storage content update."
  else
    backup="/etc/pve/storage.cfg.bak.$(date +%Y%m%d-%H%M%S)"
    cp -a /etc/pve/storage.cfg "$backup"
    echo "Backup created: $backup"

    pvesh set "/storage/${STORAGE}" --content "$new_content" >/dev/null

    echo "Applied. Verify:"
    if [[ "${ENSURE_IMPORT}" == "1" ]]; then
      echo "  pvesm list ${STORAGE} --content import"
    fi
    if [[ "${ENSURE_SNIPPETS}" == "1" ]]; then
      echo "  pvesm list ${STORAGE} --content snippets"
    fi
  fi
fi

if [[ "${CREATE_SNIPPET}" == "1" ]]; then
  echo ""
  if [[ -z "${SNIPPET_PATH}" ]]; then
    echo "WARN: snippet path is empty; skip snippet creation."
    exit 0
  fi

  if [[ "${DRY_RUN}" == "1" ]]; then
    echo "DRY RUN: would ensure snippet file exists: ${SNIPPET_PATH}"
    exit 0
  fi

  if [[ -f "${SNIPPET_PATH}" && "${FORCE_SNIPPET}" != "1" ]]; then
    echo "OK: predefined snippet already exists (skip): ${SNIPPET_PATH}"
    exit 0
  fi

  snippet_dir="$(dirname "${SNIPPET_PATH}")"
  mkdir -p "${snippet_dir}"

  cat > "${SNIPPET_PATH}" <<'YAML'
#cloud-config
# 지원 OS: Ubuntu (noble+), Rocky Linux (10+)

packages:
  - qemu-guest-agent

write_files:
  - path: /etc/ssh/sshd_config.d/99-custom.conf
    content: |
      Port __SSH_PORT__
      PermitRootLogin prohibit-password
      PasswordAuthentication no
      PubkeyAuthentication yes
      ChallengeResponseAuthentication no
      KbdInteractiveAuthentication no
      UsePAM yes
      X11Forwarding no
      PrintMotd no
      AcceptEnv LANG LC_*
      Subsystem sftp /usr/lib/openssh/sftp-server
  - path: /usr/local/bin/setup-disks.sh
    permissions: '0755'
    content: |
      #!/bin/bash
      set -eu
      TARGET_FS="ext4"

      # OS 식별
      OS_ID="unknown"
      if [ -r /etc/os-release ]; then
        . /etc/os-release
        OS_ID="${ID:-unknown}"
      fi
      if [ "$OS_ID" = "unknown" ]; then
        if [ -f /etc/rocky-release ]; then
          OS_ID="rocky"
        elif [ -f /etc/debian_version ]; then
          OS_ID="ubuntu"
        fi
      fi

      install_pkg() {
        local pkg="$1"
        case "$OS_ID" in
          ubuntu|debian)
            DEBIAN_FRONTEND=noninteractive apt-get install -y "$pkg" >/dev/null 2>&1 || true
            ;;
          rocky|rhel|centos)
            dnf -y install "$pkg" >/dev/null 2>&1 || true
            ;;
        esac
      }

      install_if_missing() {
        command -v "$1" >/dev/null 2>&1 || install_pkg "$2"
      }

      install_if_missing blkid util-linux
      install_if_missing findmnt util-linux
      install_if_missing mkfs.ext4 e2fsprogs
      install_if_missing mkfs.xfs xfsprogs

      # Root 디스크를 제외하고 "추가" 디스크만 /data, /data2...로 자동 마운트
      ROOT_SRC="$(findmnt -n -o SOURCE / 2>/dev/null || true)"
      ROOT_DISK=""
      if [ -n "${ROOT_SRC}" ]; then
        CUR="${ROOT_SRC}"
        for _ in 1 2 3 4 5; do
          PKNAME="$(lsblk -no PKNAME "${CUR}" 2>/dev/null | head -n1 || true)"
          if [ -z "${PKNAME}" ]; then
            break
          fi
          CUR="/dev/${PKNAME}"
        done
        if [[ "${CUR}" =~ ^/dev/(sd[a-z]+|vd[a-z]+|xvd[a-z]+|nvme[0-9]+n[0-9]+)$ ]]; then
          ROOT_DISK="${CUR}"
        elif [[ "${ROOT_SRC}" =~ ^/dev/nvme[0-9]+n[0-9]+p[0-9]+$ ]]; then
          ROOT_DISK="${ROOT_SRC%p*}"
        elif [[ "${ROOT_SRC}" =~ ^/dev/[a-z]+[0-9]+$ ]]; then
          ROOT_DISK="${ROOT_SRC%%[0-9]*}"
        fi
      fi

      DATA_IDX=1
      lsblk -dn -o NAME,TYPE | awk '$2=="disk"{print "/dev/"$1}' | while read -r DEV; do
        [ -n "${DEV}" ] || continue
        [ -b "${DEV}" ] || continue
        [ "${DEV}" = "${ROOT_DISK}" ] && continue
        if lsblk -nr -o MOUNTPOINT "${DEV}" 2>/dev/null | grep -q '[^[:space:]]'; then
          continue
        fi

        if [ "${DATA_IDX}" -eq 1 ]; then
          MP="/data"
        else
          MP="/data${DATA_IDX}"
        fi
        DATA_IDX=$((DATA_IDX + 1))

        ACTUAL_FS="$(blkid -s TYPE -o value "${DEV}" 2>/dev/null || true)"
        if [ -z "${ACTUAL_FS}" ]; then
          if [ "${TARGET_FS}" = "xfs" ] && command -v mkfs.xfs >/dev/null 2>&1; then
            mkfs.xfs -f "${DEV}"
            ACTUAL_FS="xfs"
          else
            mkfs.ext4 -F "${DEV}"
            ACTUAL_FS="ext4"
          fi
        fi
        [ -n "${ACTUAL_FS}" ] || ACTUAL_FS="${TARGET_FS}"

        mkdir -p "${MP}"
        DISK_UUID="$(blkid -s UUID -o value "${DEV}" 2>/dev/null || true)"
        if [ -n "${DISK_UUID}" ]; then
          grep -q "UUID=${DISK_UUID}" /etc/fstab || echo "UUID=${DISK_UUID} ${MP} ${ACTUAL_FS} defaults,nofail 0 2" >> /etc/fstab
        else
          grep -q "^${DEV} " /etc/fstab || echo "${DEV} ${MP} ${ACTUAL_FS} defaults,nofail 0 2" >> /etc/fstab
        fi
        mountpoint -q "${MP}" || mount "${MP}" || mount -t "${ACTUAL_FS}" "${DEV}" "${MP}" || true
      done

      # qemu-guest-agent 보강 (packages 지시문 실패 시 fallback)
      if ! systemctl list-unit-files 2>/dev/null | grep -q '^qemu-guest-agent\.service'; then
        install_pkg qemu-guest-agent
      fi
      systemctl enable qemu-guest-agent >/dev/null 2>&1 || true
      systemctl start qemu-guest-agent >/dev/null 2>&1 || true
  - path: /usr/local/bin/setup-firewall.sh
    permissions: '0755'
    content: |
      #!/bin/bash
      set -eu
      SSH_PORT="__SSH_PORT__"

      # OS 식별
      OS_ID="unknown"
      if [ -r /etc/os-release ]; then
        . /etc/os-release
        OS_ID="${ID:-unknown}"
      fi

      case "$OS_ID" in
        ubuntu|debian)
          # Ubuntu: ufw
          if ! command -v ufw >/dev/null 2>&1; then
            DEBIAN_FRONTEND=noninteractive apt-get install -y ufw >/dev/null 2>&1 || true
          fi
          ufw allow "${SSH_PORT}/tcp"
          ufw --force enable
          ;;
        rocky|rhel|centos)
          # Rocky: SELinux 비활성화
          sed -i 's/^SELINUX=enforcing/SELINUX=disabled/' /etc/selinux/config 2>/dev/null || true
          sed -i 's/^SELINUX=permissive/SELINUX=disabled/' /etc/selinux/config 2>/dev/null || true
          setenforce 0 2>/dev/null || true
          # Rocky: firewalld
          systemctl enable firewalld >/dev/null 2>&1 || true
          systemctl start firewalld >/dev/null 2>&1 || true
          firewall-cmd --permanent --add-port="${SSH_PORT}/tcp"
          firewall-cmd --reload
          ;;
      esac

runcmd:
  - /usr/local/bin/setup-disks.sh || true
  - growpart /dev/sda 1 || true
  - resize2fs /dev/sda1 || xfs_growfs / || true
  - systemctl enable qemu-guest-agent
  - systemctl start qemu-guest-agent
  - systemctl restart ssh || systemctl restart sshd || true
  - /usr/local/bin/setup-firewall.sh || true

power_state:
  mode: reboot
  message: Cloud-init configuration complete. Rebooting...
  timeout: 30
YAML

  # SSH 포트 치환
  sed -i "s/__SSH_PORT__/${SSH_PORT}/g" "${SNIPPET_PATH}"

  chmod 0644 "${SNIPPET_PATH}"
  echo "OK: predefined snippet ensured: ${SNIPPET_PATH}"
fi

echo ""
echo "Done."
