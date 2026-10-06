import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { compareVersions, parseVersion, parseVersionFromHTML, parseChangelogUrlFromHTML } from '../version';
import { buildDownloadUrl, detectPlatform, detectLinuxDistro } from '../platform';
import { isAllowedHost, resolveSafeUrl, validateDownloadUrl } from '../urls';
import { artifactFor, feedTargets, parseMetadataFeed } from '../feed';
import { formatBytes } from '../extension';

// Real payloads captured from https://prod.download.desktop.kiro.dev/stable/metadata-*-stable.json
// (2026-09-28, Kiro 1.1.70).
const FEED_WIN32_USER = {
	currentRelease: '1.1.70',
	releases: [{
		version: '1.1.70',
		updateTo: {
			version: '1.1.70',
			pub_date: '2026-09-24',
			notes: 'Kiro-win32-x64-user-1.1.70',
			name: 'Kiro-win32-x64-user-1.1.70',
			url: 'https://prod.download.desktop.kiro.dev/releases/stable/win32-x64/signed/1.1.70/kiro-ide-1.1.70-stable-win32-x64.exe'
		}
	}]
};

const FEED_DARWIN_ARM64 = {
	currentRelease: '1.1.70',
	releases: [{
		version: '1.1.70',
		updateTo: {
			version: '1.1.70',
			pub_date: '2026-09-24',
			url: 'https://prod.download.desktop.kiro.dev/releases/stable/darwin-arm64/signed/1.1.70/kiro-ide-1.1.70-stable-darwin-arm64.zip'
		}
	}]
};

const FEED_LINUX_X64 = {
	currentRelease: '1.1.70',
	releases: [
		{
			version: '1.1.70',
			updateTo: {
				version: '1.1.70',
				pub_date: '2026-09-24',
				url: 'https://prod.download.desktop.kiro.dev/releases/stable/linux-x64/signed/1.1.70/tar/certificate.pem'
			}
		},
		{
			version: '1.1.70',
			updateTo: {
				version: '1.1.70',
				pub_date: '2026-09-24',
				url: 'https://prod.download.desktop.kiro.dev/releases/stable/linux-x64/signed/1.1.70/tar/kiro-ide-1.1.70-stable-linux-x64.tar.gz'
			}
		},
		{
			version: '1.1.70',
			updateTo: {
				version: '1.1.70',
				pub_date: '2026-09-24',
				url: 'https://prod.download.desktop.kiro.dev/releases/stable/linux-x64/signed/1.1.70/tar/signature.bin'
			}
		}
	]
};

// Snippet shaped after the real https://kiro.dev/downloads/ page (2026-09-28):
// escaped currentVersion JSON blob, signed download links for every artifact and
// the changelog anchor. Used as a golden fixture for the parser.
const REAL_PAGE_SNIPPET = `
"availableChannel":"stable","versionHistory\":[],\"previousMinor\":null,\"previousMinors\":[]},\\"currentVersion\":\"1.1.70\",\"cliCommandHtml\"
<a href="https://prod.download.desktop.kiro.dev/releases/stable/darwin-arm64/signed/1.1.70/kiro-ide-1.1.70-stable-darwin-arm64.dmg">macOS (Apple Silicon)</a>
<a href="https://prod.download.desktop.kiro.dev/releases/stable/darwin-x64/signed/1.1.70/kiro-ide-1.1.70-stable-darwin-x64.pkg">macOS (Intel, pkg)</a>
<a href="https://prod.download.desktop.kiro.dev/releases/stable/win32-x64/signed/1.1.70/kiro-ide-1.1.70-stable-win32-x64.exe">Windows (x64)</a>
<a href="https://prod.download.desktop.kiro.dev/releases/stable/win32-arm64/signed/1.1.70/kiro-ide-1.1.70-stable-win32-arm64.exe">Windows (ARM64)</a>
<a href="https://prod.download.desktop.kiro.dev/releases/stable/linux-x64/signed/1.1.70/deb/kiro-ide-1.1.70-stable-linux-x64.deb">Linux (x64, Debian/Ubuntu 24+)</a>
<a href="https://prod.download.desktop.kiro.dev/releases/stable/linux-arm64/signed/1.1.70/tar/kiro-ide-1.1.70-stable-linux-arm64.tar.gz">Linux (ARM64, Universal)</a>
<a href="/changelog/ide/1-1-70/">Release notes</a>
`;

suite('compareVersions', () => {
	test('a > b returns 1', () => {
		assert.strictEqual(compareVersions('2.0.0', '1.0.0'), 1);
		assert.strictEqual(compareVersions('1.1.0', '1.0.0'), 1);
		assert.strictEqual(compareVersions('1.0.1', '1.0.0'), 1);
		assert.strictEqual(compareVersions('1.0.0', '0.9.9'), 1);
	});

	test('a < b returns -1', () => {
		assert.strictEqual(compareVersions('1.0.0', '2.0.0'), -1);
		assert.strictEqual(compareVersions('1.0.0', '1.1.0'), -1);
		assert.strictEqual(compareVersions('1.0.0', '1.0.1'), -1);
	});

	test('a == b returns 0', () => {
		assert.strictEqual(compareVersions('1.0.0', '1.0.0'), 0);
		assert.strictEqual(compareVersions('0.0.0', '0.0.0'), 0);
	});

	test('prerelease sorts before release', () => {
		assert.strictEqual(compareVersions('1.0.138-beta', '1.0.138'), -1);
		assert.strictEqual(compareVersions('1.0.138', '1.0.138-beta'), 1);
		assert.strictEqual(compareVersions('1.0.138-beta', '1.0.138-beta'), 0);
	});

	test('build metadata is ignored', () => {
		assert.strictEqual(compareVersions('1.0.0+build.5', '1.0.0'), 0);
		assert.strictEqual(compareVersions('1.0.0+build.5', '1.0.0+build.9'), 0);
	});

	test('invalid versions fail safe (no false updates)', () => {
		assert.strictEqual(compareVersions('1.0', '1.0.0'), 0);
		assert.strictEqual(compareVersions('garbage', '1.0.0'), 0);
		assert.strictEqual(compareVersions('1.0.0', ''), 0);
		assert.strictEqual(parseVersion('1.0'), null);
		assert.strictEqual(parseVersion('garbage'), null);
	});
});

suite('formatBytes', () => {
	test('returns 0 Bytes for zero', () => {
		assert.strictEqual(formatBytes(0), '0 Bytes');
	});

	test('formats bytes correctly', () => {
		assert.strictEqual(formatBytes(1024), '1 KB');
		assert.strictEqual(formatBytes(1048576), '1 MB');
		assert.strictEqual(formatBytes(1073741824), '1 GB');
	});

	test('formats with decimals', () => {
		assert.strictEqual(formatBytes(1536), '1.5 KB');
		assert.strictEqual(formatBytes(1572864), '1.5 MB');
	});

	test('handles invalid input', () => {
		assert.strictEqual(formatBytes(-1), '0 Bytes');
		assert.strictEqual(formatBytes(NaN), '0 Bytes');
		assert.strictEqual(formatBytes(Infinity), '0 Bytes');
	});
});

suite('url allowlist', () => {
	test('isAllowedHost accepts kiro.dev and subdomains only', () => {
		assert.strictEqual(isAllowedHost('kiro.dev'), true);
		assert.strictEqual(isAllowedHost('prod.download.desktop.kiro.dev'), true);
		assert.strictEqual(isAllowedHost('KIRO.DEV'), true);
		assert.strictEqual(isAllowedHost('evilkiro.dev'), false);
		assert.strictEqual(isAllowedHost('kiro.dev.evil.com'), false);
		assert.strictEqual(isAllowedHost('notkiro.dev'), false);
		assert.strictEqual(isAllowedHost(''), false);
	});

	test('resolveSafeUrl accepts allowed HTTPS URLs', () => {
		assert.ok(resolveSafeUrl('https://kiro.dev/downloads/', 'https://kiro.dev'));
		assert.ok(resolveSafeUrl('/downloads/', 'https://kiro.dev'));
		assert.ok(resolveSafeUrl('https://prod.download.desktop.kiro.dev/releases/stable/win32-x64/signed/1.1.70/file.exe', 'https://kiro.dev'));
	});

	test('resolveSafeUrl blocks hostile URLs', () => {
		assert.strictEqual(resolveSafeUrl('http://kiro.dev/downloads/', 'https://kiro.dev'), null);
		assert.strictEqual(resolveSafeUrl('//evil.com', 'https://kiro.dev'), null);
		assert.strictEqual(resolveSafeUrl('https://evilkiro.dev/x', 'https://kiro.dev'), null);
		assert.strictEqual(resolveSafeUrl('https://kiro.dev.evil.com/x', 'https://kiro.dev'), null);
		assert.strictEqual(resolveSafeUrl('https://kiro.dev@evil.com/x', 'https://kiro.dev'), null);
		assert.strictEqual(resolveSafeUrl('https://evil.com@kiro.dev/x', 'https://kiro.dev'), null);
		assert.strictEqual(resolveSafeUrl('https://kiro.dev:8443/x', 'https://kiro.dev'), null);
		assert.strictEqual(resolveSafeUrl('https://', 'https://kiro.dev'), null);
		// A relative path (even with spaces) resolves under the base host and stays safe.
		assert.ok(resolveSafeUrl('not a url', 'https://kiro.dev')?.startsWith('https://kiro.dev/'));
	});

	test('validateDownloadUrl delegates to resolveSafeUrl', () => {
		assert.ok(validateDownloadUrl('https://prod.download.desktop.kiro.dev/file.exe'));
		assert.strictEqual(validateDownloadUrl('http://kiro.dev/file.exe'), null);
	});
});

suite('parseVersionFromHTML', () => {
	test('extracts version from download link', () => {
		const html = `<a href="kiro-ide-1.2.3-stable-win32-x64.exe">Download</a>`;
		assert.strictEqual(parseVersionFromHTML(html), '1.2.3');
	});

	test('returns null when no version found', () => {
		assert.strictEqual(parseVersionFromHTML('<html></html>'), null);
	});

	test('returns highest version when multiple present', () => {
		const html = `
			kiro-ide-1.0.0-stable-win32-x64.exe
			kiro-ide-2.0.0-stable-win32-x64.exe
			kiro-ide-1.9.9-stable-win32-x64.exe
		`;
		assert.strictEqual(parseVersionFromHTML(html), '2.0.0');
	});

	test('extracts version from escaped JSON currentVersion (real page shape)', () => {
		const html = '\\"currentVersion\\":\\"1.1.70\\"';
		assert.strictEqual(parseVersionFromHTML(html), '1.1.70');
	});

	test('extracts version from plain JSON currentVersion', () => {
		const html = `{"currentVersion":"1.0.138","latestVersion":"0.12.333"}`;
		assert.strictEqual(parseVersionFromHTML(html), '1.0.138');
	});

	test('prefers JSON currentVersion over links when no platform hint', () => {
		const html = `{"currentVersion":"1.0.138"} kiro-ide-0.12.333-stable-win32-x64.exe`;
		assert.strictEqual(parseVersionFromHTML(html), '1.0.138');
	});

	test('prefers current-platform links over JSON when hint given', () => {
		const html = `{"currentVersion":"2.0.0"} kiro-ide-1.1.70-stable-win32-x64.exe kiro-ide-0.9.0-stable-darwin-arm64.dmg`;
		assert.strictEqual(parseVersionFromHTML(html, { platform: 'win32', arch: 'x64' }), '1.1.70');
	});

	test('extracts version from the real downloads page snippet', () => {
		assert.strictEqual(parseVersionFromHTML(REAL_PAGE_SNIPPET), '1.1.70');
		assert.strictEqual(parseVersionFromHTML(REAL_PAGE_SNIPPET, { platform: 'win32', arch: 'arm64' }), '1.1.70');
		assert.strictEqual(parseVersionFromHTML(REAL_PAGE_SNIPPET, { platform: 'linux', arch: 'arm64' }), '1.1.70');
	});
});

suite('parseChangelogUrlFromHTML', () => {
	test('extracts the release notes anchor from the real page snippet', () => {
		assert.strictEqual(parseChangelogUrlFromHTML(REAL_PAGE_SNIPPET), 'https://kiro.dev/changelog/ide/1-1-70/');
	});

	test('prefers /changelog/ide/ over generic changelog links', () => {
		const html = `<a href="/changelog/">Changelog</a><a href="/changelog/ide/1-1-70/">Release notes</a>`;
		assert.strictEqual(parseChangelogUrlFromHTML(html), 'https://kiro.dev/changelog/ide/1-1-70/');
	});

	test('returns null when no changelog link exists', () => {
		assert.strictEqual(parseChangelogUrlFromHTML('<html></html>'), null);
	});

	test('discards untrusted changelog links', () => {
		assert.strictEqual(parseChangelogUrlFromHTML(`<a href="//evil.com/changelog/ide/1/">notes</a>`), null);
		assert.strictEqual(parseChangelogUrlFromHTML(`<a href="https://evil.com/changelog/">notes</a>`), null);
	});
});

suite('buildDownloadUrl', () => {
	test('builds URL for Windows x64', () => {
		const url = buildDownloadUrl('1.2.3', { platform: 'win32', arch: 'x64', ext: 'exe' });
		assert.ok(url.startsWith('https://prod.download.desktop.kiro.dev/releases/stable/win32-x64/signed/1.2.3/'));
		assert.ok(url.endsWith('kiro-ide-1.2.3-stable-win32-x64.exe'));
	});

	test('builds URL for Windows ARM64', () => {
		const url = buildDownloadUrl('1.1.70', { platform: 'win32', arch: 'arm64', ext: 'exe' });
		assert.ok(url.includes('win32-arm64/signed/1.1.70/'));
		assert.ok(url.endsWith('kiro-ide-1.1.70-stable-win32-arm64.exe'));
	});

	test('builds URL for macOS dmg and pkg (no extra path)', () => {
		const dmg = buildDownloadUrl('1.2.3', { platform: 'darwin', arch: 'arm64', ext: 'dmg' });
		assert.ok(dmg.endsWith('kiro-ide-1.2.3-stable-darwin-arm64.dmg'));
		const pkg = buildDownloadUrl('1.2.3', { platform: 'darwin', arch: 'x64', ext: 'pkg' });
		assert.ok(pkg.endsWith('kiro-ide-1.2.3-stable-darwin-x64.pkg'));
		assert.ok(!pkg.includes('/pkg/'));
	});

	test('builds URL for Linux deb', () => {
		const url = buildDownloadUrl('1.2.3', { platform: 'linux', arch: 'x64', ext: 'deb' });
		assert.ok(url.includes('linux-x64/signed/1.2.3/deb/'));
		assert.ok(url.endsWith('.deb'));
	});

	test('builds URL for Linux ARM64 tar.gz', () => {
		const url = buildDownloadUrl('1.2.3', { platform: 'linux', arch: 'arm64', ext: 'tar.gz' });
		assert.ok(url.includes('linux-arm64/signed/1.2.3/tar/'));
		assert.ok(url.endsWith('.tar.gz'));
	});
});

suite('detectPlatform', () => {
	test('maps Windows architectures explicitly', () => {
		assert.deepStrictEqual(detectPlatform('win32', 'x64', 'auto'), { platform: 'win32', arch: 'x64', ext: 'exe' });
		assert.deepStrictEqual(detectPlatform('win32', 'arm64', 'auto'), { platform: 'win32', arch: 'arm64', ext: 'exe' });
		assert.strictEqual(detectPlatform('win32', 'ia32', 'auto'), null);
	});

	test('respects packageFormat on macOS (dmg or pkg only)', () => {
		assert.strictEqual(detectPlatform('darwin', 'arm64', 'auto')?.ext, 'dmg');
		assert.strictEqual(detectPlatform('darwin', 'x64', 'pkg')?.ext, 'pkg');
		assert.strictEqual(detectPlatform('darwin', 'x64', 'exe')?.ext, 'dmg');
	});

	test('respects packageFormat on Linux (deb or tar.gz only)', () => {
		assert.strictEqual(detectPlatform('linux', 'x64', 'deb')?.ext, 'deb');
		assert.strictEqual(detectPlatform('linux', 'arm64', 'tar.gz')?.ext, 'tar.gz');
		const rejected = detectPlatform('linux', 'x64', 'AppImage');
		assert.ok(rejected && ['deb', 'tar.gz'].includes(rejected.ext));
	});

	test('returns null for unsupported platforms and architectures', () => {
		assert.strictEqual(detectPlatform('freebsd', 'x64', 'auto'), null);
		assert.strictEqual(detectPlatform('linux', 'mips', 'auto'), null);
		assert.strictEqual(detectPlatform('darwin', 'ia32', 'auto'), null);
	});
});

suite('detectLinuxDistro', () => {
	test('reports unknown outside Linux and a known family on Linux', () => {
		if (process.platform !== 'linux') {
			assert.strictEqual(detectLinuxDistro(), 'unknown');
		} else {
			assert.ok(['debian', 'universal'].includes(detectLinuxDistro()));
		}
	});
});

suite('parseMetadataFeed', () => {
	test('parses the real win32 user feed', () => {
		const feed = parseMetadataFeed(FEED_WIN32_USER);
		assert.ok(feed);
		assert.strictEqual(feed.version, '1.1.70');
		assert.strictEqual(feed.artifacts.length, 1);
		assert.ok(feed.artifacts[0].url.endsWith('.exe'));
		assert.strictEqual(feed.artifacts[0].pubDate, '2026-09-24');
	});

	test('parses the real darwin feed (zip updater artifact)', () => {
		const feed = parseMetadataFeed(FEED_DARWIN_ARM64);
		assert.ok(feed);
		assert.strictEqual(feed.version, '1.1.70');
		const zip = artifactFor(feed.artifacts, 'zip');
		assert.ok(zip?.url.endsWith('.zip'));
	});

	test('parses the real linux feed and filters signing artifacts', () => {
		const feed = parseMetadataFeed(FEED_LINUX_X64);
		assert.ok(feed);
		assert.strictEqual(feed.version, '1.1.70');
		assert.strictEqual(feed.artifacts.length, 3);
		const tarGz = artifactFor(feed.artifacts, 'tar.gz');
		assert.ok(tarGz?.url.endsWith('.tar.gz'));
		assert.strictEqual(artifactFor(feed.artifacts, 'zip'), null);
	});

	test('falls back to the highest artifact version when currentRelease is missing', () => {
		const feed = parseMetadataFeed({
			releases: [
				{ updateTo: { version: '1.0.9', url: 'https://prod.download.desktop.kiro.dev/a.exe' } },
				{ updateTo: { version: '1.1.70', url: 'https://prod.download.desktop.kiro.dev/b.exe' } }
			]
		});
		assert.strictEqual(feed?.version, '1.1.70');
	});

	test('rejects malformed payloads', () => {
		assert.strictEqual(parseMetadataFeed(null), null);
		assert.strictEqual(parseMetadataFeed('nope'), null);
		assert.strictEqual(parseMetadataFeed([]), null);
		assert.strictEqual(parseMetadataFeed({}), null);
		assert.strictEqual(parseMetadataFeed({ currentRelease: 'not-a-version' }), null);
		assert.strictEqual(parseMetadataFeed({ releases: 'nope' }), null);
		assert.strictEqual(parseMetadataFeed({ releases: [{ updateTo: { version: '1.0.0' } }] }), null);
	});

	test('ignores invalid versions inside releases', () => {
		const feed = parseMetadataFeed({
			currentRelease: '1.1.70',
			releases: [
				{ updateTo: { version: 'bad', url: 'https://prod.download.desktop.kiro.dev/a.exe' } },
				{ updateTo: { version: '1.1.70', url: 'https://prod.download.desktop.kiro.dev/b.exe' } }
			]
		});
		assert.strictEqual(feed?.artifacts.length, 1);
	});
});

suite('feedTargets', () => {
	test('builds Windows targets honoring the install target', () => {
		assert.deepStrictEqual(feedTargets('win32', 'x64', 'user'), [
			'win32-x64-user', 'win32-x64-system', 'win32-x64-archive'
		]);
		assert.deepStrictEqual(feedTargets('win32', 'arm64', 'system'), [
			'win32-arm64-system', 'win32-arm64-user', 'win32-arm64-archive'
		]);
	});

	test('builds macOS and Linux targets', () => {
		assert.deepStrictEqual(feedTargets('darwin', 'arm64'), ['darwin-arm64']);
		assert.deepStrictEqual(feedTargets('linux', 'x64'), ['linux-x64']);
	});

	test('returns no targets for unknown platforms', () => {
		assert.deepStrictEqual(feedTargets('freebsd', 'x64'), []);
	});
});


suite('l10n contract', () => {
	test('every l10n key used in code exists in all bundles with matching placeholders', () => {
		const root = path.join(__dirname, '..', '..');
		const source = fs.readFileSync(path.join(root, 'src', 'extension.ts'), 'utf8');

		const usedKeys = new Set<string>();
		const callPattern = /l10n\.t\(\s*(['"])((?:\\.|(?!\1).)*?)\1/g;
		let callMatch: RegExpExecArray | null;
		while ((callMatch = callPattern.exec(source)) !== null) {
			usedKeys.add(callMatch[2].replace(/\\'/g, "'").replace(/\\"/g, '"'));
		}
		assert.ok(usedKeys.size >= 15, `expected to find l10n keys, found ${usedKeys.size}`);

		const l10nDir = path.join(root, 'l10n');
		const bundles = fs.readdirSync(l10nDir).filter(f => /^bundle\.l10n(\..+)?\.json$/.test(f));
		assert.ok(bundles.length >= 15, `expected at least 15 bundles, found ${bundles.length}`);

		const placeholders = (value: string) => (value.match(/\{\d+\}/g) || []).sort().join(',');

		for (const file of bundles) {
			const bundle = JSON.parse(fs.readFileSync(path.join(l10nDir, file), 'utf8')) as Record<string, string>;
			for (const key of usedKeys) {
				assert.ok(key in bundle, `${file} is missing key: ${key}`);
				assert.strictEqual(
					placeholders(bundle[key]),
					placeholders(key),
					`${file} placeholder mismatch for: ${key}`
				);
			}
		}
	});
});
