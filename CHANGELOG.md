# Change Log

All notable changes to the "kiro-update-checker" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [0.1.2] - 2026-07-11
### Fixed
- Version detection now searches multiple paths for current Kiro version
- Broken `.then(handleBrowserDownload(...))` in manual check mode
- Relative redirect URL handling in `fetchLatestVersion`
- Download integrity validation (MZ header check, size verification)
- File save failure on Windows (use `close` event instead of `finish`)
- Added `copyFileSync` fallback when rename fails

### Changed
- Parser regex generalized for cross-platform download links
- HTTP timeout via `timeout` option + `timeout` event instead of `setTimeout`
- Redirect handler resolves relative URLs against base URL