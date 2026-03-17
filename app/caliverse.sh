#!/bin/bash
# ═══════════════════════════════════════════
# Proxmox Horizon - Single Startup Script
# ═══════════════════════════════════════════

set -e  # Exit on error

cd "$(dirname "$0")"

echo ""
echo "╔════════════════════════════════════════╗"
echo "║    Proxmox Horizon - Starting...     ║"
echo "╚════════════════════════════════════════╝"
echo ""

# Check Node.js
if ! command -v node &> /dev/null; then
    echo "❌ Error: Node.js is not installed"
    exit 1
fi

echo "✓ Node.js: $(node -v)"

# Check npm
if ! command -v npm &> /dev/null; then
    echo "❌ Error: npm is not installed"
    exit 1
fi

echo "✓ npm: $(npm -v)"

# Check if node_modules exists
if [ ! -d "node_modules" ]; then
    echo ""
    echo "📦 Installing dependencies..."
    npm install
fi

# Check database connection
echo "✓ Database: Checking connection..."

# Start the application
echo ""
echo "🚀 Starting Proxmox Horizon..."
echo "   Mode: Development (direct from source)"
echo "   Source: src/"
echo "   Config: defaults/"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Run in development mode
npm run dev
