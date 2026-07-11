import * as assert from 'assert';
import { compareVersions, formatBytes, buildDownloadUrl, parseVersionFromHTML } from '../extension';

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

	test('handles different segment lengths', () => {
		assert.strictEqual(compareVersions('1.0', '1.0.0'), 0);
		assert.strictEqual(compareVersions('1.0.1', '1.0'), 1);
		assert.strictEqual(compareVersions('1.0', '1.0.1'), -1);
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
});

suite('buildDownloadUrl', () => {
	test('builds URL for given version', () => {
		const url = buildDownloadUrl('1.2.3');
		assert.ok(url.includes('1.2.3'));
		assert.ok(url.endsWith('kiro-ide-1.2.3-stable-win32-x64.exe'));
		assert.ok(url.startsWith('https://'));
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

	test('extracts version from macOS download link', () => {
		const html = `<a href="kiro-ide-1.5.0-stable-darwin-arm64.dmg">Download</a>`;
		assert.strictEqual(parseVersionFromHTML(html), '1.5.0');
	});

	test('extracts version from Linux download link', () => {
		const html = `<a href="kiro-ide-3.2.1-stable-linux-x64.deb">Download</a>`;
		assert.strictEqual(parseVersionFromHTML(html), '3.2.1');
	});
});
