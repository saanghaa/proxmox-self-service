@echo off
REM ===========================================
REM Proxmox Horizon - Complete Rebuild Script (Windows)
REM ===========================================

echo.
echo ============================================
echo   Proxmox Horizon - Complete Rebuild
echo ============================================
echo.

REM %~dp0 = 이 .bat 파일이 있는 디렉터리 (e:\proxmox\app\)
cd /d "%~dp0"

echo [1/4] Stopping Node.js processes...
taskkill /F /IM node.exe /T 2>nul
timeout /t 2 /nobreak >nul

echo [2/4] Removing dist folder...
if exist dist rmdir /s /q dist

echo [3/4] Building application...
call npm run build
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: Build failed!
    pause
    exit /b 1
)

echo [4/4] Verifying dist output...
if not exist "dist\server.js" (
    echo ERROR: dist\server.js not found!
    pause
    exit /b 1
)
echo   OK: dist\server.js exists

echo.
echo ============================================
echo   Build Complete!
echo ============================================
echo.
echo To start the server:
echo   npm start
echo.
echo To clear browser cache after reload:
echo   Ctrl + Shift + R
echo.
pause
