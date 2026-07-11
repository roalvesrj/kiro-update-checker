# Change Log

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