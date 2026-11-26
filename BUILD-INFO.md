# Kiro Update Checker — TEST BUILD 0.5.3-test.2

**Test build only. Not published to Open VSX. Not a public release.**

## Why test.2 exists (source-verified root cause)

The Windows auto-update failure is a **Kiro ↔ Microsoft inno-updater integration bug**, not antivirus:

1. Kiro's Windows `product.json` does **not** set `win32VersionedUpdate` (verified on the local 1.4.215 install).
2. VS Code's `build/gulpfile.vscode.win32.ts` (1.131.0) does:
   ```ts
   const useVersionedUpdate = product.win32VersionedUpdate;
   const versionedResourcesFolder = useVersionedUpdate ? commit.substring(0, 10) : '';
   ```
   So Kiro's installer is built with `VersionedResourcesFolder=''` → its background setup stages the app in `{app}\_`, not `new_Kiro.exe`.
3. `microsoft/inno-updater` PR #78 (commit `04da21f`, merged 2026-09-18, version **0.26.0**) removed the legacy `_` fallback. Before:
   ```
   New executable not found: ..., using traditional update method
   do_update(log, code_path, update_folder_name)?; // "_"
   ```
   After:
   ```rust
   return Err(NotFound("New executable not found: ..."));
   ```
4. Kiro 1.4.215 ships `tools/inno_updater.exe` **0.26.0**, ProductVersion `04da21f70a` — the exact commit that removed `_` support.
5. Kiro 1.5.44/1.5.49 setups are still non-versioned (their background staging is `_`). Kiro's 1.4/1.5 changelogs do not mention an updater fix.
6. Upstream explicitly declined to restore the legacy path (VSCodium asked in PR #78; Microsoft: "maintenance burden for a path that we don't use"). Other non-versioned VS Code forks (VSCodium, Kodia) report the same failure.

**Conclusion:** every non-versioned Kiro Windows install cannot use the native background `/update` + `inno_updater` flow. The correct extension behavior is to avoid it: detect the `_` staging, cancel the background setup, and run the standard silent installer **after Kiro exits** (no `/update`, no `inno_updater`). This is what the extension now does. Versioned setups (`new_<exe>`) still use the restart flow.

## What changed in test.2 vs test.1

- test.1 wrongly required the **versioned layout** in the capability test, so it rejected the normal non-versioned user install (your local machine) with:
  ```
  Ignoring autoInstall: The installation is not using the versioned update layout.
  ```
- test.2 removes that requirement. A standard Inno user install (non-versioned) is now supported; system-wide, non-Inno, unwritable and previously failed installs are still rejected.
- The standard-install-after-quit path is unchanged and already validated end-to-end (1.1.70 → 1.5.44/1.5.49 sandbox, exit 0, zero `inno_updater` logs).

## Tests

- Windows: **100 tests passing** (compile + lint clean).
- **Real machine validated:** local Kiro **1.4.215 non-versioned → 1.5.49** using this VSIX.
  - `Setup used the non-versioned staging layout; switching to the standard silent install.`
  - VBS log: `installer exited with 0`
  - **Zero `inno_updater` logs**.
  - Next session: `Cleared pending update state (now on 1.5.49)`; comparison result 0.
- Linux: 98 passing, 3 pending (Windows-only), from test.1; the capability change is platform-independent and covered by the unit matrix.

## Kiro 1.5.49 still ships the broken updater

After the update, Kiro 1.5.49 still has:
- `tools/inno_updater.exe` **0.26.0** (`ProductVersion 04da21f70a`)
- `win32VersionedUpdate` **absent** (still non-versioned)

So the native background `/update` path remains broken in 1.5.49. This extension's standard-install workaround is required for every non-versioned update, not just the one-time transition.


## Artifact

- File: `kiro-update-checker-0.5.3-test.2.vsix`
- Size: `1145332` bytes
- SHA-256: `bdc1dae2ba693ac612c2f572f12c3dc5d019e5c6031f4af249598ab18575a463`
- Source: `source.patch` (staged main source, still versioned 0.5.2)

## Install

```powershell
kiro --install-extension kiro-update-checker-0.5.3-test.2.vsix --force
```

It replaces test.1 (0.5.3-test.2 > 0.5.3-test.1).

## Sources

- https://github.com/microsoft/inno-updater/pull/78
- https://github.com/microsoft/inno-updater/commit/04da21f70a88830f46fbff540276b25aec9959ae
- https://github.com/microsoft/vscode/blob/1.131.0/build/gulpfile.vscode.win32.ts
- https://github.com/microsoft/vscode/blob/1.131.0/build/win32/code.iss
- Kiro local `resources/app/product.json`, `tools/inno_updater.exe` (0.26.0 / 04da21f70a)
- Kiro setup logs (`isBackgroundUpdate=true`, destinations under `_`)
