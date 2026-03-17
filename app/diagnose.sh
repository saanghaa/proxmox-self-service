#!/bin/bash
# ===========================================
# Proxmox Horizon - Comprehensive Diagnostics
# ===========================================

echo "🔍 DIAGNOSTIC REPORT"
echo "===================="
echo ""

cd /e/auto_deploy/proxmox/app

# 1. Check if changes are in source files
echo "📂 [1/7] Checking SOURCE files (src/)..."
if grep -q "삭제 예정 VM" src/defaults/default-menu-config.json 2>/dev/null; then
    echo "  ✅ src/defaults/default-menu-config.json: '삭제 예정 VM' found"
else
    echo "  ❌ src/defaults/default-menu-config.json: '삭제 예정 VM' NOT FOUND"
fi

if grep -q "사용자 그룹" src/defaults/default-menu-config.json 2>/dev/null; then
    echo "  ✅ src/defaults/default-menu-config.json: '사용자 그룹' found"
else
    echo "  ❌ src/defaults/default-menu-config.json: '사용자 그룹' NOT FOUND"
fi

if grep -q "GROUP_QUOTA" src/defaults/default-menu-config.json 2>/dev/null; then
    echo "  ✅ src/defaults/default-menu-config.json: 'GROUP_QUOTA' found"
else
    echo "  ❌ src/defaults/default-menu-config.json: 'GROUP_QUOTA' NOT FOUND"
fi

# 2. Check defaults folder (not in src)
echo ""
echo "📂 [2/7] Checking DEFAULTS files (defaults/)..."
if grep -q "삭제 예정 VM" defaults/default-menu-config.json 2>/dev/null; then
    echo "  ✅ defaults/default-menu-config.json: '삭제 예정 VM' found"
else
    echo "  ❌ defaults/default-menu-config.json: '삭제 예정 VM' NOT FOUND"
fi

# 3. Check DIST files
echo ""
echo "📦 [3/7] Checking DIST files (dist/)..."
if [ -f "dist/defaults/default-menu-config.json" ]; then
    if grep -q "삭제 예정 VM" dist/defaults/default-menu-config.json; then
        echo "  ✅ dist/defaults/default-menu-config.json: '삭제 예정 VM' found"
    else
        echo "  ❌ dist/defaults/default-menu-config.json: '삭제 예정 VM' NOT FOUND"
        echo "     Content preview:"
        grep "DELETED_VM_MANAGEMENT" -A 2 dist/defaults/default-menu-config.json | head -5
    fi
else
    echo "  ❌ dist/defaults/default-menu-config.json: FILE NOT FOUND"
fi

# 4. Check EJS template changes
echo ""
echo "📄 [4/7] Checking EJS template changes..."
if grep -q "isAdmin && allGroups.length > 0 ? allGroups : groups" src/views/index.ejs 2>/dev/null; then
    echo "  ✅ index.ejs: Admin group dropdown fix applied"
else
    echo "  ❌ index.ejs: Admin group dropdown fix NOT FOUND"
fi

if grep -q "const groupColumn = \`<span class=\"badge badge-group\">\${vm.group}</span>\`" src/views/index.ejs 2>/dev/null; then
    echo "  ✅ index.ejs: Group column badge fix applied"
else
    echo "  ❌ index.ejs: Group column badge fix NOT FOUND"
fi

if grep -q "tab-quota" src/views/admin.ejs 2>/dev/null; then
    echo "  ✅ admin.ejs: Quota tab found"
else
    echo "  ❌ admin.ejs: Quota tab NOT FOUND"
fi

# 5. Check for syntax errors in EJS
echo ""
echo "🔧 [5/7] Checking for EJS syntax errors..."
if command -v node &> /dev/null; then
    echo "  Checking index.ejs..."
    # This is a simple check, not perfect
    if grep -E "<%[^%>]*$" src/views/index.ejs > /dev/null; then
        echo "  ⚠️  Possible unclosed EJS tag in index.ejs"
    else
        echo "  ✅ index.ejs: No obvious syntax errors"
    fi
fi

# 6. Check package.json scripts
echo ""
echo "📜 [6/7] Checking package.json scripts..."
echo "  Start script: $(grep -A 0 '"start"' package.json)"
echo "  Build script: $(grep -A 0 '"build"' package.json)"

# 7. Check running processes
echo ""
echo "🔄 [7/7] Checking running processes..."
if pgrep -f "node.*dist/server.js" > /dev/null; then
    echo "  ✅ Node.js server is running"
    echo "  PIDs: $(pgrep -f "node.*dist/server.js")"
else
    echo "  ❌ Node.js server is NOT running"
fi

if command -v docker &> /dev/null; then
    echo ""
    echo "  Docker containers:"
    docker ps --format "table {{.Names}}\t{{.Image}}\t{{.Status}}" 2>/dev/null || echo "    No containers running"
fi

echo ""
echo "=========================================="
echo "📋 SUMMARY"
echo "=========================================="
echo ""
echo "If you see ❌ marks above, those are the issues that need to be fixed."
echo ""
echo "Common solutions:"
echo "1. If src/ files are wrong: Edit src/defaults/default-menu-config.json manually"
echo "2. If dist/ files are missing/wrong: Run 'npm run build' again"
echo "3. If EJS has errors: Check the EJS template syntax"
echo "4. If server not running: Start with 'npm start'"
echo ""
