import { log } from './log';
import { resolveSafeUrl } from './urls';

const STRICT_VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const JSON_VERSION = /(?:\\?")?currentVersion(?:\\?")?\s*:\s*(?:\\?")?(\d+\.\d+\.\d+)/;
const DOWNLOAD_LINK = /kiro-ide-(\d+\.\d+\.\d+)-stable-([a-z0-9]+)-([a-z0-9]+)\.(?:exe|dmg|pkg|deb|tar\.gz|AppImage|zip)/g;

interface ParsedVersion {
	core: [number, number, number];
	pre: string | null;
}

export interface PreferredPlatform {
	platform: string;
	arch: string;
}

export function parseVersion(version: string): ParsedVersion | null {
	const match = STRICT_VERSION.exec(version.trim());
	if (!match) {
		return null;
	}
	return {
		core: [Number(match[1]), Number(match[2]), Number(match[3])],
		pre: match[4] ?? null
	};
}

export function compareVersions(a: string, b: string): number {
	const pa = parseVersion(a);
	const pb = parseVersion(b);

	// Fail safe: an unparsable version must never trigger a false update prompt.
	if (!pa || !pb) {
		log(`compareVersions: invalid version(s) "${a}" vs "${b}"; treating as equal.`);
		return 0;
	}

	for (let i = 0; i < 3; i++) {
		if (pa.core[i] > pb.core[i]) { return 1; }
		if (pa.core[i] < pb.core[i]) { return -1; }
	}

	if (pa.pre === pb.pre) { return 0; }
	if (pa.pre === null) { return 1; }
	if (pb.pre === null) { return -1; }
	return pa.pre < pb.pre ? -1 : 1;
}

function collectVersions(html: string, preferred?: PreferredPlatform): string[] {
	const pattern = new RegExp(DOWNLOAD_LINK.source, 'g');
	const versions: string[] = [];
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(html)) !== null) {
		if (preferred && (match[2] !== preferred.platform || match[3] !== preferred.arch)) {
			continue;
		}
		versions.push(match[1]);
	}
	return versions;
}

function highestVersion(versions: string[]): string | null {
	let highest: string | null = null;
	for (const version of versions) {
		if (!highest || compareVersions(version, highest) > 0) {
			highest = version;
		}
	}
	return highest;
}

export function parseVersionFromHTML(html: string, preferred?: PreferredPlatform): string | null {
	if (preferred) {
		const platformVersions = collectVersions(html, preferred);
		const fromPlatformLinks = highestVersion(platformVersions);
		if (fromPlatformLinks) {
			const jsonVersion = html.match(JSON_VERSION)?.[1] ?? null;
			if (jsonVersion && jsonVersion !== fromPlatformLinks) {
				log(`parseVersionFromHTML: page JSON says "${jsonVersion}" but ${preferred.platform}-${preferred.arch} links say "${fromPlatformLinks}"; using the downloadable version.`);
			}
			log(`Found version from ${preferred.platform}-${preferred.arch} download links: ${fromPlatformLinks}`);
			return fromPlatformLinks;
		}
	}

	const jsonMatch = html.match(JSON_VERSION);
	if (jsonMatch) {
		log(`Found version from JSON: ${jsonMatch[1]}`);
		return jsonMatch[1];
	}

	const fromAllLinks = highestVersion(collectVersions(html));
	if (fromAllLinks) {
		log(`Found version from download links: ${fromAllLinks}`);
		return fromAllLinks;
	}

	log('No version found in HTML.');
	return null;
}

export function parseChangelogUrlFromHTML(html: string): string | null {
	const anchors: string[] = [];
	const pattern = /href="([^"]*changelog[^"]*)"/gi;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(html)) !== null) {
		anchors.push(match[1]);
	}
	if (anchors.length === 0) {
		log('Could not extract changelog URL from HTML.');
		return null;
	}

	const preferred = anchors.find(a => /\/changelog\/ide\//i.test(a)) ?? anchors[0];
	let candidate: string;
	if (/^https?:\/\//i.test(preferred)) {
		candidate = preferred;
	} else if (preferred.startsWith('//')) {
		// Protocol-relative anchor: keep its true host so the allowlist can judge it.
		candidate = `https:${preferred}`;
	} else {
		candidate = `https://kiro.dev${preferred.startsWith('/') ? '' : '/'}${preferred}`;
	}
	const safe = resolveSafeUrl(candidate, 'https://kiro.dev/');
	if (!safe) {
		log(`Discarding untrusted changelog URL: ${candidate}`);
		return null;
	}
	return safe;
}
