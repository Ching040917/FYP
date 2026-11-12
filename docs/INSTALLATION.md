# Installing Academic Compliance Auditor

This guide is for ordinary Windows users installing the packaged ACA application. If you are a developer or evaluator working from source code, see [Developer Setup](developer/DEVELOPER_SETUP.md) instead.

## 1. Before You Start

- ACA runs on Windows 10 or 11 (desktop or laptop). Mobile devices are not supported.
- You do **not** need Python or Node.js — everything ACA needs is inside the installer.
- No administrator rights are required. ACA installs for your Windows user account only.
- ACA works offline for all core checks. Two optional extras (LibreOffice and Ollama) can be added later — see *Optional Features* below.
- The installer is **unsigned**, so Windows may show a security warning the first time you run it. This is expected — see *Windows displays a security warning* in [Troubleshooting](TROUBLESHOOTING.md).

## 2. Get the Installer

Official ACA installers are provided through an authorized release channel for controlled evaluation and release-candidate validation. An unsigned build is not a public release and must not be distributed publicly; a signed build is required before any public distribution. Obtain ACA only through an authorized release channel, and verify its published SHA-256 before running it.

The file is named `AcademicComplianceAuditor-Setup-1.0.0.exe`. Do not run an installer obtained from anywhere else.

## 3. Verify the Published SHA-256 Checksum

Every official installer release is published with its SHA-256 checksum. Verify your copy before running it. Every rebuild produces a new checksum, so only trust a checksum published together with that exact installer.

1. Press **Start**, type `powershell`, and open **Windows PowerShell**.
2. Run (adjust the path to where you saved the installer):

   ```powershell
   Get-FileHash "C:\Users\Public\Downloads\AcademicComplianceAuditor-Setup-1.0.0.exe" -Algorithm SHA256
   ```

3. Compare the `SHA256` value shown with the published checksum for that installer. If they match (ignoring upper/lower case), your copy matches the published artifact. If they differ, do not run the installer — obtain a fresh copy through the authorized release channel.

A matching checksum shows your copy is the build that was published. It is not a security guarantee on its own, and the installer is unsigned.

## 4. Install ACA

1. Double-click `AcademicComplianceAuditor-Setup-1.0.0.exe`.
2. If Windows shows an *Unknown publisher* or SmartScreen warning, see [Troubleshooting](TROUBLESHOOTING.md) — you do not need to disable any Windows security feature.
3. Follow the wizard. The default settings are correct for most users:
   - ACA installs per-user (no administrator rights), to
     `%LOCALAPPDATA%\Programs\AcademicComplianceAuditor`.
   - A **Start Menu shortcut** is always created. An optional desktop shortcut can be selected if you want one.
4. The Finish page offers to launch ACA immediately — or start it any time from the Start Menu.

## 5. Start ACA

- Open **ACA** from the **Windows Start Menu** (look for *Academic Compliance Auditor*). A desktop shortcut also works if you created one.
- After a short start-up, your web browser opens automatically at ACA's Dashboard. ACA uses the browser Windows already uses as default — if Edge is your default browser, Edge opens.
- Starting ACA a second time while it is already running reuses the running instance instead of starting a duplicate.
- Closing the ACA window stops ACA cleanly. Closing your browser does not stop ACA — close the ACA application window when you are finished.

## 6. Optional Features

Two optional components add features but are never required. Deterministic audits work fully without them, and ACA never installs third-party software: you stay in control.

- **LibreOffice** — enables optional local PDF page previews and physical page mapping for new validated audits. Conversion uses a current-user-only temporary DOCX and isolated profile, removed before the rendered PDF is accepted; the original is not retained as a source file. Extracted-text evidence remains available if rendering fails. When LibreOffice is missing, the Dashboard's **System Readiness** card offers **Download LibreOffice**, which opens the official LibreOffice website. Install it yourself, then click **Check again**.
- **Ollama** — enables optional **Local AI Citation Guidance** (APA 7 in-text citation formatting suggestions only), and is not required for deterministic document auditing, formatting findings, extracted-text preview, Guided Fixes, PDF report export, or Audit History. When Ollama is missing, the card offers **Download Ollama**. When Ollama is installed but its model is missing, the card offers **Download optional model**, which asks your own Ollama service to fetch that model — only after you confirm in a dialog. The download needs an internet connection, several gigabytes of storage, and may take time. **Copy installation command** remains available if you prefer to run `ollama pull` yourself.

ACA cannot reliably stop an Ollama model download once it has started, so there is no Cancel button; closing the progress view may leave Ollama downloading in the background.

### Removing the model

ACA v1.0.0 has no in-app model-delete control, and it never stops, uninstalls or otherwise controls the Ollama service. Remove the model yourself with Ollama — for example `ollama rm <model>` in your own terminal, or through Ollama's own interface. Ollama model storage may be shared with other applications and other Windows users on this computer, and removing a model can affect anything else that relies on it, so check what else uses the model before deleting it. ACA never deletes models automatically or in the background.

After installing anything, use **Check again** in the System Readiness card — no restart needed. See the [User Guide](USER_GUIDE.md) for details.

## 7. Update ACA

There is **no automatic updater** for the application itself. When the project owner provides a newer installer, run it the same way — it updates the application in place and keeps your audit history.

The **audit database** is different: the packaged launcher upgrades an existing, eligible audit database automatically when ACA starts. It publishes a verified backup first, and when the state is unsafe or ambiguous it refuses to start rather than creating a replacement database, so your existing data is preserved.

## 8. Uninstall ACA

1. Open **Settings > Apps > Installed apps** (Windows 10: *Apps & features*).
2. Find **Academic Compliance Auditor** and choose **Uninstall**.
3. Program files and shortcuts are removed.

**Your audit history is preserved by default.** Uninstalling does not delete your local ACA data. See the next section if you want to remove that too.

## 9. Where ACA Stores Data

All ACA data is stored locally in your user profile:

```
%LOCALAPPDATA%\AcademicComplianceAuditor\
```

This folder contains your audit history database, database backups, rendered page previews, and logs. Original DOCX files are **not retained as source files**. Optional local rendering uses a protected temporary copy, which must be deleted before conversion succeeds; abnormal shutdown or cleanup failure can leave temporary data (see [Privacy](PRIVACY.md)).

To permanently remove all local data, delete this folder **after** uninstalling. Back it up first if you might need your history later.

## 10. Get Help

- Common problems: [Troubleshooting](TROUBLESHOOTING.md)
- How your data is handled: [Privacy](PRIVACY.md)
- What ACA does and does not support: [Known Limitations](KNOWN_LIMITATIONS.md)
- Day-to-day usage: [User Guide](USER_GUIDE.md)

For anything else, contact the project owner through the authorized release channel.
