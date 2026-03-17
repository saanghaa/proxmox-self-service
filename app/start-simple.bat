@echo off
REM Simple start script - No build required

cd /d e:\auto_deploy\proxmox\app

echo.
echo ================================================
echo   Proxmox Horizon - Development Mode
echo ================================================
echo.
echo   Running directly from source
echo   Reading config from .\defaults\
echo   Auto-restart on file changes
echo.
echo Press Ctrl+C to stop
echo.

npm run dev
