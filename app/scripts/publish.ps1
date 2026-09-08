﻿#Requires -Version 5.0
# 三步走发布流程（固化版）：① 构建 ② 部署 Cloudflare ③ 打包 APK 并发飞书
# 版本管理（方案 A）：发布前自动 versionCode+1（versionName 可选同步更新），失败自动回滚。
# 关键：脚本开头清空 NODE_OPTIONS —— 避免 IDE 安全删除接管 node 的构建产物删除
#       （否则 vite/cap 每次清空 dist、android assets 都进回收站，造成堆积）。
# 用法（在任意目录运行）：
#   .\app\scripts\publish.ps1                          # 完整三步走（含版本确认）
#   .\app\scripts\publish.ps1 -VersionName "1.6.0"     # 同时把 versionName 升为 1.6.0
#   .\app\scripts\publish.ps1 -Yes                     # 跳过交互确认（自动化/由 AI 代跑）
#   .\app\scripts\publish.ps1 -SkipCloudflare          # 只构建 + 打包 + 发飞书
#   .\app\scripts\publish.ps1 -SkipAndroid             # 只构建 + 部署（不打包、不改版本）
param(
    [switch]$SkipCloudflare,
    [switch]$SkipAndroid,
    [switch]$SkipFeishu,
    [string]$VersionName = "",   # 可选：本次 versionName（空 = 保持原值，仅递增 versionCode）
    [switch]$Yes                 # 跳过「确认版本号」交互询问
)

$ErrorActionPreference = "Stop"
$env:NODE_OPTIONS = ""   # 绕过删除保护 shim：产物删除永久化、不进回收站

$AppDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$VersionFile = Join-Path $AppDir "android\app\build.gradle"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Step-Log($msg) { Write-Host "`n===== $msg =====" -ForegroundColor Cyan }
function Assert-Ok($step) {
    if ($LASTEXITCODE -ne 0) {
        throw "[失败] $step（退出码 $LASTEXITCODE）"
    }
}

Push-Location $AppDir
$origText = $null
try {
    # 0/5 版本号回顾与递增（仅打 APK 时；纯 Web 部署不改版本）
    if (-not $SkipAndroid) {
        Step-Log "0/5 版本号检查（android/app/build.gradle）"
        $origText = [System.IO.File]::ReadAllText($VersionFile)
        $codeMatch = [regex]::Match($origText, 'versionCode\s+(\d+)')
        $nameMatch = [regex]::Match($origText, 'versionName\s+"([^"]*)"')
        if (-not $codeMatch.Success) { throw "build.gradle 中未找到 versionCode" }
        $oldCode = [int]$codeMatch.Groups[1].Value
        $newCode = $oldCode + 1
        $oldName = if ($nameMatch.Success) { $nameMatch.Groups[1].Value } else { "(未找到)" }
        $wantName = $VersionName.Trim()
        $newName = if ($wantName) { $wantName } else { $oldName }

        Write-Host "当前版本：versionCode $oldCode / versionName $oldName" -ForegroundColor Yellow
        if ($wantName) {
            Write-Host "本次将改为：versionCode -> $newCode，versionName -> $newName" -ForegroundColor Cyan
        } else {
            Write-Host "本次将改为：versionCode -> $newCode（versionName 保持 $oldName）" -ForegroundColor Cyan
        }
        if (-not $Yes) {
            $ans = Read-Host "确认以上版本并继续发布？(y/N)"
            if ($ans -notmatch '^(y|yes)$') { Write-Host "已取消。" -ForegroundColor Red; exit 0 }
        }
        # 写回新版本号（构建成功则保留；失败走 catch 恢复 origText）
        $next = [regex]::Replace($origText, 'versionCode\s+\d+', "versionCode $newCode")
        if ($wantName) {
            $next = [regex]::Replace($next, 'versionName\s+"[^"]*"', "versionName `"$newName`"")
        }
        [System.IO.File]::WriteAllText($VersionFile, $next, $utf8NoBom)
        Write-Host "已写入 versionCode $newCode / versionName $newName（注意：随下次 commit 一起提交）" -ForegroundColor Green
    }

    # 1/5 前端构建（tsc + vite，产出 dist）
    Step-Log "1/5 npm run build"
    npm run build
    Assert-Ok "npm run build"

    # 2/5 部署 Cloudflare Worker + 静态资源
    if (-not $SkipCloudflare) {
        Step-Log "2/5 npx wrangler deploy"
        npx wrangler deploy
        Assert-Ok "wrangler deploy"
    }

    # 3/5 同步 Web 产物到 Android 工程
    Step-Log "3/5 npx cap sync android"
    npx cap sync android
    Assert-Ok "cap sync android"

    # 4/5 Gradle 打 release APK
    if (-not $SkipAndroid) {
        Step-Log "4/5 gradlew assembleRelease"
        Push-Location (Join-Path $AppDir "android")
        try {
            .\gradlew.bat assembleRelease
        } finally {
            Pop-Location
        }
        Assert-Ok "gradlew assembleRelease"
    }

    # 5/5 发送 APK 到飞书
    if (-not ($SkipFeishu -or $SkipAndroid)) {
        Step-Log "5/5 npm run feishu:send-apk"
        npm run feishu:send-apk
        Assert-Ok "feishu:send-apk"
    }

    Write-Host "`n三步走全部完成。" -ForegroundColor Green
} catch {
    # 任一环节失败：回滚 build.gradle 版本号，避免留下“已递增但没发成”的脏版本
    if ($origText -ne $null -and (Test-Path -LiteralPath $VersionFile)) {
        [System.IO.File]::WriteAllText($VersionFile, $origText, $utf8NoBom)
        Write-Host "发布失败，已回滚 build.gradle 版本号。" -ForegroundColor Yellow
    }
    Write-Host "发布中断：$($_.Exception.Message)" -ForegroundColor Red
    exit 1
} finally {
    Pop-Location
}
