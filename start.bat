@echo off
title MC Bot - EvoBot Agent
color 0A

echo ==========================================
echo   MC Bot - Self-Evolving Agent
echo ==========================================
echo.

REM Check Node.js
node --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js not found! Please install from https://nodejs.org
    pause
    exit /b 1
)
echo [OK] Node.js:
node --version
echo.

REM Check dependencies
if not exist "node_modules\" (
    echo [WARN] Dependencies missing! Run: npm install
    pause
    exit /b 1
)
echo [OK] Dependencies ready
echo.

echo ==========================================
echo   Launching EvoBot Agent...
echo ==========================================
echo.
echo Server: 127.0.0.1:25565
echo Version: 1.20.6
echo.

node bot.js

pause
