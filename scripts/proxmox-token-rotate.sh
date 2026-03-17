#!/usr/bin/env bash
set -euo pipefail

run_pveum_quiet_invalid_token_warn() {
  # Hide only this known non-fatal warning:
  # "user config - ignore invalid acl token '<user@realm!token>'"
  local out rc
  set +e
  out="$("$@" 2>&1)"
  rc=$?
  set -e
  if [[ ${rc} -ne 0 ]]; then
    printf '%s\n' "${out}" >&2
    return ${rc}
  fi
  printf '%s\n' "${out}" | grep -v "ignore invalid acl token" || true
  return 0
}

# Rotate Proxmox API token for Proxmox
# Usage:
#   bash proxmox-token-rotate.sh [user_id] [token_name]
# Example:
#   bash proxmox-token-rotate.sh proxmox@pam proxmox
#   bash proxmox-token-rotate.sh proxmox        # auto -> proxmox@pam
#   bash proxmox-token-rotate.sh                 # default -> proxmox@pam + token proxmox

USER_ID="${1:-}"
TOKEN_NAME="${2:-}"
ROLE_NAME="Administrator"
ACL_PATH="/"
DEFAULT_USER="proxmox"
DEFAULT_REALM="pam"
DEFAULT_TOKEN_NAME="proxmox"

if [[ -z "${USER_ID}" ]]; then
  read -r -p "User ID를 입력하세요 (기본값: ${DEFAULT_USER}, 예: proxmox 또는 proxmox@pam): " USER_ID
fi

if [[ -z "${USER_ID}" ]]; then
  USER_ID="${DEFAULT_USER}"
fi

# If realm omitted, default to @pam
if [[ "${USER_ID}" != *"@"* ]]; then
  USER_ID="${USER_ID}@${DEFAULT_REALM}"
fi

echo "[INFO] USER_ID=${USER_ID} ROLE=${ROLE_NAME} ACL_PATH=${ACL_PATH}"

if ! command -v pveum >/dev/null 2>&1; then
  echo "[ERROR] pveum not found. Run this on a Proxmox node." >&2
  exit 1
fi

remove_token_acls() {
  local token_ugid="$1"
  local acl_json
  acl_json="$(pveum acl list --output-format json 2>/dev/null || echo '[]')"

  if command -v jq >/dev/null 2>&1; then
    while IFS= read -r path; do
      [[ -n "${path}" ]] || continue
      pveum acldel "${path}" --tokens "${token_ugid}" >/dev/null 2>&1 || true
    done < <(printf '%s' "${acl_json}" | jq -r --arg t "${token_ugid}" '.[] | select(.type=="token" and .ugid==$t) | .path')
  else
    # Fallback: at least clear root ACL entry for token
    pveum acldel "/" --tokens "${token_ugid}" >/dev/null 2>&1 || true
  fi
}

# 1) Ensure user exists (auto create)
echo "[1/4] Check/Create user"
if ! pveum user list --output-format json 2>/dev/null | grep -q "\"userid\"[[:space:]]*:[[:space:]]*\"${USER_ID}\""; then
  pveum user add "${USER_ID}"
  echo "[OK] User created: ${USER_ID}"
else
  echo "[OK] User exists: ${USER_ID}"
fi

if [[ -z "${TOKEN_NAME}" ]]; then
  read -r -p "Token Name을 입력하세요 (기본값: ${DEFAULT_TOKEN_NAME}): " TOKEN_NAME
fi
if [[ -z "${TOKEN_NAME}" ]]; then
  TOKEN_NAME="${DEFAULT_TOKEN_NAME}"
fi

echo "[INFO] TOKEN_NAME=${TOKEN_NAME}"

# Remove existing token if present (ask first)
echo "[2/4] Create/Rotate token"
LIST_JSON="$(pveum user token list "${USER_ID}" --output-format json 2>/dev/null || echo '[]')"
TOKEN_EXISTS="0"
if command -v jq >/dev/null 2>&1; then
  if printf '%s' "${LIST_JSON}" | jq -e --arg t "${TOKEN_NAME}" '.[] | select(.tokenid == $t)' >/dev/null; then
    TOKEN_EXISTS="1"
  fi
else
  if printf '%s' "${LIST_JSON}" | grep -q "\"tokenid\"[[:space:]]*:[[:space:]]*\"${TOKEN_NAME}\""; then
    TOKEN_EXISTS="1"
  fi
fi

if [[ "${TOKEN_EXISTS}" == "1" ]]; then
  read -r -p "[WARN] Existing token '${TOKEN_NAME}' found for ${USER_ID}. Rotate token only? [Y/n]: " ANSWER
  case "${ANSWER}" in
    n|N|no|NO)
      echo "[ABORT] Token rotation cancelled."
      exit 0
      ;;
    *)
      echo "[INFO] Rotating token only (user/role not deleted)..."
      # 1) Token permission cleanup
      remove_token_acls "${USER_ID}!${TOKEN_NAME}"
      # 2) Token delete
      run_pveum_quiet_invalid_token_warn pveum user token remove "${USER_ID}" "${TOKEN_NAME}" >/dev/null
      echo "[OK] Existing token removed"
      ;;
  esac
fi

# Create new token and print secret
OUT="$(run_pveum_quiet_invalid_token_warn pveum user token add "${USER_ID}" "${TOKEN_NAME}" --privsep 0 --expire 0 --output-format json)"

if command -v jq >/dev/null 2>&1; then
  SECRET="$(printf '%s' "${OUT}" | jq -r '.value // empty')"
else
  SECRET="$(printf '%s' "${OUT}" | sed -n 's/.*"value"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
fi

echo
echo "=== New Token ==="
echo "Token ID     : ${USER_ID}!${TOKEN_NAME}"
echo "Token Secret : ${SECRET}"
echo
echo "[3/4] Role mapping (Administrator)"
pveum aclmod "${ACL_PATH}" --users "${USER_ID}" --roles "${ROLE_NAME}" --propagate 1
pveum aclmod "${ACL_PATH}" --tokens "${USER_ID}!${TOKEN_NAME}" --roles "${ROLE_NAME}" --propagate 1
echo "[OK] Role mapping applied"

echo "[4/4] Permission apply (ACL + privsep)"
pveum user token modify "${USER_ID}" "${TOKEN_NAME}" --privsep 0
echo "[OK] Permission settings applied"
echo
echo "=== Verify ==="
pveum user token list "${USER_ID}" | sed -n '1,20p'
pveum acl list | grep -E "${USER_ID}|${TOKEN_NAME}" || true
echo
echo "Use this in Proxmox immediately."
