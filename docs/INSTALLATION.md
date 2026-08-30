# Installing Academic Compliance Auditor

This guide is for ordinary Windows users installing the packaged ACA application. If you are a developer or evaluator working from source code, see [Developer Setup](developer/DEVELOPER_SETUP.md) instead.

## 1. Before You Start

- ACA runs on Windows 10 or 11 (desktop or laptop). Mobile devices are not supported.
- You do **not** need Python or Node.js — everything ACA needs is inside the installer.
- No administrator rights are required. ACA installs for your Windows user account only.
- ACA works offline for all core checks. Two optional extras (LibreOffice and Ollama) can be added later — see *Optional Features* below.
- The installer is **unsigned**, so Windows may show a security warning the first time you run it. This is expected — see *Windows displays a security warning* in [Troubleshooting](TROUBLESHOOTING.md).

## 2. Get the Installer

ACA is currently **distributed privately for evaluation**. There is no public download page.

You receive the installer from:

- the project owner, or
- the approved university submission or evaluation channel.

The file is named `AcademicComplianceAuditor-Setup-1.0.0.exe`. Do not download ACA from any other website — no official public download exists.

## 3. Verify a Supplied SHA-256 Checksum

If the person who gave you the installer also supplied a SHA-256 checksum, you can verify your copy matches. Every rebuild of the installer produces a new checksum, so only trust a checksum given to you together with the installer.

1. Press **Start**, type `powershell`, and open **Windows PowerShell**.
2. Run (adjust the path to where you saved the installer):

   ```powershell
   Get-FileHash "C:\Users\Public\Downloads\AcademicComplianceAuditor-Setup-1.0.0.exe" -Algorithm SHA256
   ```

3. Compare the `SHA256` value shown with the checksum you were given. If they match (ignoring upper/lower case), the file is intact. If they differ, do not run the installer — ask the provider for a fresh copy.

If no checksum was supplied, you may skip this step.

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

Two optional components add features but are never required. Deterministic audits work fully without them, and ACA **never downloads or installs third-party software automatically** — you stay in control.

- **LibreOffice** — enables rendered-page previews and original-document page locations. When it is missing, the Dashboard's **System Readiness** card offers **Download LibreOffice**, which opens the official LibreOffice website. Install it yourself, then click **Check again**.
- **Ollama** — enables optional local AI citation guidance. When it is missing, the card offers **Download Ollama**. When Ollama is installed but its model is missing, the card shows a **Copy installation command** button that copies the exact `ollama pull` command for you to run in your own terminal.

After installing anything, use **Check again** in the System Readiness card — no restart needed. See the [User Guide](USER_GUIDE.md) for details.

## 7. Update ACA

There is **no automatic updater**. When the project owner provides a newer installer, simply run it the same way — it updates the application in place and keeps your audit history.

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

This folder contains your audit history database, database backups, rendered page previews, and logs. The original DOCX files you audit are **not** stored — they are processed in memory and discarded (see [Privacy](PRIVACY.md)).

To permanently remove all local data, delete this folder **after** uninstalling. Back it up first if you might need your history later.

## 10. Get Help

- Common problems: [Troubleshooting](TROUBLESHOOTING.md)
- How your data is handled: [Privacy](PRIVACY.md)
- What ACA does and does not support: [Known Limitations](KNOWN_LIMITATIONS.md)
- Day-to-day usage: [User Guide](USER_GUIDE.md)

For anything else, contact the project owner through your evaluation channel.
