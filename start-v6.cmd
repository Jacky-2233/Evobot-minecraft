@echo off
title EvoBot v6 — Phase 4 (GoalManager)
color 0B
cd /d "%~dp0"

echo ===============================================
echo   EvoBot v6 — Phase 4
echo   Architecture: Orchestrator + GoalManager
echo ===============================================
echo.

where npx >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js not found. Install from https://nodejs.org
    pause
    exit /b 1
)

if "%1"=="--check" (
    echo [CHECK] Running type check...
    npx tsc --noEmit
    if errorlevel 1 (
        echo [ERROR] Type check failed.
        pause
        exit /b 1
    )
    echo [CHECK] OK
)

if not exist "src-ts\index.ts" (
    echo [ERROR] src-ts/index.ts not found
    pause
    exit /b 1
)

echo [START] Launching bot...
npx tsx src-ts/index.ts %*
pause
