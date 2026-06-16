# MC Bot 启动器 (PowerShell)
$Host.UI.RawUI.WindowTitle = "MC Bot 启动器"

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "  MC Bot 启动器" -ForegroundColor Cyan
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

# 检查 mineflayer
if (-not (Test-Path "mineflayer")) {
    Write-Host "[下载] 正在 clone mineflayer..." -ForegroundColor Yellow
    git clone https://github.com/PrismarineJS/mineflayer.git mineflayer
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[错误] clone 失败，请检查网络" -ForegroundColor Red
        Read-Host "按回车键退出"
        exit 1
    }
    Write-Host "[完成] mineflayer 已下载" -ForegroundColor Green
} else {
    Write-Host "[检查] mineflayer 已存在" -ForegroundColor Green
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
Write-Host "  选择要启动的机器人:" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "  1 - 启动 EvoBot v4.0" -ForegroundColor White
Write-Host "  2 - 退出" -ForegroundColor White
Write-Host ""

$choice = Read-Host "请输入数字 (1-2)"

switch ($choice) {
    "1" {
        Write-Host "[启动] EvoBot v4.0..." -ForegroundColor Green
        node bot.js
    }
    "2" {
        Write-Host "[退出] 再见!" -ForegroundColor Yellow
        exit 0
    }
    default {
        Write-Host "[错误] 无效选择" -ForegroundColor Red
    }
}

Read-Host "按回车键退出"
