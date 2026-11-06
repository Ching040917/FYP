# installer-contract-tests.ps1 - focused contract tests for the ACA Windows
# installer source (the .iss) and its build contract. These verify the SOURCE
# contract; they do not install anything. Install/upgrade/uninstall behavior is
# validated by the isolated harness documented in docs/RELEASE_CHECKLIST.md and
# exercised in the installer build's Phase 8.
$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = (Resolve-Path (Join-Path $ScriptDir "..")).Path
$IssPath = Join-Path $ScriptDir "AcademicComplianceAuditor.iss"
$BuildScript = Join-Path $RepoRoot "scripts\build-installer.ps1"

$failures = [System.Collections.Generic.List[string]]::new()
function Assert($cond, $msg) {
    if (-not $cond) { $failures.Add($msg); Write-Host "FAIL: $msg" -ForegroundColor Red }
    else { Write-Host "ok: $msg" }
}

Write-Host "=== .iss presence ==="
Assert (Test-Path $IssPath) ".iss exists at $IssPath"
$iss = Get-Content $IssPath -Raw

Write-Host "=== Product identity ==="
Assert ($iss.Contains("AppName=Academic Compliance Auditor")) "Product name is 'Academic Compliance Auditor'"
Assert ($iss.Contains("DefaultDirName={localappdata}\Programs\AcademicComplianceAuditor")) "Per-user install path is %LOCALAPPDATA%\Programs\AcademicComplianceAuditor"

Write-Host "=== No invented publisher / no invented version / installer license page ==="
$pubLine = ($iss -split "`r?`n" | Where-Object { $_ -match '^AppPublisher=' } | Select-Object -First 1)
Assert ($pubLine -match '^AppPublisher=\s*$') "AppPublisher is explicitly empty (no invented publisher)"
Assert ($iss.Contains('#define AppVersion "1.0.0"')) "Version 1.0.0 from authoritative source (backend/app/main.py + frontend/package.json)"
Assert ($iss.Contains("LicenseFile=..\LICENSE")) "License page displays root LICENSE"

Write-Host "=== Proprietary distribution terms ==="
$licensePath = Join-Path $RepoRoot "LICENSE"
Assert (Test-Path $licensePath) "Root LICENSE exists"
$lic = Get-Content $licensePath -Raw
Assert ($lic.Contains("All rights reserved")) "LICENSE states all rights reserved"
Assert ($lic.Contains("not an") -and $lic.Contains("open-source license")) "LICENSE states it is not an open-source license"
Assert ($lic.Contains("GitHub's Terms of Service")) "LICENSE preserves the GitHub Terms of Service carve-out"
Assert ($lic.Contains("THIRD_PARTY_NOTICES.md")) "LICENSE references THIRD_PARTY_NOTICES.md"
Assert ($lic.Contains('"AS IS"')) "LICENSE carries AS IS wording"
Assert (-not ($lic -match 'SPDX-License-Identifier')) "LICENSE contains no SPDX identifier"
Assert (-not ($lic -match '(?i)\b(MIT|Apache|GNU General Public|GPL|BSD|MPL|Mozilla Public)\b')) "LICENSE contains no OSI license identifier"
$readme = Get-Content (Join-Path $RepoRoot "README.md") -Raw
Assert (-not $readme.Contains("No project software license has been selected")) "README no longer says no license was selected"
Assert (-not $readme.Contains("distributed privately for evaluation")) "README no longer says distribution is private-only"
Assert ($readme.Contains("authorized release channel")) "README names the authorized release channel"
$notices = Get-Content (Join-Path $RepoRoot "THIRD_PARTY_NOTICES.md") -Raw
Assert ($notices.Contains("proprietary")) "THIRD_PARTY_NOTICES describes ACA as proprietary"
Assert (-not $notices.Contains("Public redistribution remains blocked")) "THIRD_PARTY_NOTICES no longer blocks public distribution pending a decision"
Assert (-not $notices.Contains("already delivered")) "No claim that third-party notices are already delivered in-package"
$buildDoc = Get-Content (Join-Path $RepoRoot "docs\developer\BUILD_AND_RELEASE.md") -Raw
Assert ($buildDoc.Contains("authorized release channel")) "BUILD_AND_RELEASE refers to an authorized release channel"
$installDoc = Get-Content (Join-Path $RepoRoot "docs\INSTALLATION.md") -Raw
Assert (-not $installDoc.Contains("If no checksum was supplied")) "INSTALLATION does not allow skipping checksum verification"
Assert ($installDoc.Contains("authorized release channel")) "INSTALLATION refers to an authorized release channel"

Write-Host "=== Copyright holder consistency ==="
$footerSrc = Get-Content (Join-Path $RepoRoot "frontend\src\components\layout\AppFooter.tsx") -Raw -Encoding UTF8
Assert (-not $footerSrc.Contains("Academic Compliance Systems")) "Footer does not name an unverified copyright holder"
Assert (([regex]::Matches($footerSrc, 'Ching Qing Yang\. All rights reserved\.')).Count -eq 1) "Footer renders the approved copyright line exactly once"
$landingSrc = Get-Content (Join-Path $RepoRoot "frontend\src\pages\Landing.tsx") -Raw -Encoding UTF8
Assert (-not $landingSrc.Contains("Academic Compliance Systems")) "Landing does not name an unverified copyright holder"
Assert (([regex]::Matches($landingSrc, 'Ching Qing Yang\. All rights reserved\.')).Count -eq 1) "Landing renders the approved copyright line exactly once"
$troubleSrc = Get-Content (Join-Path $RepoRoot "docs\TROUBLESHOOTING.md") -Raw -Encoding UTF8
Assert (-not $troubleSrc.Contains("approved evaluation channel")) "TROUBLESHOOTING no longer names an evaluation channel"
Assert (-not $troubleSrc.Contains("If you verified a supplied SHA-256 checksum")) "TROUBLESHOOTING no longer treats checksum verification as optional"
Assert ($troubleSrc.Contains("authorized release channel")) "TROUBLESHOOTING names the authorized release channel"

Write-Host "=== Third-party license and notice delivery contract ==="
Assert ($iss.Contains('Source: "..\LICENSE"; DestDir: "{app}"')) "Installer copies LICENSE to {app}"
Assert ($iss.Contains('Source: "..\THIRD_PARTY_NOTICES.md"; DestDir: "{app}"')) "Installer copies THIRD_PARTY_NOTICES.md to {app}"
Assert ($iss.Contains('Source: "..\licenses\packages\*"; DestDir: "{app}\licenses\packages"')) "Installer copies canonical license tree to {app}\licenses\packages"
$manifestPath = Join-Path $RepoRoot "licenses\packages\MANIFEST.json"
Assert (Test-Path $manifestPath) "Canonical MANIFEST.json exists"
$manifestRaw = Get-Content $manifestPath -Raw -Encoding UTF8
$manifestJson = $manifestRaw | ConvertFrom-Json
Assert ($manifestJson.manifest_version -eq "1.0.0") "Manifest version is 1.0.0"
Assert ($manifestJson.packages.Count -ge 49) "Manifest covers all runtime packages"
$firstPkg = $manifestJson.packages[0]
Assert ($null -ne $firstPkg.package -and $null -ne $firstPkg.files) "Manifest packages have required structure"
$buildInstallerScriptContent = Get-Content $BuildScript -Raw
Assert ($buildInstallerScriptContent.Contains("verify-licenses")) "build-installer.ps1 invokes verify-licenses"
$pocScript = Get-Content (Join-Path $RepoRoot "backend\scripts\build-packaging-poc.ps1") -Raw
Assert ($pocScript.Contains("verify-licenses")) "build-packaging-poc.ps1 invokes verify-licenses"

Write-Host "=== Privileges and architecture ==="
Assert ($iss.Contains("PrivilegesRequired=lowest")) "No administrator rights required (PrivilegesRequired=lowest)"
Assert ($iss.Contains("ArchitecturesAllowed=x64compatible")) "x64 runtime architecture"
Assert ($iss.Contains("ArchitecturesInstallIn64BitMode=x64compatible")) "Install in 64-bit mode"

Write-Host "=== Complete runtime packaging (never run-frozen.exe alone) ==="
Assert ($iss.Contains("Source: ""..\backend\dist\run-frozen\*""; DestDir: ""{app}""; Flags: recursesubdirs ignoreversion createallsubdirs")) ".iss packages the whole run-frozen tree with ignoreversion"
Assert ($iss.Contains("ignoreversion")) "ignoreversion set for upgrade overwrite"

Write-Host "=== Shortcuts ==="
Assert ($iss.Contains("Name: ""{autoprograms}\Academic Compliance Auditor""; Filename: ""{app}\run-frozen.exe""")) "Start Menu shortcut launches the packaged launcher"
Assert ($iss.Contains("Name: ""{autodesktop}\Academic Compliance Auditor""")) "Optional desktop shortcut"
Assert ($iss.Contains("Tasks: desktopicon")) "Desktop shortcut is opt-in via Tasks"
Assert ($iss.Contains('Name: "desktopicon"')) "Desktop icon task defined, unchecked by default"

Write-Host "=== User data preserved on uninstall by default ==="
$activeUninstTasks = $iss -split "`r?`n" | Where-Object { $_ -match '^\[UninstallTasks\]' }
Assert (-not $activeUninstTasks) "No active [UninstallTasks] section (preserve-data policy)"
Assert (-not $iss.Contains("[Code]")) "No [Code] section (no fragile uninstall removal script)"
Assert (-not $iss.Contains("DeleteDirectoryRecursive")) "No recursive data deletion code in the installer"
Assert ($iss.Contains("DefaultDirName={localappdata}\Programs\AcademicComplianceAuditor")) "App installs to %LOCALAPPDATA%\Programs, never the data dir"
Assert ($iss.Contains("uninstall ALWAYS preserves user data")) "Uninstall policy is explicit: user data always preserved"

Write-Host "=== Uninstall entry ==="
Assert ($iss.Contains("UninstallDisplayName=Academic Compliance Auditor")) "Uninstall entry registered in Installed Apps"

Write-Host "=== Single instance of installer ==="
Assert ($iss.Contains("SetupMutex=AcademicComplianceAuditorSetupInstaller")) "Setup mutex (built-in directive) prevents simultaneous installer instances"

Write-Host "=== No forbidden bundling ==="
Assert (-not $iss.Contains("LibreOffice")) "Never bundles LibreOffice"
Assert (-not $iss.Contains("Ollama")) "Never bundles Ollama"
Assert (-not $iss.Contains("qwen3.5")) "Never bundles a model"
Assert (-not $iss.Contains("GEMINI")) "Never bundles cloud-provider credentials"
$filesSection = ($iss -split "`r?`n" | Where-Object { $_ -match '^\[Files\]' } | Select-Object -First 1)
Assert ($null -ne $filesSection) "[Files] section present"
Assert ($iss -match '(?ms)^\[Files\]\s*^Source: "\.\.\\backend\\dist\\run-frozen\\\*"') "Packages only the clean PyInstaller runtime (no db in [Files])"
Assert ($iss.Contains("Source: ""..\backend\dist\run-frozen\*""")) "Packages only the clean PyInstaller runtime"

Write-Host "=== Build contract script ==="
Assert (Test-Path $BuildScript) "build-installer.ps1 exists"
$b = Get-Content $BuildScript -Raw
Assert ($b.Contains("function Find-ISCC")) "Compiler located safely, not via a single hardcoded path"
Assert ($b.Contains('$RequiredISCCVersion = "6.7.3"')) "Compiler version pinned"
Assert ($b.Contains("Scripts\python.exe")) "Controlled backend/.venv interpreter used"
Assert ($b.Contains("PyInstaller")) "PyInstaller pin enforced"
Assert ($b.Contains("packaging_checks.py")) "Runtime validated with repository-owned packaging checks"
Assert ($b.Contains("Get-FileHash")) "SHA-256 computed"
Assert (-not $b.Contains("& winget install")) "Build script never runs winget to install the compiler"
Assert (-not $b.Contains("choco install")) "Build script never auto-installs the compiler"
Assert ($b.Contains("The installer build never auto-installs the compiler.")) "Build script documents manual compiler install only"
Assert ($b.Contains("verify-manifest")) "Build script proves runtime reuse from the input manifest"
Assert ($b.Contains("input-manifest.json")) "Build script locates the release input manifest"
Assert (-not $b.Contains("Clean runtime present")) "Path presence alone is never accepted as provenance"
Assert ($b.Contains("=== 4b. Runtime/manifest parity after compile ===")) "Build script re-verifies parity after ISCC compilation"
Assert ($b.Contains("hygiene")) "Installer build invokes the hygiene gate"
Assert ($b.Contains("verify-inventory")) "Installer build verifies the delivered-file inventory"
Assert ($b.Contains("file-inventory.json")) "Installer build locates the delivered-file inventory"
$poc = Get-Content (Join-Path $RepoRoot "backend\scripts\build-packaging-poc.ps1") -Raw
Assert ($poc.Contains("inventory")) "POC build generates and verifies the delivered-file inventory"

Write-Host "=== Branding ==="
$icoPath = Join-Path $RepoRoot "assets\branding\aca-icon.ico"
Assert (Test-Path $icoPath) "Generated multi-resolution ICO exists"
$srcPng = Join-Path $RepoRoot "assets\branding\aca-icon-source.png"
Assert (Test-Path $srcPng) "Branding source PNG preserved"
$src = & (Join-Path $RepoRoot "backend\.venv\Scripts\python.exe") -c "
from PIL import Image
import struct
ico = Image.open(r'$icoPath')
sizes = sorted(ico.info.get('sizes'))
required = {(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)}
print('ICO_OK' if required.issubset(set(sizes)) else 'ICO_BAD')
data = open(r'$icoPath','rb').read()
reserved, ico_type, count = struct.unpack('<HHH', data[:6])
print('COUNT=%d' % count)
"
Assert ($src -match "ICO_OK") "ICO contains all 7 required resolutions (16-256)"
Assert ($src -match "COUNT=7") "ICO has exactly 7 entries"
Assert ($iss.Contains("SetupIconFile=..\assets\branding\aca-icon.ico")) "Setup EXE uses ACA icon"
Assert ($iss.Contains("WizardSmallImageFile=..\assets\branding\aca-icon-wizard.bmp")) "Installer wizard uses ACA icon (32x32 BMP required by Inno)"
Assert ($iss.Contains("UninstallDisplayIcon={app}\run-frozen.exe")) "Installed Apps entry uses the ACA icon"
Assert ($iss.Contains('IconFilename: "{app}\run-frozen.exe"')) "Shortcuts explicitly use the icon-embedded launcher"
$spec = Get-Content (Join-Path $RepoRoot "backend\ACA.spec") -Raw
Assert ($spec.Contains("icon='../assets/branding/aca-icon.ico'")) "PyInstaller embeds the ACA icon in run-frozen.exe"
$favHtml = Get-Content (Join-Path $RepoRoot "frontend\index.html") -Raw
Assert ($favHtml.Contains('/assets/favicon.ico')) "Browser favicon references /assets/favicon.ico"
$favFile = Join-Path $RepoRoot "frontend\public\assets\favicon.ico"
Assert (Test-Path $favFile) "Favicon asset exists in frontend public assets"

Write-Host "=== Release output location ==="
$gi = Get-Content (Join-Path $RepoRoot ".gitignore") -Raw
Assert ($gi.Contains("release-output/")) "release-output/ is gitignored"

Write-Host "=== Release input manifest gate ==="
$poc = Get-Content (Join-Path $RepoRoot "backend\scripts\build-packaging-poc.ps1") -Raw
Assert ($poc.Contains("packaging_checks.py") -and $poc.Contains("manifest")) "POC build generates the release input manifest"
Assert ($poc.Contains("verify-manifest")) "POC build verifies the manifest it just wrote"
$pc = Get-Content (Join-Path $RepoRoot "backend\scripts\packaging_checks.py") -Raw
Assert ($pc.Contains("MANIFEST_SCHEMA_VERSION")) "Manifest schema version is declared in packaging_checks.py"

Write-Host "=== Packaging hygiene gate ==="
$iss = Get-Content $IssPath -Raw
Assert ($iss -match 'Excludes: "') "Recursive [Files] entry declares sensitive-file exclusions"
$excludesLine = ($iss -split "`r?`n" | Where-Object { $_ -match '^Source:.*Excludes:' } | Select-Object -First 1)
Assert ($null -ne $excludesLine) "Excludes is declared on the recursive [Files] source entry"
Assert ($excludesLine.Contains("__pycache__\*")) "Bytecode cache directories are excluded"
Assert ($excludesLine.Contains("*.pyc")) "Bytecode files are excluded"
Assert ($excludesLine.Contains(".env.*")) "Environment files are excluded"
Assert ($excludesLine -notmatch '\*\.docx') "No blanket *.docx exclusion (sample + template are product content)"
Assert ($excludesLine -notmatch '\*\.pem') "No blanket *.pem exclusion (certifi CA bundle is required)"
$poc = Get-Content (Join-Path $RepoRoot "backend\scripts\build-packaging-poc.ps1") -Raw
Assert ($poc.Contains('"hygiene"')) "POC build runs the hygiene gate"
Assert ($poc.Contains('"inventory"')) "POC build generates the inventory"
Assert ($poc.Contains('"verify-inventory"')) "POC build verifies the inventory"

if ($failures.Count -gt 0) {
    Write-Host "`nCONTRACT_TEST_FAILURES=$($failures.Count)" -ForegroundColor Red
    exit 1
}
Write-Host "`nCONTRACT_TESTS_OK"
exit 0
