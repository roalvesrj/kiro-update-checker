# Kiro Update Checker

<p align="center">
  <img src="./images/KUC-logo.png" alt="Kiro Update Checker" width="256"/>
</p>

[![GitHub release](https://img.shields.io/github/release/roalvesrj/kiro-update-checker.svg)](https://github.com/roalvesrj/kiro-update-checker/releases)
[![GitHub issues](https://img.shields.io/github/issues/roalvesrj/kiro-update-checker.svg)](https://github.com/roalvesrj/kiro-update-checker/issues)
[![GitHub pull requests](https://img.shields.io/github/issues-pr/roalvesrj/kiro-update-checker.svg)](https://github.com/roalvesrj/kiro-update-checker/issues)
[![Open VSX Downloads](https://img.shields.io/open-vsx/dt/roalvesrj/kiro-update-checker)](https://open-vsx.org/extension/roalvesrj/kiro-update-checker)
[![Open VSX Rating](https://img.shields.io/open-vsx/rating/roalvesrj/kiro-update-checker)](https://open-vsx.org/extension/roalvesrj/kiro-update-checker)


Automatically checks for new Kiro IDE releases using Kiro's own update feed. Intended for users running Kiro in Administrator mode, where the built-in update feature may not be available.

> **Disclaimer:** This is a community extension, not officially maintained by the Kiro team.

## Features

- Checks for new Kiro IDE releases on startup and at configurable intervals
- **Official update feed**: version detection uses Kiro's own updater JSON feed (no more HTML scraping), with the downloads page only as fallback
- Notifies you when a new version is available
- Supports auto-downloading the installer
- **No console windows**: **Install Now** hands the installer to the system handler
- Manual check command: **Kiro: Check for Updates Now**
- Dismiss notification for a specific version
- **Release Notes button**: opens official Kiro changelog in your browser
- **Cross-platform**: Windows (.exe), macOS (.dmg), Linux (.deb, .tar.gz)
- **15 languages**: adapts to your VS Code/Kiro interface language

## Screenshots

<p align="center">
  <img src="./images/example-notify-01.png" alt="New version available notification" width="600"/>
  <br/>
  <em>New version available notification</em>
</p>

<p align="center">
  <img src="./images/example-autodownload-01.png" alt="Auto-download in progress" width="600"/>
  <br/>
  <em>Auto-download in progress</em>
</p>

<p align="center">
  <img src="./images/example-autodownload-02.png" alt="Ready to install" width="600"/>
  <br/>
  <em>Ready to install</em>
</p>

## Extension Settings

This extension contributes the following settings:

| Setting | Default | Description |
|---------|---------|-------------|
| `kiroUpdateChecker.enableOnStartup` | `true` | Whether to check for updates on startup |
| `kiroUpdateChecker.autoDownload` | `false` | Automatically download new versions when they become available (you still choose when to install) |
| `kiroUpdateChecker.downloadFolder` | `""` | Custom folder to download updates to (empty = Downloads folder) |
| `kiroUpdateChecker.checkInterval` | `60` | Interval in minutes to check for updates (0 = disable) |
| `kiroUpdateChecker.packageFormat` | `"auto"` | Override the package format for downloads (auto, deb, tar.gz, dmg, pkg, exe) |

## Commands

- **Kiro: Check for Updates Now** (`kiro-update-checker.checkNow`) — manually trigger an update check

## Supported Languages

| Language | Locale |
|----------|--------|
| English | `en` |
| Português (Brasil) | `pt-BR` |
| Português (Portugal) | `pt-PT` |
| Español | `es` |
| Français | `fr` |
| Deutsch | `de` |
| Italiano | `it` |
| 日本語 | `ja` |
| 한국어 | `ko` |
| 简体中文 | `zh-cn` |
| हिन्दी | `hi` |
| Русский | `ru` |
| العربية | `ar` |
| Türkçe | `tr` |
| Tiếng Việt | `vi` |

## Requirements

- Kiro IDE (Visual Studio Code fork) based on VS Code **1.93.0 or newer**
- Windows, macOS, or Linux

> **Note:** version 0.3.0+ requires a Kiro build based on VS Code ≥ 1.93. Users on older Kiro builds will remain on 0.2.2.

## Release Notes

### 0.4.0

- **Official update feed**: version detection now uses Kiro's own updater JSON feed (`metadata-{target}-{quality}.json`, from the local `product.json`) — the "HTML scraping" known issue is gone, and detection is immune to downloads page redesigns
- **No more console**: **Install Now** opens the installer with the system handler instead of spawning a terminal window
- The downloads page is still used as a fallback when the feed is unavailable, and for the exact changelog link
- Feed payloads are parsed defensively (strict validation, size caps, redirect allowlist)

### 0.3.1

- **Security:** sensitive settings are now machine-scoped (workspaces can't redirect downloads); installer reuse requires an extension-recorded download instead of a size match; auto-download is disabled in untrusted workspaces
- **Security:** `packageFormat` validated per-OS at runtime; URL allowlist rejects credentials/non-443 ports
- **Fixed:** Windows ARM64 detection (was always x64); macOS `.pkg` support; `AppImage` option removed (no longer published by Kiro)
- **Fixed:** `checkInterval` now actually runs periodic checks (5–1440 min, clamped)
- **Fixed:** single-flight checks, immediate download cancellation, redirect handler leaks, 2 GB download cap, strict version comparison (prerelease-aware)
- **Fixed:** Kiro detection no longer rejects app names containing "Code"/"Studio"; installed version validation is strict

### 0.3.0

- **Security hardening:** fixed command injection via installer launch (now uses `TerminalShellIntegration` with escaped args)
- **Security hardening:** downloads only follow HTTPS redirects to `kiro.dev` hosts; untrusted/reused files are verified by size and re-downloaded when stale
- **Security hardening:** partial downloads no longer presented as complete (`.part` + size check + atomic rename)
- **Security hardening:** download UI no longer sticks on network errors (stream error handlers added)
- **Security hardening:** downloads page HTML capped at 5 MB; symlink attacks on the download target blocked
- **Breaking change:** minimum VS Code/Kiro engine raised to 1.93.0
- Localization migrated to the official `vscode.l10n` API

### 0.2.2

- **Release Notes button** now opens the actual changelog URL extracted from the Kiro downloads page instead of a version-constructed link

### 0.2.1

- Added Arabic (ar), Turkish (tr), Vietnamese (vi) translations
- Fixed `detectLinuxDistro` test to pass on Linux CI runners

### 0.2.0

- Cross-platform download support: Windows (.exe), macOS (.dmg), Linux (.deb, .tar.gz)
- Platform auto-detection + correct install command per OS
- `packageFormat` setting: choose package type or auto-detect
- 12 language translations (en, pt-BR, pt-PT, es, fr, de, it, ja, ko, zh-cn, hi, ru)
- Auto-publish to Open VSX via GitHub Actions
- Linux URL pattern fix (extra `/deb/` or `/tar/` path segment)
- `checkUrl()`: HEAD request safety check with 403 fallback
- **Release Notes button**: opens `kiro.dev/changelog/ide/{version}/` in your browser from any notification

### 0.1.4

- Publisher changed to `roalvesrj` for auto-verified namespace on Open VSX

### 0.1.3

- Localization support: English, Portuguese (pt-BR), Spanish (es) for settings and messages
- Protection: extension only activates on Kiro IDE
- Custom extension icon
- Auto-generated release body from CHANGELOG
- Safety: max redirect hops, Output panel logging fixed, button comparisons use translated text
