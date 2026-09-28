import { log } from './log';

export function isAllowedHost(hostname: string): boolean {
	const h = hostname.toLowerCase();
	return h === 'kiro.dev' || h.endsWith('.kiro.dev');
}

export function resolveSafeUrl(location: string, baseUrl: string): string | null {
	let resolved: URL;
	try {
		resolved = new URL(location, baseUrl);
	} catch {
		return null;
	}
	if (resolved.protocol !== 'https:') {
		log(`Blocked non-HTTPS URL: ${resolved.protocol}//${resolved.hostname}`);
		return null;
	}
	if (resolved.username || resolved.password) {
		log('Blocked URL with embedded credentials.');
		return null;
	}
	if (resolved.port !== '' && resolved.port !== '443') {
		log(`Blocked URL with non-standard port: ${resolved.port}`);
		return null;
	}
	if (!isAllowedHost(resolved.hostname)) {
		log(`Blocked untrusted host: ${resolved.hostname}`);
		return null;
	}
	return resolved.toString();
}

export function validateDownloadUrl(url: string): string | null {
	return resolveSafeUrl(url, url);
}
