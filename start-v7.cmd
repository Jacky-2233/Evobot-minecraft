@echo off
title EvoBot v7
color 0B
cd /d "%~dp0"

echo ===============================
echo   EvoBot v7 - AI Driven
echo   Minimal code, AI decides
echo ===============================
echo.

where npx >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js / npx not found. Please install Node.js.
    pause
    exit /b 1
)
if not exist "src-ts-v7\index.ts" (
    echo [ERROR] src-ts-v7/index.ts not found
    pause
    exit /b 1
)

set "CHECK=0"
if /I "%1"=="--check" set "CHECK=1"
if /I "%1"=="-c" set "CHECK=1"

if "%CHECK%"=="1" (
    echo [CHECK] Running TypeScript check...
    npx tsc --noEmit
    if errorlevel 1 (
        echo [CHECK] TypeScript errors found. Fix before running.
        pause
        exit /b 1
    )
    echo [CHECK] OK.
    echo.
)

cls
echo ===============================
echo   EvoBot v7 - AI Driven
echo ===============================
echo.

:start
npx tsx src-ts-v7/index.ts
if errorlevel 1 (
    echo.
    echo [WARN] Bot exited with error code %errorlevel%
    echo Restarting in 3 seconds... (Ctrl+C to stop)
    timeout /t 3 /nobreak >nul
    goto start
)

pause
