import * as fs from 'fs';
import { log } from './log';

export interface PlatformInfo {
	platform: string;
	arch: string;
	ext: string;
}

const PACKAGE_FORMATS: Record<string, readonly string[]> = {
	win32: ['exe'],
	darwin: ['dmg', 'pkg'],
	linux: ['deb', 'tar.gz']
};

function normalizeArch(arch: string): string | null {
	if (arch === 'x64') { return 'x64'; }
	if (arch === 'arm64') { return 'arm64'; }
	return null;
}

function pickFormat(requested: string, allowed: readonly string[]): string | null {
	if (!requested || requested === 'auto') {
		return null;
	}
	if (allowed.includes(requested)) {
		return requested;
	}
	log(`Ignoring packageFormat "${requested}" for this platform (allowed: ${allowed.join(', ')}).`);
	return null;
}

export function detectLinuxDistro(): string {
	try {
		if (process.platform !== 'linux') { return 'unknown'; }
		const osRelease = fs.readFileSync('/etc/os-release', 'utf8');
		const idMatch = osRelease.match(/^ID=["']?(\w+)["']?/m);
		const idLikeMatch = osRelease.match(/^ID_LIKE=["']?([\w\s]+)["']?/m);
		const id = idMatch ? idMatch[1].toLowerCase() : '';
		const idLike = idLikeMatch ? idLikeMatch[1].toLowerCase() : '';
		if (id === 'ubuntu' || id === 'debian' || idLike.includes('debian')) {
			return 'debian';
		}
		return 'universal';
	} catch {
		return 'universal';
	}
}

export function detectPlatform(
	platform: string = process.platform,
	arch: string = process.arch,
	packageFormat: string = 'auto'
): PlatformInfo | null {
	const normalizedArch = normalizeArch(arch);

	if (platform === 'win32') {
		if (!normalizedArch) {
			log(`Unsupported Windows architecture: ${arch}`);
			return null;
		}
		return { platform, arch: normalizedArch, ext: 'exe' };
	}

	if (platform === 'darwin') {
		if (!normalizedArch) {
			log(`Unsupported macOS architecture: ${arch}`);
			return null;
		}
		const ext = pickFormat(packageFormat, PACKAGE_FORMATS.darwin) ?? 'dmg';
		return { platform, arch: normalizedArch, ext };
	}

	if (platform === 'linux') {
		if (!normalizedArch) {
			log(`Unsupported Linux architecture: ${arch}`);
			return null;
		}
		const auto = detectLinuxDistro() === 'debian' ? 'deb' : 'tar.gz';
		const ext = pickFormat(packageFormat, PACKAGE_FORMATS.linux) ?? auto;
		return { platform, arch: normalizedArch, ext };
	}

	return null;
}

export function buildDownloadUrl(version: string, info: PlatformInfo): string {
	// Linux has an extra path segment: /deb/ or /tar/ before the filename
	let extraPath = '';
	if (info.platform === 'linux') {
		extraPath = info.ext === 'tar.gz' ? 'tar/' : `${info.ext}/`;
	}
	return `https://prod.download.desktop.kiro.dev/releases/stable/${info.platform}-${info.arch}/signed/${version}/${extraPath}kiro-ide-${version}-stable-${info.platform}-${info.arch}.${info.ext}`;
}
