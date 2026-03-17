#!/bin/bash
# ===========================================
# Proxmox Horizon - Complete Rebuild Script
# ===========================================

set -e  # Exit on error

echo "🧹 Step 1: Stopping all services..."
# Stop Node.js process
pkill -f "node dist/server.js" 2>/dev/null || true
pkill -f "ts-node" 2>/dev/null || true

# Stop Docker containers (if using Docker)
if command -v docker &> /dev/null; then
    echo "🐳 Stopping Docker containers..."
    docker-compose down 2>/dev/null || true

    echo "🗑️  Removing Docker images..."
    docker images | grep proxmox | awk '{print $3}' | xargs -r docker rmi -f 2>/dev/null || true
fi

echo "🗑️  Step 2: Removing build artifacts..."
cd /e/auto_deploy/proxmox/app
rm -rf dist/
rm -rf node_modules/.cache/ 2>/dev/null || true

echo "📦 Step 3: Ensuring latest config files..."
# Verify src/defaults has latest changes
echo "  ✓ Checking default-menu-config.json..."
grep -q "삭제 예정 VM" defaults/default-menu-config.json && echo "    ✓ Menu config is correct" || echo "    ✗ Menu config needs update!"
grep -q "사용자 그룹" defaults/default-menu-config.json && echo "    ✓ Group name is correct" || echo "    ✗ Group name needs update!"

echo "🔨 Step 4: Building application..."
npm run build

echo "✅ Step 5: Verifying dist files..."
if [ -f "dist/defaults/default-menu-config.json" ]; then
    echo "  ✓ default-menu-config.json copied to dist"
    grep -q "삭제 예정 VM" dist/defaults/default-menu-config.json && echo "    ✓ Deleted VM label correct in dist" || echo "    ✗ ERROR: Deleted VM label wrong in dist!"
    grep -q "사용자 그룹" dist/defaults/default-menu-config.json && echo "    ✓ Group label correct in dist" || echo "    ✗ ERROR: Group label wrong in dist!"
else
    echo "  ✗ ERROR: default-menu-config.json not found in dist!"
    exit 1
fi

if [ -f "dist/defaults/ui-strings.json" ]; then
    echo "  ✓ ui-strings.json copied to dist"
else
    echo "  ✗ ERROR: ui-strings.json not found in dist!"
    exit 1
fi

echo "
╔════════════════════════════════════════╗
║   ✨ Rebuild Complete! ✨              ║
╚════════════════════════════════════════╝

Next steps:
1. Start the server: npm start
2. Clear browser cache: Ctrl + Shift + R
3. Login and verify changes

Expected changes:
✓ 삭제된 VM → 삭제 예정 VM
✓ 그룹 → 사용자 그룹
✓ 새 탭: 그룹 할당량
✓ Group column displays as badge (no dropdown)
"
