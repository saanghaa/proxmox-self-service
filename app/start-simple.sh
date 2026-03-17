#!/bin/bash
# Simple start script - No build required

cd /e/auto_deploy/proxmox/app

echo "🚀 Starting Proxmox Horizon (Development Mode)"
echo "================================================"
echo ""
echo "✓ Running directly from source"
echo "✓ Reading config from ./defaults/"
echo "✓ Auto-restart on file changes"
echo ""
echo "Press Ctrl+C to stop"
echo ""

npm run dev
