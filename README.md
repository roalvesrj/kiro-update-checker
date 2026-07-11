# Kiro Update Checker

<p align="center">
  <img src="./images/KUC-logo.png" alt="Kiro Update Checker" width="256"/>
</p>

Automatically checks the official Kiro downloads page for new IDE releases. Intended for users running Kiro in Administrator mode, where the built-in update feature may not be available.

## Features

- Checks for new Kiro IDE releases on startup
- Notifies you when a new version is available
- Supports auto-downloading the installer
- Manual check command: **Kiro: Check for Updates Now**
- Dismiss notification for a specific version
- **Multi-language support**: adapts to your VS Code/Kiro interface language (English, Português, Español)

## Extension Settings

This extension contributes the following settings:

| Setting | Default | Description |
|---------|---------|-------------|
| `kiroUpdateChecker.enableOnStartup` | `true` | Whether to check for updates on startup |
| `kiroUpdateChecker.autoDownload` | `false` | Whether to automatically download new versions |
| `kiroUpdateChecker.downloadFolder` | `""` | Custom folder to download updates to (empty = Downloads folder) |

## Commands

- **Kiro: Check for Updates Now** (`kiro-update-checker.checkNow`) — manually trigger an update check

## Requirements

- Kiro IDE (Visual Studio Code fork)
- Windows (auto-install uses `cmd.exe`)

## Known Issues

- Auto-download is Windows-only (the installer is always `win32-x64`)
- Version detection relies on parsing the Kiro downloads page HTML

## Release Notes

### 0.1.4

- Publisher changed to `roalvesrj` for auto-verified namespace on Open VSX

### 0.1.3

- Localization support: English, Portuguese (pt-BR), Spanish (es) for settings and messages
- Protection: extension only activates on Kiro IDE
- Custom extension icon
- Auto-generated release body from CHANGELOG
- Safety: max redirect hops, Output panel logging fixed, button comparisons use translated text
