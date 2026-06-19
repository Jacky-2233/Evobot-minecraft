@echo off
title EvoBot v7 — AI Driven
color 0B
cd /d "%~dp0"

echo ===============================
echo   EvoBot v7 — AI Driven
echo   Minimal code, AI decides
echo ===============================
echo.

where npx >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js not found.
    pause
    exit /b 1
)
if not exist "src-ts-v7\index.ts" (
    echo [ERROR] src-ts-v7/index.ts not found
    pause
    exit /b 1
)

npx tsx src-ts-v7/index.ts
pause
