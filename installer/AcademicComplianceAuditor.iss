; Academic Compliance Auditor - Windows installer (Inno Setup 6)
;
; Build is reproducible and must be driven by scripts/build-installer.ps1 so
; the compiler version, the clean PyInstaller runtime, and the authoritative
; version are all verified before ISCC runs. Do not invoke ISCC directly.
;
; Product identity (verified, not invented):
;   Product name : Academic Compliance Auditor
;   Version      : 1.0.0  (authoritative source: backend/app/main.py FastAPI
;                          version + frontend/package.json version)
;   Publisher    : none documented in the repository - intentionally omitted.
;   License      : all rights reserved (no project license selected).
;   Code signing : not applied - no signing certificate is supplied.
;
; Install model:
;   Per-user, no administrator rights (PrivilegesRequired=lowest).
;   %LOCALAPPDATA%\Programs\AcademicComplianceAuditor - application files only.
;   Mutable user data stays at %LOCALAPPDATA%\AcademicComplianceAuditor and is
;   never touched by install/upgrade. Uninstall preserves it by default.

#ifndef AppVersion
  #define AppVersion "1.0.0"
#endif

[Setup]
; Stable application identity for upgrades. Never regenerate per build.
; This is a fixed AppId, not a per-build value. The doubled "{{" is Inno's
; escape for a literal "{" in the AppId value.
AppId={{013b1759-4db0-452b-af6f-e7a17d4b60e4}
AppName=Academic Compliance Auditor
AppVersion={#AppVersion}
AppVerName=Academic Compliance Auditor {#AppVersion}
AppPublisher=
DefaultDirName={localappdata}\Programs\AcademicComplianceAuditor
DefaultGroupName=Academic Compliance Auditor
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=..\release-output
OutputBaseFilename=AcademicComplianceAuditor-Setup-{#AppVersion}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
SetupLogging=yes
SetupMutex=AcademicComplianceAuditorSetupInstaller
UninstallDisplayName=Academic Compliance Auditor
; ACA icon: Setup EXE + installer wizard; shortcuts and the Installed Apps
; entry inherit it through [Icons] and UninstallDisplayIcon.
SetupIconFile=..\assets\branding\aca-icon.ico
WizardSmallImageFile=..\assets\branding\aca-icon-wizard.bmp
UninstallDisplayIcon={app}\run-frozen.exe
VersionInfoVersion={#AppVersion}
VersionInfoProductName=Academic Compliance Auditor
VersionInfoProductVersion={#AppVersion}
VersionInfoTextVersion={#AppVersion}

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

; Optional desktop shortcut - OFF by default. The Start Menu shortcut is
; always created.
[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; GroupDescription: "Additional icons:"; Flags: unchecked

; The complete verified PyInstaller one-folder tree is packaged whole.
; run-frozen.exe and _internal must stay together; never package the launcher
; alone. ignoreversion is required so an in-place upgrade overwrites files.
[Files]
Source: "..\backend\dist\run-frozen\*"; DestDir: "{app}"; Flags: recursesubdirs ignoreversion createallsubdirs

[Icons]
Name: "{autoprograms}\Academic Compliance Auditor"; Filename: "{app}\run-frozen.exe"; WorkingDir: "{app}"; IconFilename: "{app}\run-frozen.exe"; Comment: "Launch Academic Compliance Auditor"
Name: "{autodesktop}\Academic Compliance Auditor"; Filename: "{app}\run-frozen.exe"; WorkingDir: "{app}"; IconFilename: "{app}\run-frozen.exe"; Tasks: desktopicon; Comment: "Launch Academic Compliance Auditor"

; Launch ACA from the Finish page (checkbox, checked by default). Skipped in
; silent installs. Launches the packaged launcher only.
[Run]
Filename: "{app}\run-frozen.exe"; Description: "Launch Academic Compliance Auditor"; WorkingDir: "{app}"; Flags: nowait postinstall skipifsilent

; ---------------------------------------------------------------------------
; Uninstall user-data policy.
;
; Inno Setup 6 provides no supported Pascal Script API to read the
; [UninstallTasks] selection state inside the uninstaller
; (WizardIsTaskSelected is sfNoUninstall and cannot be called during
; uninstall). Because safe optional data removal cannot be implemented
; reliably, uninstall ALWAYS preserves user data:
;
;   %LOCALAPPDATA%\AcademicComplianceAuditor\  (audit.db, backups\,
;   rendered-previews\, logs\, tmp\) is never touched by the uninstaller.
;
; The installer also never writes to that directory. Manual cleanup of the
; data directory (after uninstall) is documented in
; docs/END_USER_INSTALLATION_TEST.md and docs/INSTALLATION.md.
;
; Removing program files and shortcuts is handled by Inno automatically.
; ---------------------------------------------------------------------------
