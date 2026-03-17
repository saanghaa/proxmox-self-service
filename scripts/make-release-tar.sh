#!/usr/bin/env bash
set -euo pipefail

# Create an upload-friendly tarball from the current source tree.
# This avoids "stale folder uploaded" problems and gives you a BUILD_ID + sha256 to verify on the server.
#
# Usage:
#   cd proxmox
#   bash scripts/make-release-tar.sh
#
# Output:
#   release/proxmox-release-<BUILD_ID>.tar.gz
#   release/proxmox-release-<BUILD_ID>.tar.gz.sha256

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "${ROOT_DIR}"

ts="$(date +%Y%m%d-%H%M%S)"
git_id=""
if command -v git >/dev/null 2>&1 && [ -d .git ]; then
  git_id="$(git rev-parse --short HEAD 2>/dev/null || true)"
fi

build_id="${ts}"
if [ -n "${git_id}" ]; then
  build_id="${ts}-${git_id}"
fi

echo "${build_id}" > ./BUILD_ID

out_dir="./release"
mkdir -p "${out_dir}"

tar_name="proxmox-release-${build_id}.tar.gz"
tar_path="${out_dir}/${tar_name}"

# Keep config + compose + defaults, exclude secrets/runtime data.
tar -czf "${tar_path}" \
  --exclude='./.env' \
  --exclude='./backups' \
  --exclude='./servers/postgres/data' \
  --exclude='./servers/postgres/backups' \
  --exclude='./servers/redis/data' \
  --exclude='./servers/app/uploads' \
  --exclude='./servers/app/logs' \
  --exclude='./servers/nginx/certs' \
  --exclude='./servers/nginx/logs' \
  --exclude='./node_modules' \
  --exclude='./app/node_modules' \
  --exclude='./app/dist' \
  --exclude='./app/.cache' \
  --exclude='./app/.next' \
  --exclude='./.git' \
  .

sha_file="${tar_path}.sha256"
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "${tar_path}" > "${sha_file}"
  echo "Wrote: ${sha_file}"
else
  echo "WARN: sha256sum not found; skipping sha file."
fi

echo "Wrote: ${tar_path}"
echo "BUILD_ID: ${build_id}"

