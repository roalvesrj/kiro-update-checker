import { log } from './log';

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

export function parseChangelogSlugsFromIndex(html: string): string[] {
	const slugs = new Set<string>();
	const pattern = /href=["'][^"']*\/changelog\/ide\/([A-Za-z0-9._-]+)/gi;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(html)) !== null) {
		slugs.add(match[1].toLowerCase());
	}
	return [...slugs];
}

export function pickChangelogUrl(version: string, slugs: string[]): string | null {
	const parsed = parseVersion(version);
	if (!parsed) {
		return null;
	}

	const [major, minor, patch] = parsed.core;
	const fullSlug = `${major}-${minor}-${patch}`;
	if (slugs.includes(fullSlug)) {
		return `https://kiro.dev/changelog/ide/${fullSlug}/`;
	}

	// Kiro groups most releases under a minor-version page (e.g. 1.4.5 ->
	// /changelog/ide/1-4/#patch-1-4-5), while some releases keep a dedicated
	// full-version page (e.g. 1.3.11). The .0 release is the minor page itself,
	// so it gets no patch anchor.
	const minorSlug = `${major}-${minor}`;
	if (slugs.includes(minorSlug)) {
		return patch > 0
			? `https://kiro.dev/changelog/ide/${minorSlug}/#patch-${fullSlug}`
			: `https://kiro.dev/changelog/ide/${minorSlug}/`;
	}

	return null;
}
