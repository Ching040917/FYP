# validate-installer.ps1 - isolated lifecycle validation for the ACA Windows
# installer. Runs entirely against a temporary LOCALAPPDATA so the developer's
# real %LOCALAPPDATA%\AcademicComplianceAuditor is never touched.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File installer/validate-installer.ps1 `
#       -Installer <path-to-AcademicComplianceAuditor-Setup-1.0.0.exe>
#
# Covers: silent per-user install, complete runtime, registry entry, first
# launch (loopback, port range, dashboard, DB head), second-launch reuse,
# deterministic audit without LibreOffice/Ollama, PDF export, close/reopen
# history, uninstall data preservation, and reinstall history preservation.
param(
    [Parameter(Mandatory = $true)][string]$Installer,
    [string]$IsolationRoot = ""
)
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$RepoRoot = (Resolve-Path (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "..")).Path
$VenvPython = Join-Path $RepoRoot "backend\.venv\Scripts\python.exe"

if (-not $IsolationRoot) { $IsolationRoot = Join-Path $env:TEMP ("aca_validation_" + [guid]::NewGuid().ToString("N")) }
$DataRoot = Join-Path $IsolationRoot "LocalAppData"
New-Item -ItemType Directory -Force -Path $DataRoot | Out-Null

$results = [System.Collections.Generic.List[object]]::new()
function Check($name, $ok, $detail) {
    $results.Add([pscustomobject]@{ Test = $name; Pass = $ok; Detail = $detail })
    $mark = if ($ok) { "PASS" } else { "FAIL" }
    Write-Host ("[{0}] {1}: {2}" -f $mark, $name, $detail) -ForegroundColor $(if ($ok) { "Green" } else { "Red" })
}

$oldLocalAppData = $env:LOCALAPPDATA
$env:LOCALAPPDATA = $DataRoot
$installDir = Join-Path $IsolationRoot "Programs\AcademicComplianceAuditor"
$exePath = Join-Path $installDir "run-frozen.exe"
$internal = Join-Path $installDir "_internal"
$dbPath = Join-Path $DataRoot "AcademicComplianceAuditor\audit.db"
$regPath = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\{013b1759-4db0-452b-af6f-e7a17d4b60e4}_is1"

function Stop-ACA {
    Get-Process run-frozen -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep 3
}
function Wait-Health([int]$MaxSec = 30) {
    for ($i = 0; $i -lt $MaxSec; $i++) {
        Start-Sleep 1
        for ($pp = 8010; $pp -le 8015; $pp++) {
            try { $h = Invoke-RestMethod "http://127.0.0.1:$pp/health" -TimeoutSec 1; if ($h.status -eq "healthy") { return $pp } } catch {}
        }
    }
    return 0
}
function Get-DbHead {
    if (-not (Test-Path $dbPath)) { return "" }
    $py = "import sqlite3`ncon=sqlite3.connect(r'$dbPath')`nprint(con.execute('select version_num from alembic_version').fetchone()[0])`n"
    $pf = Join-Path $IsolationRoot "head.py"
    Set-Content -Path $pf -Value $py -Encoding ASCII
    $oldEAP = $ErrorActionPreference; $ErrorActionPreference = "Continue"
    $out = & $VenvPython $pf 2>&1 | ForEach-Object { "$_" }
    $ErrorActionPreference = $oldEAP
    $last = $null
    foreach ($l in @($out)) { if ($l -and $l.Trim()) { $last = $l.Trim() } }
    return $last
}

Write-Host "Installer: $Installer"
Write-Host "IsolationRoot: $IsolationRoot"

Write-Host "`n=== Install (silent, isolated) ==="
$p = Start-Process -FilePath $Installer -ArgumentList "/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /DIR=`"$installDir`" /LOG=`"$IsolationRoot\install.log`" /CURRENTUSER" -Wait -PassThru
Check "Install exit code" ($p.ExitCode -eq 0) "Exit code = $($p.ExitCode)"
Check "run-frozen.exe installed" (Test-Path $exePath) $exePath
Check "_internal installed" (Test-Path $internal) $internal
Check "frontend-dist index.html installed" (Test-Path (Join-Path $internal "frontend-dist\index.html")) "frontend present"
Check "alembic bundled" (Test-Path (Join-Path $internal "alembic\versions")) "alembic/versions present"
$allFiles = @(Get-ChildItem $installDir -Recurse -File)
$forbidden = $allFiles | Where-Object { $_.Name -match "numpy|pandas|scipy|matplotlib|pyarrow|ollama" } | Select-Object -First 5
Check "No forbidden packages" (-not $forbidden) "no numpy/pandas/scipy/matplotlib/pyarrow/ollama"
$devSrc = $allFiles | Where-Object { $_.FullName -match "\\(backend\\app|frontend\\src)\\" } | Select-Object -First 1
Check "No developer source trees" (-not $devSrc) "no backend/app or frontend/src"
$reg = Get-ItemProperty $regPath -ErrorAction SilentlyContinue
Check "Uninstall registry entry" ($null -ne $reg) "HKCU uninstall key exists"
if ($reg) { Check "Display name/version" ($reg.DisplayName -eq "Academic Compliance Auditor" -and $reg.DisplayVersion -eq "1.0.0") "$($reg.DisplayName) $($reg.DisplayVersion)" }

Write-Host "`n=== First launch ==="
$env:ACA_DISABLE_BROWSER = "1"
$env:ACA_BROWSER_RECORD_FILE = Join-Path $IsolationRoot "browser.txt"
$launch = Start-Process -FilePath $exePath -WorkingDirectory $installDir -PassThru -WindowStyle Hidden
$port = Wait-Health
Check "First launch health" ($port -gt 0) "port $port"
if ($port -gt 0) {
    $listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    Check "Binds only 127.0.0.1" (-not ($listener | Where-Object { $_.LocalAddress -ne "127.0.0.1" })) "loopback only"
    Check "Port in 8010-8015" ($port -ge 8010 -and $port -le 8015) "port $port"
    $dash = Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$port/dashboard" -TimeoutSec 5
    Check "Dashboard loads" ($dash.StatusCode -eq 200) "status $($dash.StatusCode)"
}
Check "audit.db created" (Test-Path $dbPath) $dbPath
Check "DB at alembic head 90fc17718e11" ((Get-DbHead) -eq "90fc17718e11") "head=$(Get-DbHead)"

Write-Host "`n=== Second launch reuse ==="
$before = @(Get-Process run-frozen -ErrorAction SilentlyContinue).Count
$env:ACA_BROWSER_RECORD_FILE = Join-Path $IsolationRoot "browser2.txt"
$p2 = Start-Process -FilePath $exePath -WorkingDirectory $installDir -PassThru -WindowStyle Hidden
Start-Sleep 8
$after = @(Get-Process run-frozen -ErrorAction SilentlyContinue).Count
Check "No duplicate backend" ($after -le $before) "before=$before after=$after"
Check "Second launcher exits" $p2.HasExited "HasExited=$($p2.HasExited)"

Write-Host "`n=== Deterministic audit (no LibreOffice/Ollama) ==="
$sample = Join-Path $internal "frontend-dist\samples\sample-thesis.docx"
$auditOut = Join-Path $IsolationRoot "audit.json"
& curl.exe -s -X POST "http://127.0.0.1:$port/api/audit" -F "file=@$sample" -o $auditOut
$auditId = ""
if ($LASTEXITCODE -eq 0 -and (Test-Path $auditOut)) {
    $ar = Get-Content $auditOut -Raw | ConvertFrom-Json
    if ($ar.audit_id) { $auditId = $ar.audit_id }
    Check "Audit completes" ($ar.audit_id -and $null -ne $ar.weighted_compliance_score) "score=$($ar.weighted_compliance_score)"
    Check "Findings present" (@($ar.physical_layout_errors).Count -gt 0) "$(@($ar.physical_layout_errors).Count) findings"
}

Write-Host "`n=== Close launcher ==="
try { Stop-Process -Id $launch.Id -Force -ErrorAction SilentlyContinue } catch {}
Start-Sleep 4
$portFree = $true
try { $null = Invoke-RestMethod "http://127.0.0.1:$port/health" -TimeoutSec 1; $portFree = $false } catch {}
Check "Backend terminates on close" $portFree "port released"
Stop-ACA
Check "No ACA process remains" (@(Get-Process run-frozen -ErrorAction SilentlyContinue).Count -eq 0) "0 processes"

Write-Host "`n=== Reopen (history persists) ==="
$env:ACA_BROWSER_RECORD_FILE = Join-Path $IsolationRoot "browser3.txt"
$launch3 = Start-Process -FilePath $exePath -WorkingDirectory $installDir -PassThru -WindowStyle Hidden
$port3 = Wait-Health
Check "Reopen health" ($port3 -gt 0) "port $port3"
if ($port3 -gt 0) {
    $hist = Invoke-RestMethod "http://127.0.0.1:$port3/api/audits" -TimeoutSec 10
    Check "History persists after restart" (@($hist).Count -ge 1) "$(@($hist).Count) audits"
    if ($auditId) {
        $pdf = Join-Path $IsolationRoot "report.pdf"
        & curl.exe -s -X GET "http://127.0.0.1:$port3/api/audit/$auditId/export-pdf" -o $pdf
        Check "PDF export works" ((Test-Path $pdf) -and (Get-Item $pdf).Length -gt 1000) "pdf bytes=$((Get-Item $pdf).Length)"
    }
}
try { Stop-Process -Id $launch3.Id -Force -ErrorAction SilentlyContinue } catch {}
Stop-ACA

Write-Host "`n=== Uninstall (data preserved by default) ==="
$dbBytesBefore = if (Test-Path $dbPath) { (Get-Item $dbPath).Length } else { 0 }
$uninst = Join-Path $installDir "unins000.exe"
if (-not (Test-Path $uninst)) { $uninst = (Get-ChildItem $IsolationRoot -Filter "unins*.exe" -Recurse | Select-Object -First 1).FullName }
Check "Uninstaller exists" (Test-Path $uninst) $uninst
if (Test-Path $uninst) {
    $u = Start-Process -FilePath $uninst -ArgumentList "/VERYSILENT /SUPPRESSMSGBOXES /NORESTART" -Wait -PassThru
    Check "Uninstall exit code" ($u.ExitCode -eq 0) "exit $($u.ExitCode)"
}
Check "Program files removed" (-not (Test-Path $exePath)) "run-frozen.exe gone"
Check "User data preserved" (Test-Path $dbPath) "audit.db still present"
if (Test-Path $dbPath) { Check "DB bytes preserved" ((Get-Item $dbPath).Length -ge $dbBytesBefore) "bytes intact" }
Check "Uninstall entry removed" ($null -eq (Get-ItemProperty $regPath -ErrorAction SilentlyContinue)) "registry key gone"

Write-Host "`n=== Reinstall (history readable) ==="
$p4 = Start-Process -FilePath $Installer -ArgumentList "/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /DIR=`"$installDir`" /CURRENTUSER" -Wait -PassThru
Check "Reinstall exit code" ($p4.ExitCode -eq 0) "exit $($p4.ExitCode)"
Check "Reinstall restores run-frozen.exe" (Test-Path $exePath) $exePath
Check "Reinstall preserves audit.db" (Test-Path $dbPath) $dbPath

# Cleanup
Stop-ACA
$env:LOCALAPPDATA = $oldLocalAppData
Remove-Item Env:\ACA_DISABLE_BROWSER -ErrorAction SilentlyContinue
Remove-Item Env:\ACA_BROWSER_RECORD_FILE -ErrorAction SilentlyContinue
Remove-Item $regPath -Recurse -ErrorAction SilentlyContinue

Write-Host "`n=== Summary ==="
$fails = @($results | Where-Object { -not $_.Pass })
$results | ForEach-Object { Write-Host ("{0}  {1}  {2}" -f $(if ($_.Pass) {"PASS"} else {"FAIL"}), $_.Test, $_.Detail) }
Write-Host "`nTOTAL=$($results.Count) PASS=$($results.Count - $fails.Count) FAIL=$($fails.Count)"
if ($fails.Count -gt 0) { exit 1 } else { exit 0 }
