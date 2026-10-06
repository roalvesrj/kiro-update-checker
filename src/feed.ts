import { log } from './log';
import { compareVersions } from './version';

export interface FeedArtifact {
	url: string;
	version: string;
	pubDate?: string;
}

export interface FeedInfo {
	version: string;
	artifacts: FeedArtifact[];
}

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export function parseMetadataFeed(payload: unknown): FeedInfo | null {
	if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
		log('Feed payload is not an object.');
		return null;
	}

	const record = payload as Record<string, unknown>;
	const releases = Array.isArray(record.releases) ? record.releases : [];

	const artifacts: FeedArtifact[] = [];
	for (const release of releases) {
		if (!release || typeof release !== 'object') { continue; }
		const updateTo = (release as Record<string, unknown>).updateTo;
		if (!updateTo || typeof updateTo !== 'object') { continue; }
		const update = updateTo as Record<string, unknown>;
		const url = typeof update.url === 'string' ? update.url.trim() : '';
		const version = typeof update.version === 'string' ? update.version.trim() : '';
		if (!url || !VERSION_PATTERN.test(version)) { continue; }
		artifacts.push({
			url,
			version,
			pubDate: typeof update.pub_date === 'string' ? update.pub_date : undefined
		});
	}

	const currentRelease = typeof record.currentRelease === 'string' ? record.currentRelease.trim() : '';
	let version = VERSION_PATTERN.test(currentRelease) ? currentRelease : '';
	if (!version && artifacts.length > 0) {
		version = artifacts
			.map(artifact => artifact.version)
			.reduce((highest, candidate) => compareVersions(candidate, highest) > 0 ? candidate : highest);
		log(`Feed has no valid currentRelease; using highest artifact version ${version}.`);
	}

	if (!version) {
		log('Feed has no usable version.');
		return null;
	}

	return { version, artifacts };
}

export function feedTargets(platform: string, arch: string, installTarget?: string): string[] {
	if (platform === 'win32') {
		const preferred = installTarget === 'system' ? `win32-${arch}-system` : `win32-${arch}-user`;
		return [...new Set([
			preferred,
			`win32-${arch}-user`,
			`win32-${arch}-system`,
			`win32-${arch}-archive`
		])];
	}
	if (platform === 'darwin') {
		return [`darwin-${arch}`];
	}
	if (platform === 'linux') {
		return [`linux-${arch}`];
	}
	return [];
}

export function artifactFor(artifacts: FeedArtifact[], ext: string): FeedArtifact | null {
	const suffix = `.${ext.toLowerCase()}`;
	return artifacts.find(artifact => artifact.url.toLowerCase().endsWith(suffix)) ?? null;
}
