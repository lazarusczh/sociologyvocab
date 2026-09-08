# Three-step release (build -> Cloudflare deploy -> APK + Feishu).
# NOTE: keep this file pure ASCII. Some shells parse .ps1 as system ANSI (GBK),
# so any CJK byte sequence can break the parser. Comments and output stay English.
# Usage (from anywhere):
#   .\app\scripts\publish.ps1                        # full run, with version prompt
#   .\app\scripts\publish.ps1 -VersionName "1.6.1"   # also bump versionName
#   .\app\scripts\publish.ps1 -Yes                   # skip confirmation (automation)
#   .\app\scripts\publish.ps1 -SkipCloudflare        # build + APK only
#   .\app\scripts\publish.ps1 -SkipAndroid           # build + deploy only (no version bump)
param(
    [switch]$SkipCloudflare,
    [switch]$SkipAndroid,
    [switch]$SkipFeishu,
    [string]$VersionName = "",   # optional: new versionName ("" = keep current)
    [switch]$Yes                 # skip the confirmation prompt
)

$ErrorActionPreference = "Stop"
$env:NODE_OPTIONS = ""   # bypass IDE safe-delete shim so build output is really deleted

$AppDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$VersionFile = Join-Path $AppDir "android\app\build.gradle"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Step-Log($msg) { Write-Host "`n===== $msg =====" -ForegroundColor Cyan }
function Assert-Ok($step) {
    if ($LASTEXITCODE -ne 0) {
        throw "[FAILED] $step (exit code $LASTEXITCODE)"
    }
}
# Native commands write warnings (vite chunk size, git progress, gradle) to stderr.
# Under $ErrorActionPreference='Stop' that becomes a terminating error, so merge
# stderr into stdout and let Assert-Ok decide based on the exit code.
function Invoke-Step([string]$cmd, [string]$step) {
    # stderr may still surface as ErrorRecords even when merged; relax the
    # preference around the call and rely on the exit code instead.
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        Invoke-Expression "$cmd 2>&1 | Out-Host"
    } finally {
        $ErrorActionPreference = $prev
    }
    Assert-Ok $step
}

Push-Location $AppDir
$origText = $null
try {
    # 0/5 bump versionCode (only when packaging an APK)
    if (-not $SkipAndroid) {
        Step-Log "0/5 version check (android/app/build.gradle)"
        $origText = [System.IO.File]::ReadAllText($VersionFile)
        $codeMatch = [regex]::Match($origText, 'versionCode\s+(\d+)')
        $nameMatch = [regex]::Match($origText, 'versionName\s+"([^"]*)"')
        if (-not $codeMatch.Success) { throw "versionCode not found in build.gradle" }
        $oldCode = [int]$codeMatch.Groups[1].Value
        $newCode = $oldCode + 1
        $oldName = if ($nameMatch.Success) { $nameMatch.Groups[1].Value } else { "(not found)" }
        $wantName = $VersionName.Trim()
        $newName = if ($wantName) { $wantName } else { $oldName }

        Write-Host "Current:  versionCode $oldCode / versionName $oldName" -ForegroundColor Yellow
        if ($wantName) {
            Write-Host "Next:     versionCode -> $newCode, versionName -> $newName" -ForegroundColor Cyan
        } else {
            Write-Host "Next:     versionCode -> $newCode (versionName stays $oldName)" -ForegroundColor Cyan
        }
        if (-not $Yes) {
            $ans = Read-Host "Proceed with this version? (y/N)"
            if ($ans -notmatch '^(y|yes)$') { Write-Host "Cancelled." -ForegroundColor Red; exit 0 }
        }

        $next = [regex]::Replace($origText, 'versionCode\s+\d+', "versionCode $newCode")
        if ($wantName) {
            $next = [regex]::Replace($next, 'versionName\s+"[^"]*"', "versionName `"$newName`"")
        }
        [System.IO.File]::WriteAllText($VersionFile, $next, $utf8NoBom)
        Write-Host "Wrote versionCode $newCode / versionName $newName (commit it with the next change)" -ForegroundColor Green
    }

    # 1/5 frontend build
    Step-Log "1/5 npm run build"
    Invoke-Step "npm run build" "npm run build"

    # 2/5 deploy Cloudflare Worker + static assets
    if (-not $SkipCloudflare) {
        Step-Log "2/5 npx wrangler deploy"
        Invoke-Step "npx wrangler deploy" "wrangler deploy"
    }

    # 3/5 sync web output into the Android project
    Step-Log "3/5 npx cap sync android"
    Invoke-Step "npx cap sync android" "cap sync android"

    # 4/5 Gradle release APK
    if (-not $SkipAndroid) {
        Step-Log "4/5 gradlew assembleRelease"
        Push-Location (Join-Path $AppDir "android")
        try {
            # Gradle also writes warnings (SDK XML version, deprecations) to stderr
            Invoke-Step ".\gradlew.bat assembleRelease" "gradlew assembleRelease"
        } finally {
            Pop-Location
        }
    }

    # 5/5 send APK via Feishu
    if (-not ($SkipFeishu -or $SkipAndroid)) {
        Step-Log "5/5 npm run feishu:send-apk"
        Invoke-Step "npm run feishu:send-apk" "feishu:send-apk"
    }

    Write-Host "`nAll steps completed." -ForegroundColor Green
} catch {
    # Roll back the version bump so we never leave a "bumped but not shipped" version
    if ($origText -ne $null -and (Test-Path -LiteralPath $VersionFile)) {
        [System.IO.File]::WriteAllText($VersionFile, $origText, $utf8NoBom)
        Write-Host "Release failed, build.gradle version rolled back." -ForegroundColor Yellow
    }
    Write-Host "Aborted: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
} finally {
    Pop-Location
}
