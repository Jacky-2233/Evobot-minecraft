@echo off
title MC Bot Setup
color 0A

echo ==========================================
echo   MC Bot One-Click Setup
echo ==========================================
echo.

REM Switch to script directory
cd /d "%~dp0"
echo [INFO] Working directory: %cd%
echo.

REM Check Node.js
node --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js not found!
    echo Please download from: https://nodejs.org
    pause
    exit /b 1
)
echo [OK] Node.js:
node --version
echo.

REM Check Git
git --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Git not found!
    echo Please download from: https://git-scm.com
    pause
    exit /b 1
)
echo [OK] Git:
git --version
echo.

REM Remove old mineflayer if exists
if exist "mineflayer\" (
    echo [CLEAN] Removing old mineflayer...
    rmdir /s /q mineflayer 2>nul
    if exist "mineflayer\" (
        echo [WARN] Cannot delete, renaming...
        ren mineflayer mineflayer_old_%random% 2>nul
    )
)

REM Clone mineflayer
echo [CLONE] Downloading mineflayer...
git clone --depth 1 https://github.com/PrismarineJS/mineflayer.git mineflayer
if errorlevel 1 (
    echo [ERROR] mineflayer clone failed!
    pause
    exit /b 1
)
echo [OK] mineflayer downloaded
echo.

REM Install dependencies
echo [INSTALL] Running npm install...
call npm install
if errorlevel 1 (
    echo [ERROR] npm install failed!
    pause
    exit /b 1
)
echo [OK] Dependencies installed
echo.

REM Verify
if exist "node_modules\mineflayer\" (
    echo [OK] mineflayer package verified
) else (
    echo [WARN] mineflayer npm package not found, but local source is ready
)

echo.
echo ==========================================
echo   Setup Complete!
echo ==========================================
echo.
echo To start, run: start.bat
echo.
pause
