# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller one-folder spec — ACA Packaging Phase 1 PoC.

Build (from backend/):
    pip install pyinstaller
    pyinstaller --noconfirm ACA.spec

Output: dist-frozen/run-frozen/  (one-folder; launcher = run-frozen.exe)

Hidden imports are added ONLY when a controlled build/runtime failure proves
them necessary — do not pre-populate this list.
"""

block_cipher = None

a = Analysis(
    ['frozen_main.py'],
    pathex=['.'],
    binaries=[],
    datas=[
        # Production Frontend assets (built via: cd ../frontend && npm run build)
        ('../frontend/dist', 'frontend-dist'),
        # Alembic scripts bundled as inspectable data for later phases.
        ('alembic', 'alembic'),
        ('alembic.ini', '.'),
        # Bundled sample for the Try-with-sample workflow.
        ('../frontend/public/samples/sample-thesis.docx', 'frontend-dist/samples'),
    ],
    hiddenimports=[],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        # Not needed in the frozen Backend.
        'tkinter',
        'pytest',
        'IPython',
        'jupyter',
    ],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='run-frozen',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon='../assets/branding/aca-icon.ico',
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name='run-frozen',
)
