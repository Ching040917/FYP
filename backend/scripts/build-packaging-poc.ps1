# Reproducible packaging build - always fresh Frontend before PyInstaller.
#
# Packaging is strictly bound to the repository-controlled backend Python 3.12
# virtual environment (backend/.venv). Global Python, PATH-resolved PyInstaller,
# and Python 3.13 are NEVER used. Missing or mismatched prerequisites fail
# BEFORE any build output is touched.
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$BackendDir = (Resolve-Path (Join-Path $ScriptDir "..")).Path
$RepoRoot = (Resolve-Path (Join-Path $BackendDir "..")).Path
$FrontendDir = Join-Path $RepoRoot "frontend"
$FrontendDist = Join-Path $FrontendDir "dist"
$VenvDir = Join-Path $BackendDir ".venv"
$VenvPython = Join-Path $VenvDir "Scripts\python.exe"

# Repository-owned exact PyInstaller pin (must match requirements-dev.txt).
$RequiredPythonMajorMinor = "3.12"
$RequiredPyInstallerVersion = "6.22.2"

# Prohibited packages must never be bundled, regardless of the build machine.
$ProhibitedPackages = @("numpy", "pandas", "scipy", "matplotlib", "pyarrow", "ollama")

# Size regression ceiling. Clean Python 3.12 bundles are ~189 MB; the guard
# allows headroom but still rejects the contaminated ~388 MB build.
$MaxBundleBytes = 250MB

function Fail($msg) { Write-Host "FAIL: $msg" -ForegroundColor Red; exit 1 }

# Log an explicit override (never disables contamination checks).
function Log-Override($msg) { Write-Host "OVERRIDE: $msg" -ForegroundColor Yellow }

function Test-Python312PackageEnv {
    if (-not (Test-Path $VenvPython)) {
        Fail @"
The controlled packaging interpreter is missing.
  Expected: $VenvPython
To create it, run (from $BackendDir):
  python -m venv .venv
  .venv\Scripts\Activate.ps1
  pip install -r requirements.txt
  pip install -r requirements-dev.txt
"@
    }

    $pyVer = & $VenvPython -c "import sys; print('%s.%s' % (sys.version_info.major, sys.version_info.minor))" 2>&1
    if ($LASTEXITCODE -ne 0) { Fail "Could not query the venv interpreter: $pyVer" }
    if ($pyVer -ne $RequiredPythonMajorMinor) {
        Fail @"
Packaging requires Python $RequiredPythonMajorMinor.x, but the controlled
interpreter reports '$($pyVer.Trim())'.
  Interpreter: $VenvPython
Recreate the environment with a Python $RequiredPythonMajorMinor interpreter, then:
  pip install -r requirements.txt
  pip install -r requirements-dev.txt
"@
    }

    $piVer = & $VenvPython -m PyInstaller --version 2>&1
    if ($LASTEXITCODE -ne 0) {
        Fail @"
PyInstaller is not installed in the controlled environment.
  Interpreter: $VenvPython
Install the repository-owned dev dependencies:
  $VenvPython -m pip install -r requirements-dev.txt
"@
    }
    $piVer = ($piVer | Select-Object -First 1).Trim()
    if ($piVer -ne $RequiredPyInstallerVersion) {
        Fail "PyInstaller version $piVer does not match the repository pin $RequiredPyInstallerVersion. Install exactly PyInstaller==$RequiredPyInstallerVersion via requirements-dev.txt."
    }
    Write-Host "Packaging interpreter OK: $($pyVer.Trim()) via backend/.venv (Python $RequiredPythonMajorMinor.x)"
    Write-Host "PyInstaller OK: $piVer"
}

function Test-BundleChecks {
    param($BundleRoot)
    $tocArg = Join-Path $BackendDir "build\ACA"
    $pyChecks = Join-Path $BackendDir "scripts\packaging_checks.py"
    $out = & $VenvPython $pyChecks $BundleRoot $tocArg 2>&1
    $exit = $LASTEXITCODE
    $out | ForEach-Object { Write-Host $_ }
    if ($exit -ne 0) {
        $override = $env:ACA_ALLOW_OVERSIZE
        if ($exit -eq 3 -and $override -eq "1") {
            # Size guard explicitly overridden (contamination checks already passed at exit 0).
            Log-Override "Bundle exceeds the size ceiling but ACA_ALLOW_OVERSIZE=1 is set. Contamination checks remain active."
            return
        }
        if ($exit -eq 3) {
            Fail "Bundle exceeds the configured size ceiling. A clean Python 3.12 build is ~189 MB; >250 MB indicates dependency contamination. Recreate backend/.venv and rebuild."
        }
        Fail "Bundle validation failed: $out"
    }
    Write-Host "Contamination check OK: none of $($ProhibitedPackages -join ', ') present"
}

try {
    Write-Host "=== 0. Packaging environment (Python 3.12, backend/.venv only) ==="
    Test-Python312PackageEnv

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

    Write-Host "=== 4. PyInstaller via controlled interpreter (no PATH fallback) ==="
    Push-Location $BackendDir
    try {
        & $VenvPython -m PyInstaller ACA.spec --noconfirm
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

    Write-Host "=== 6. Bundle contamination + size guards ==="
    $BundleRoot = Join-Path $BackendDir "dist/run-frozen"
    Test-BundleChecks -BundleRoot $BundleRoot

    Write-Host "=== 7. Frozen smoke (isolated runtime root) ==="
    $env:ACA_DISABLE_BROWSER = "1"
    Remove-Item Env:\ACA_BROWSER_RECORD_FILE -ErrorAction SilentlyContinue
    $smokeRoot = Join-Path $env:TEMP ("aca_smoke_" + [guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Force -Path $smokeRoot | Out-Null
    $previousLocalAppData = $env:LOCALAPPDATA
    $env:LOCALAPPDATA = $smokeRoot
    $instPath = Join-Path $env:LOCALAPPDATA "AcademicComplianceAuditor\instance.json"
    $exe = Join-Path $BackendDir "dist/run-frozen/run-frozen.exe"
    $p = Start-Process $exe -WindowStyle Hidden -PassThru
    $launcherPid = $p.Id
    Write-Host "Launcher PID $launcherPid (isolated data root: <temp>/aca_smoke_*)"
    $ok = $false
    for ($i=0; $i -lt 20; $i++) {
        Start-Sleep 1
        try { $r = Invoke-RestMethod "http://127.0.0.1:8010/health" -TimeoutSec 2; if ($r.status -eq "healthy") { $ok=$true; break } } catch {}
        if ($p.HasExited) { Fail "Launcher exited early $($p.ExitCode)" }
    }
    if (-not $ok) { Fail "Health not ready" }
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
    $env:LOCALAPPDATA = $previousLocalAppData
    if (Test-Path $smokeRoot) { Remove-Item $smokeRoot -Recurse -Force -ErrorAction SilentlyContinue }
    Remove-Item Env:\ACA_DISABLE_BROWSER -ErrorAction SilentlyContinue
    if ($fails.Count -gt 0) { Fail "Smoke failures: $($fails -join '; ')" }
    Write-Host "Smoke OK"
    Write-Host "Source hash $srcHash Bundled $bHash"
}
finally {
    Remove-Item Env:\ACA_DISABLE_BROWSER -ErrorAction SilentlyContinue
    Remove-Item Env:\ACA_BROWSER_RECORD_FILE -ErrorAction SilentlyContinue
    Remove-Item Env:\ACA_ALLOW_OVERSIZE -ErrorAction SilentlyContinue
    # frontend/dist is generated, ignored, and untracked. It is left in place
    # (never removed with destructive Git cleanup) so a developer can inspect
    # the exact frontend the bundle shipped. The repository stays clean because
    # the directory is ignored.
}
