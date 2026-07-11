# Kiro Update Checker

Automatically checks the official Kiro downloads page for new IDE releases. Intended for users running Kiro in Administrator mode, where the built-in update feature may not be available.

## Features

- Checks for new Kiro IDE releases on startup and at configurable intervals
- Notifies you when a new version is available
- Supports auto-downloading the installer
- Manual check command: **Kiro: Check for Updates Now**
- Dismiss notification for a specific version

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

### 0.1.1

- Fix configuration property names to match settings UI
- Fix browser download not opening when current version is unknown
- Add `onDidChangeConfiguration` listener
- Dynamic User-Agent based on extension version
- Platform-aware shell for auto-install
- Handle `openExternal` failures gracefully
- Clean up HTTP response objects on redirect
- Remove unused `node-html-parser` dependency
