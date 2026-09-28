# Change Log

## [0.3.1] - 2026-09-28
### Security
- Settings `autoDownload`, `downloadFolder` and `packageFormat` are now `machine`-scoped — a malicious workspace can no longer redirect downloads, change the package format or enable auto-download via `.vscode/settings.json`
- Installer reuse now requires a download recorded by the extension (path + size in global state) instead of a size match alone — planted files are re-downloaded, never offered for install
- Auto-download is disabled in untrusted workspaces and falls back to the manual notification
- `packageFormat` is validated at runtime against a per-OS allowlist (deb/tar.gz, dmg/pkg, exe); installer paths are containment-checked under the download folder
- URL allowlist hardened: rejects URLs with embedded credentials and non-443 ports
- Downloads page fetch now caps HTML in bytes (not chars) and debug logs no longer dump remote content (size + hash instead)

### Fixed
- Windows ARM64 is now detected correctly (was hardcoded to x64); unsupported architectures (ia32, armv7) no longer silently download the wrong installer
- macOS `.pkg` is now supported and `packageFormat` is honored on macOS and Windows (previously Linux-only); stale `AppImage` option removed
- `checkInterval` setting now actually works (was documented but never implemented): periodic checks, clamped to 5–1440 minutes, rescheduled on config change
- Concurrent update checks are single-flight — startup/command/interval can no longer fight over the same `.part` file
- Download cancellation now aborts immediately and no longer shows a spurious error toast
- Abandoned HTTP requests after redirects no longer leak handlers that could delete the new attempt's `.part` (download and page fetch)
- Installer downloads are capped at 2 GB; `Content-Length`-less responses are still verified via the recorded size
- `checkUrl` only treats 2xx as success and always drains the response (no leaked sockets)
- `compareVersions` is strict: prerelease-aware, build-metadata-aware, and invalid versions fail safe (no false update prompts)
- Kiro detection now trusts `product.json` markers first and no longer rejects names containing "Code"/"Studio"
- `getCurrentKiroVersion` validates the version strictly and prefers `product.json` over arbitrary `package.json`
- Existing installers are no longer deleted before a new download succeeds
- "Up to date" notification now shows the installed version (was showing the latest)
- All notification handlers have error handling (no more unhandled rejections); install command failures fall back to the system handler
- Linux default download folder respects `xdg-user-dir DOWNLOAD`

### Internal
- Split into modules: `log.ts`, `urls.ts`, `version.ts`, `platform.ts`
- Tests: URL allowlist security cases, prerelease/build comparisons, real-page golden snippet (1.1.70), platform matrix, l10n key/placeholder contract
- CI: test failures are no longer swallowed (`|| echo` removed); dropped unnecessary `--allow-missing-repository`

## [0.3.0] - 2026-08-12
### Security
- **Fixed** command injection via shell: installer now opens via `TerminalShellIntegration.executeCommand()` with separated executable/args (auto-escaped), falling back to `openExternal()` when shell integration is unavailable
- **Fixed** unsafe redirects: downloads and page fetches now only follow HTTPS redirects to `kiro.dev` hosts (allowlist in `resolveSafeUrl()`)
- **Fixed** untrusted download reuse: existing installer files are only reused when their size matches the server `Content-Length`; stale/tampered files are deleted and re-downloaded
- **Fixed** partial downloads presented as complete: downloads go to a `.part` file, size is verified on finish, then atomically renamed
- **Fixed** unhandled response stream errors that could leave the download UI stuck (potential deadlock)
- **Fixed** unbounded memory: downloads page HTML is capped at 5 MB
- **Fixed** symlink following on download target (exclusive `wx` flag)
- **Fixed** HEAD/GET races: both requests now validate the URL against the same allowlist

### Changed
- Minimum VS Code/Kiro engine raised from `1.75.0` to **`1.93.0`** (required by the `TerminalShellIntegration` API)
- Localization migrated to the official `vscode.l10n` API (`l10n` contribution point); custom loader removed
- `checkUrl()` now returns `{ status, size }` and validates the URL before requesting

### Internal
- Removed hardcoded extension version (read from `package.json` at activation)
- `deactivate()` now disposes the output channel
- Added `resolveSafeUrl()` / `validateDownloadUrl()` URL allowlist helpers
- Added `launchInstaller()` for safe cross-platform installer launch
- `tsconfig.json` declares `moduleResolution: node10` + `ignoreDeprecations: 6.0`

## [0.2.2] - 2026-07-16
### Changed
- Release Notes now uses the actual changelog URL extracted from the Kiro downloads page (`changelogSlug`) instead of constructing it from the version number

### Internal
- `fetchLatestVersion()` now returns `{ version, changelogUrl }` object
- Added `parseChangelogUrlFromHTML()` for changelog URL extraction
- Removed `changelogUrl()` and `openReleaseNotes()` (replaced by direct URL usage)

## [0.2.1] - 2026-07-16
### Added
- Arabic (ar), Turkish (tr), Vietnamese (vi) translations — 15 languages total

### Fixed
- `detectLinuxDistro` test now correctly skips assertion on Linux runners where `/etc/os-release` exists

## [0.2.0] - 2026-07-14
### Added
- Cross-platform download support: Windows (.exe), macOS (.dmg), Linux (.deb, .tar.gz)
- `detectPlatform()` and `detectLinuxDistro()` utilities exported for testing
- Platform-aware install command: `start` (Windows), `open` (macOS), `xdg-open` (Linux)
- `packageFormat` setting: override package type (auto, deb, tar.gz, AppImage, dmg, exe)
- `checkUrl()`: HEAD request safety check with 403 fallback
- 12 language translations (en, pt-BR, pt-PT, es, fr, de, it, ja, ko, zh-cn, hi, ru)
- Auto-publish workflow to Open VSX via GitHub Actions
- Setting descriptions in 12 languages via `package.nls.*.json`

### Changed
- `buildDownloadUrl()` now requires a `PlatformInfo` parameter
- `parseVersionFromHTML()` prioritises JSON `currentVersion` field over download link regex
- Fallback to downloads page when platform is unsupported

### Fixed
- Linux download URLs: added missing `/deb/` or `/tar/` path segment after version number

### Added
- Release Notes button on notifications: opens official Kiro changelog page in browser (`kiro.dev/changelog/ide/{version}/`)

## [0.1.4] - 2026-07-11
### Fixed
- displayName and description reverted to static text (Open VSX does not resolve %key%)

## [0.1.3] - 2026-07-11
### Added
- Localization support: English, Portuguese (pt-BR), Spanish (es) for both settings and runtime messages
- Extension icon (custom KUC-logo)
- `console.log` fallback for debugging when Output panel is inaccessible

### Changed
- Activation guard: extension only activates on Kiro IDE (detects by `appName` and `product.json`)
- Redirect handler resolves relative URLs and enforces max 5 redirect hops
- Parser regex generalized for cross-platform download links (.exe, .dmg, .pkg, .deb, .tar.gz)
- `getCurrentKiroVersion()` searches 5 candidate paths for version detection
- Default download folder is created if it doesn't exist
- Repository URL added to `package.json` for proper marketplace metadata

### Fixed
- Settings descriptions now localized via `%key%` references in `package.json`
- Button action comparisons use translated string (`t()`) instead of hardcoded English
- Download readiness guard: uses `finish` event instead of `close` to prevent false success on pipe interruption
- Multiple resolve/notification guard via `completed` flag
- File write errors now include actual error code in logs