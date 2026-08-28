$ErrorActionPreference = "Stop"

# 1. check pg_dump
$pgdump = Get-Command pg_dump -ErrorAction SilentlyContinue
if (-not $pgdump) {
    Write-Error "pg_dump not found. Install PostgreSQL client tools first."
    exit 1
}

# 2. resolve PGPASSFILE
if (-not $env:PGPASSFILE) {
    $defaultPassFile = Join-Path $env:USERPROFILE ".pgpass"
    if (Test-Path $defaultPassFile) {
        $env:PGPASSFILE = $defaultPassFile
        Write-Host "Using PGPASSFILE: $defaultPassFile"
    } else {
        Write-Error "PGPASSFILE not set and $defaultPassFile not found."
        exit 1
    }
}

# 3. connection string (no password; from .pgpass)
$conn = "postgresql://postgres@spb-olltk79n0rjrawe5.supabase.opentrust.net:5432/postgres"

# 4. backup dir
if ($env:SUPABASE_DB_BACKUP_DIR) {
    $backupDir = $env:SUPABASE_DB_BACKUP_DIR
} else {
    $backupDir = Join-Path (Join-Path $PSScriptRoot "..") "backups"
}
if (-not (Test-Path $backupDir)) {
    New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
}

# 5. dump
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$outFile = Join-Path $backupDir "sociologyvocab-full-$timestamp.sql"

Write-Host "Dumping to: $outFile"
& pg_dump $conn -f $outFile
if ($LASTEXITCODE -ne 0) {
    Write-Error "pg_dump failed, exit code $LASTEXITCODE"
    exit $LASTEXITCODE
}

$sizeMB = [math]::Round((Get-Item $outFile).Length / 1MB, 2)
Write-Host "Backup done: $outFile  (size: ${sizeMB} MB)"

# 6. keep only latest 14, delete older
$old = Get-ChildItem $backupDir -Filter "sociologyvocab-full-*.sql" |
        Sort-Object LastWriteTime -Descending |
        Select-Object -Skip 14
if ($old) {
    $old | Remove-Item -Force
    Write-Host "Cleaned old backups: $($old.Count)"
}

Write-Host "Restore: psql `"$conn`" -f `"$outFile`""
