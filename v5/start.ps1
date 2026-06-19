# EvoBot v5.0 启动器 (PowerShell)
$Host.UI.RawUI.WindowTitle = "EvoBot v5.0"

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "  EvoBot v5.0 - Self-Evolving AI Agent" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""

# 检查 Node.js
try {
    $nodeVersion = node --version
    Write-Host "[检查] Node.js 已安装: $nodeVersion" -ForegroundColor Green
} catch {
    Write-Host "[错误] 未检测到 Node.js，请先安装 Node.js" -ForegroundColor Red
    Read-Host "按回车键退出"
    exit 1
}

Write-Host ""

# 安装依赖
if (-not (Test-Path "node_modules")) {
    Write-Host "[安装] 正在安装依赖..." -ForegroundColor Yellow
    npm install
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[错误] 依赖安装失败" -ForegroundColor Red
        Read-Host "按回车键退出"
        exit 1
    }
} else {
    Write-Host "[检查] 依赖已安装" -ForegroundColor Green
}

Write-Host ""
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "  准备启动 EvoBot v5.0" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""

node bot.js

Read-Host "按回车键退出"
