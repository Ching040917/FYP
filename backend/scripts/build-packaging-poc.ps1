# Reproducible packaging build - always fresh Frontend before PyInstaller.
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$BackendDir = (Resolve-Path (Join-Path $ScriptDir "..")).Path
$RepoRoot = (Resolve-Path (Join-Path $BackendDir "..")).Path
$FrontendDir = Join-Path $RepoRoot "frontend"
$FrontendDist = Join-Path $FrontendDir "dist"

function Fail($msg) { Write-Host "FAIL: $msg" -ForegroundColor Red; exit 1 }

try {
    Write-Host "=== 1. npm ci ==="
    Push-Location $FrontendDir
    try {
        & npm ci
        if ($LASTEXITCODE -ne 0) { Fail "npm ci failed $LASTEXITCODE" }
    } finally { Pop-Location }

    Write-Host "=== 2. npm run build ==="
    Push-Location $FrontendDir
    try {
        & npm run build
        if ($LASTEXITCODE -ne 0) { Fail "npm run build failed $LASTEXITCODE" }
    } finally { Pop-Location }

    Write-Host "=== 3. Validate markers ==="
    $jsFiles = Get-ChildItem (Join-Path $FrontendDist "assets") -Filter "*.js" | Where-Object { $_.Name -match "^index-" } | Sort-Object Length -Descending
    if (-not $jsFiles) { Fail "No index-*.js found in frontend/dist/assets" }
    $jsPath = $jsFiles[0].FullName
    Write-Host "Checking $jsPath"
    $jsText = [IO.File]::ReadAllText($jsPath)
    $required = @("/dashboard", "/history", "/profiles/custom", "System readiness")
    $allJs = (Get-ChildItem (Join-Path $FrontendDist "assets") -Filter "*.js" | ForEach-Object { [IO.File]::ReadAllText($_.FullName) }) -join "`n"
    $missing = @()
    foreach ($m in $required) {
        if ($jsText -notmatch [regex]::Escape($m) -and $allJs -notmatch [regex]::Escape($m)) { $missing += $m }
    }
    if ($missing.Count -gt 0) { Fail "Missing markers: $($missing -join ', ')" }
    Write-Host "Markers OK"
    $srcFiles = @(
        (Join-Path $FrontendDir "src/app/router.tsx"),
        (Join-Path $FrontendDir "src/pages/Dashboard.tsx"),
        (Join-Path $FrontendDir "src/components/dashboard/guidance-panel.tsx")
    )
    $distTime = (Get-Item $jsPath).LastWriteTime
    foreach ($sf in $srcFiles) {
        if ((Test-Path $sf) -and (Get-Item $sf).LastWriteTime -gt $distTime) { Fail "frontend/dist older than $sf" }
    }
    Write-Host "Staleness check OK"

    Write-Host "=== 4. PyInstaller ACA.spec ==="
    Push-Location $BackendDir
    try {
        & pyinstaller ACA.spec --noconfirm
        if ($LASTEXITCODE -ne 0) { Fail "PyInstaller failed $LASTEXITCODE" }
    } finally { Pop-Location }

    Write-Host "=== 5. Hash comparison ==="
    $srcHash = (Get-FileHash $jsPath -Algorithm SHA256).Hash.Substring(0,16)
    $bundledDir = Join-Path $BackendDir "dist/run-frozen/_internal/frontend-dist/assets"
    $bundledJs = Get-ChildItem $bundledDir -Filter "*.js" | Where-Object { $_.Name -match "^index-" } | Sort-Object Length -Descending | Select-Object -First 1
    if (-not $bundledJs) { Fail "No bundled index-*.js" }
    $bHash = (Get-FileHash $bundledJs.FullName -Algorithm SHA256).Hash.Substring(0,16)
    Write-Host "Source $srcHash Bundled $bHash"
    if ($srcHash -ne $bHash) { Fail "Hash mismatch $srcHash != $bHash" }
    $srcHtmlHash = (Get-FileHash (Join-Path $FrontendDist "index.html") -Algorithm SHA256).Hash.Substring(0,16)
    $bHtmlHash = (Get-FileHash (Join-Path $BackendDir "dist/run-frozen/_internal/frontend-dist/index.html") -Algorithm SHA256).Hash.Substring(0,16)
    if ($srcHtmlHash -ne $bHtmlHash) { Fail "HTML hash mismatch" }
    Write-Host "Hash match OK"

    Write-Host "=== 6. Frozen smoke ==="
    $env:ACA_DISABLE_BROWSER = "1"
    Remove-Item Env:\ACA_BROWSER_RECORD_FILE -ErrorAction SilentlyContinue
    Remove-Item "$env:LOCALAPPDATA\AcademicComplianceAuditor\instance.json" -Force -ErrorAction SilentlyContinue
    $staleCheck = Join-Path $env:LOCALAPPDATA "AcademicComplianceAuditor/instance.json"
    if (Test-Path $staleCheck) {
        try { $s = Get-Content $staleCheck -Raw | ConvertFrom-Json; $sp = Get-Process -Id $s.pid -ErrorAction SilentlyContinue; if (-not $sp) { Remove-Item $staleCheck -Force -ErrorAction SilentlyContinue; Write-Host "Cleaned stale instance.json" } } catch { Remove-Item $staleCheck -Force -ErrorAction SilentlyContinue }
    }
    $exe = Join-Path $BackendDir "dist/run-frozen/run-frozen.exe"
    $p = Start-Process $exe -WindowStyle Hidden -PassThru
    $launcherPid = $p.Id
    Write-Host "Launcher PID $launcherPid"
    $ok = $false
    for ($i=0; $i -lt 15; $i++) {
        Start-Sleep 1
        try { $r = Invoke-RestMethod "http://127.0.0.1:8010/health" -TimeoutSec 2; if ($r.status -eq "healthy") { $ok=$true; break } } catch {}
        if ($p.HasExited) { Fail "Launcher exited early $($p.ExitCode)" }
    }
    if (-not $ok) { Fail "Health not ready" }
    $instPath = Join-Path $env:LOCALAPPDATA "AcademicComplianceAuditor/instance.json"
    $port = 8010
    if (Test-Path $instPath) { try { $port = (Get-Content $instPath -Raw | ConvertFrom-Json).port } catch {} }
    $base = "http://127.0.0.1:$port"
    Write-Host "Health port $port"
    $fails = @()
    foreach ($route in @("/", "/dashboard", "/history", "/profiles/custom", "/audit/test-id")) {
        try {
            $r = Invoke-WebRequest -UseBasicParsing "$base$route" -TimeoutSec 5
            if ($r.StatusCode -ne 200) { $fails += "$route status $($r.StatusCode)" }
            elseif ($r.Headers["Content-Type"] -notmatch "text/html") { $fails += "$route CT" }
        } catch { $fails += "$route err $_" }
    }
    $jsName = (Split-Path $jsPath -Leaf)
    try { $a = Invoke-WebRequest -UseBasicParsing "$base/assets/$jsName" -TimeoutSec 5; if ($a.StatusCode -ne 200) { $fails += "asset $jsName" } } catch { $fails += "asset $jsName err" }
    try {
        $cssName = (Get-ChildItem (Join-Path $FrontendDist "assets") -Filter "index-*.css" | Select-Object -First 1).Name
        $c = Invoke-WebRequest -UseBasicParsing "$base/assets/$cssName" -TimeoutSec 5; if ($c.StatusCode -ne 200) { $fails += "css $cssName" }
    } catch { $fails += "css err" }
    try { Invoke-RestMethod "$base/api/unknown" -TimeoutSec 5 | Out-Null; $fails += "/api/unknown should 404" } catch { $resp=$_.Exception.Response; if (-not $resp -or [int]$resp.StatusCode -ne 404) { $fails += "/api/unknown not 404" } }
    try { $h=Invoke-RestMethod "$base/health" -TimeoutSec 5; if ($h.status -ne "healthy") { $fails += "health json" } } catch { $fails += "health json err" }
    try { $o=Invoke-RestMethod "$base/openapi.json" -TimeoutSec 5; if (-not $o.openapi) { $fails += "openapi" } } catch { $fails += "openapi err" }
    $backendPid = $null
    if (Test-Path $instPath) { try { $backendPid = (Get-Content $instPath -Raw | ConvertFrom-Json).pid } catch {} }
    Write-Host "Stopping launcher $launcherPid and backend $backendPid"
    foreach ($killPid in @($launcherPid, $backendPid) | Where-Object { $_ }) {
        try { $proc = Get-Process -Id $killPid -ErrorAction SilentlyContinue; if ($proc) { Stop-Process -Id $killPid -Force -ErrorAction SilentlyContinue } } catch {}
    }
    Start-Sleep 2
    $left = Get-CimInstance Win32_Process -Filter "Name='run-frozen.exe'" -ErrorAction SilentlyContinue
    if ($left) { $fails += "ACA processes remain" }
    Remove-Item $instPath -Force -ErrorAction SilentlyContinue
    Remove-Item Env:\ACA_DISABLE_BROWSER -ErrorAction SilentlyContinue
    if ($fails.Count -gt 0) { Fail "Smoke failures: $($fails -join '; ')" }
    Write-Host "Smoke OK"
    Write-Host "Source hash $srcHash Bundled $bHash"
}
finally {
    Remove-Item Env:\ACA_DISABLE_BROWSER -ErrorAction SilentlyContinue
    Remove-Item Env:\ACA_BROWSER_RECORD_FILE -ErrorAction SilentlyContinue
    Push-Location $RepoRoot -ErrorAction SilentlyContinue
    try {
        & git restore frontend/dist 2>&1 | Out-Null
        & git clean -fd -- frontend/dist 2>&1 | Out-Null
        Write-Host "Restored tracked frontend/dist to HEAD"
    } catch {} finally { Pop-Location -ErrorAction SilentlyContinue }
}
