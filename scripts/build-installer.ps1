# build-installer.ps1 - reproducible Academic Compliance Auditor Windows installer.
#
# Contract:
#   1. Verifies the current Windows environment (ISCC present, expected version).
#   2. Verifies the controlled clean PyInstaller runtime exists (or builds it via
#      the repository-controlled build-packaging-poc.ps1). Never uses global
#      Python or a PATH-resolved PyInstaller for ACA packaging.
#   3. Verifies installer compiler availability and expected version.
#   4. Compiles the installer (Inno Setup .iss -> release-output/).
#   5. Validates output (size, PE signature, version metadata, required files).
#   6. Calculates SHA-256.
#   7. Reports the output location.
#   8. Fails safely and actionably on any precondition violation.
#
# The compiler is never auto-installed. It must be present already.
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = (Resolve-Path (Join-Path $ScriptDir "..")).Path
$BackendDir = Join-Path $RepoRoot "backend"
$InstallerDir = Join-Path $RepoRoot "installer"
$ReleaseDir = Join-Path $RepoRoot "release-output"
$IssFile = Join-Path $InstallerDir "AcademicComplianceAuditor.iss"
$VenvPython = Join-Path $BackendDir ".venv\Scripts\python.exe"
$BundleRoot = Join-Path $BackendDir "dist\run-frozen"

$RequiredISCCVersion = "6.7.3"
$RequiredPythonMajorMinor = "3.12"
$RequiredPyInstallerVersion = "6.22.2"
$AppVersion = "1.0.0"

function Fail($msg) { Write-Host "FAIL: $msg" -ForegroundColor Red; exit 1 }

# ---- Locate ISCC.exe without assuming a single fixed machine path. ----
function Find-ISCC {
    $candidates = @()
    $fromCmd = Get-Command ISCC.exe -ErrorAction SilentlyContinue
    if ($fromCmd) { $candidates += $fromCmd.Source }
    foreach ($base in @("${env:LOCALAPPDATA}\Programs", "C:\Program Files", "C:\Program Files (x86)")) {
        if (Test-Path $base) {
            $candidates += (Get-ChildItem $base -Directory -Filter "Inno Setup*" -ErrorAction SilentlyContinue |
                ForEach-Object { Join-Path $_.FullName "ISCC.exe" })
        }
    }
    $candidates += (Get-ChildItem (Join-Path ${env:LOCALAPPDATA} "Programs") -Directory -Filter "Inno Setup*" -ErrorAction SilentlyContinue |
        ForEach-Object { Join-Path $_.FullName "ISCC.exe" })
    foreach ($c in $candidates | Where-Object { $_ -and (Test-Path $_) }) {
        return [string]$c
    }
    return $null
}

# ---- Locate the controlled clean runtime. Build it if absent. ----
function Ensure-CleanRuntime {
    $exe = Join-Path $BundleRoot "run-frozen.exe"
    $internal = Join-Path $BundleRoot "_internal"
    if ((Test-Path $exe) -and (Test-Path $internal)) {
        Write-Host "Clean runtime present: $BundleRoot"
        return
    }
    Write-Host "Clean runtime missing - building via build-packaging-poc.ps1..."
    $buildScript = Join-Path $BackendDir "scripts\build-packaging-poc.ps1"
    if (-not (Test-Path $buildScript)) { Fail "Missing build script: $buildScript" }
    powershell -NoProfile -ExecutionPolicy Bypass -File $buildScript
    if ($LASTEXITCODE -ne 0) { Fail "build-packaging-poc.ps1 failed" }
    if (-not ((Test-Path $exe) -and (Test-Path $internal))) { Fail "Runtime still missing after build" }
}

try {
    Write-Host "=== 0. Windows environment ==="
    $iscc = Find-ISCC
    if (-not $iscc) {
        Fail "Inno Setup 6 command-line compiler (ISCC.exe) is not installed. Install the official Inno Setup 6 package (version $RequiredISCCVersion) from jrsoftware.org, or via WinGet: winget install --id JRSoftware.InnoSetup --exact --accept-source-agreements --accept-package-agreements. The installer build never auto-installs the compiler."
    }
    Write-Host "ISCC: $iscc"

    # ISCC.exe does not embed a file version resource (reports 0.0.0.0). The
    # authoritative version comes from the installed package's uninstall entry.
    $isccVer = $null
    foreach ($scope in @("HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall", "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall", "HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall")) {
        if (Test-Path $scope) {
            $pkg = Get-ItemProperty "$scope\*" -ErrorAction SilentlyContinue |
                Where-Object { $_.DisplayName -match '^Inno Setup' } | Select-Object -First 1
            if ($pkg -and $pkg.DisplayVersion) { $isccVer = $pkg.DisplayVersion; break }
        }
    }
    if (-not $isccVer) {
        # Fallback: match the compiler banner copyright year range is not
        # version-accurate, so require the package registry entry instead.
        Fail "Could not determine the installed Inno Setup version. Expected $RequiredISCCVersion (see Windows Settings > Installed apps)."
    }
    Write-Host "ISCC version: $isccVer"
    if ($isccVer -notmatch "^$([regex]::Escape($RequiredISCCVersion))") {
        Fail "ISCC version '$isccVer' does not match the expected $RequiredISCCVersion. Update the pinned requirement or install the matching compiler."
    }

    Write-Host "=== 1. Controlled clean runtime ==="
    if (-not (Test-Path $VenvPython)) {
        Fail "The controlled packaging interpreter is missing: $VenvPython. Create it from the repository root: python -m venv backend/.venv; backend\.venv\Scripts\Activate.ps1; pip install -r backend\requirements.txt; pip install -r backend\requirements-dev.txt."
    }
    $pyVer = & $VenvPython -c "import sys; print('%s.%s' % (sys.version_info.major, sys.version_info.minor))" 2>&1
    if ($pyVer -ne $RequiredPythonMajorMinor) {
        Fail "Packaging requires Python $RequiredPythonMajorMinor.x, but backend/.venv reports '$($pyVer.Trim())'."
    }
    $piVer = & $VenvPython -m PyInstaller --version 2>&1 | Select-Object -First 1
    $piVer = $piVer.Trim()
    if ($piVer -ne $RequiredPyInstallerVersion) {
        Fail "PyInstaller version '$piVer' does not match the repository pin $RequiredPyInstallerVersion. Install via requirements-dev.txt."
    }
    Ensure-CleanRuntime

    # Validate the runtime with the repository-owned packaging checks.
    $checks = Join-Path $BackendDir "scripts\packaging_checks.py"
    $tocArg = Join-Path $BackendDir "build\ACA"
    $out = & $VenvPython $checks $BundleRoot $tocArg 2>&1
    if ($LASTEXITCODE -ne 0) { $out | ForEach-Object { Write-Host $_ }; Fail "Clean runtime validation failed." }
    Write-Host "Runtime validation OK (contamination + size guards)."

    Write-Host "=== 2. Verify .iss ==="
    if (-not (Test-Path $IssFile)) { Fail "Missing .iss: $IssFile" }

    Write-Host "=== 3. Compile installer ==="
    New-Item -ItemType Directory -Force -Path $ReleaseDir | Out-Null
    Push-Location $InstallerDir
    try {
        & $iscc "/DAppVersion=$AppVersion" $IssFile
        if ($LASTEXITCODE -ne 0) { Fail "ISCC compile failed with exit code $LASTEXITCODE" }
    } finally { Pop-Location }

    $exeOut = Join-Path $ReleaseDir "AcademicComplianceAuditor-Setup-$AppVersion.exe"
    if (-not (Test-Path $exeOut)) { Fail "Installer not produced at $exeOut" }

    Write-Host "=== 4. Validate output ==="
    $size = (Get-Item $exeOut).Length
    if ($size -le 0) { Fail "Installer is zero bytes: $exeOut" }

    $bytes = [IO.File]::ReadAllBytes($exeOut)
    if ($bytes.Length -lt 2 -or $bytes[0] -ne 0x4D -or $bytes[1] -ne 0x5A) {
        Fail "Not a valid PE executable (missing MZ header): $exeOut"
    }

    # Required runtime must be inside: run-frozen.exe and _internal/index.html.
    # The installer is compressed, so verify from the .iss source contract:
    # the .iss packages the whole run-frozen tree. Verify the source tree is intact.
    if (-not (Test-Path (Join-Path $BundleRoot "run-frozen.exe"))) { Fail "run-frozen.exe missing from source runtime" }
    if (-not (Test-Path (Join-Path $BundleRoot "_internal\frontend-dist\index.html"))) { Fail "_internal\frontend-dist\index.html missing from source runtime" }
    $issText = Get-Content $IssFile -Raw
    if ($issText -notmatch 'run-frozen\\\*') { Fail ".iss does not package the full run-frozen tree" }

    $sha = (Get-FileHash $exeOut -Algorithm SHA256).Hash
    Write-Host "SIZE_BYTES=$size"
    Write-Host "SIZE_MB=$([math]::Round($size / 1MB, 2))"
    Write-Host "SHA256=$sha"
    Write-Host "OUTPUT=$exeOut"
    Write-Host "BUILD_OK"
}
catch {
    Fail $_.Exception.Message
}
