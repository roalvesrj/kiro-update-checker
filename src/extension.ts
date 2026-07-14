import * as vscode from 'vscode';
import * as https from 'https';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { IncomingMessage } from 'http';

const DOWNLOADS_PAGE_URL = 'https://kiro.dev/downloads/';
const STATE_KEY_DISMISSED_VERSION = 'kiroUpdateChecker.dismissedVersion';

let outputChannel: vscode.OutputChannel | null = null;
let extensionVersion = '0.1.0';
let extensionPath = '';

// Translation support — loads bundle.l10n.<lang>.json based on VS Code UI language
let _translations: Record<string, string> = {};

function t(message: string, ...args: (string | number)[]): string {
	let translated = _translations[message] || message;
	for (let i = 0; i < args.length; i++) {
		translated = translated.replace(`{${i}}`, String(args[i]));
	}
	return translated;
}

function loadTranslations(ctx: vscode.ExtensionContext) {
	extensionPath = ctx.extensionPath;
	const lang = vscode.env.language;
	const bundlePath = path.join(extensionPath, 'l10n', `bundle.l10n.${lang}.json`);
	const fallbackPath = path.join(extensionPath, 'l10n', 'bundle.l10n.json');

	try {
		if (fs.existsSync(bundlePath)) {
			_translations = JSON.parse(fs.readFileSync(bundlePath, 'utf8'));
			log(`Loaded translations for "${lang}" (${Object.keys(_translations).length} strings)`);
			return;
		}
	} catch {}

	// Fallback to English
	try {
		if (fs.existsSync(fallbackPath)) {
			_translations = JSON.parse(fs.readFileSync(fallbackPath, 'utf8'));
		}
	} catch {}
}

function userAgentStr(): string {
	return `KiroUpdateChecker/${extensionVersion}`;
}

function isKiro(): boolean {
	try {
		const appName = vscode.env.appName;

		// Known non-Kiro distributions — reject immediately
		const nonKiro = [
			/visual studio code/i, /code - oss/i, /vscodium/i,
			/cursor/i, /windsurf/i, /github codespaces/i,
			/studio/i, /code$/
		];
		if (appName && nonKiro.some(r => r.test(appName))) {
			return false;
		}

		// Positive check: name contains "Kiro"
		if (appName && /kiro/i.test(appName)) {
			return true;
		}

		// Check product.json for Kiro-specific markers
		const appRoot = vscode.env.appRoot;
		if (appRoot) {
			const productPath = path.join(appRoot, 'product.json');
			if (fs.existsSync(productPath)) {
				const product = JSON.parse(fs.readFileSync(productPath, 'utf8'));
				if (product.applicationName === 'kiro') {
					return true;
				}
				if (product.nameShort && /kiro/i.test(product.nameShort)) {
					return true;
				}
				if (product.nameLong && /kiro/i.test(product.nameLong)) {
					return true;
				}
			}
		}
	} catch {
	}

	return false;
}

export function activate(context: vscode.ExtensionContext) {
	extensionVersion = context.extension.packageJSON.version || '0.1.0';

	outputChannel = vscode.window.createOutputChannel('Kiro Update Checker');
	context.subscriptions.push(outputChannel);

	loadTranslations(context);

	log('Kiro Update Checker activated.');

	if (!isKiro()) {
		log('Not running on Kiro IDE. Extension will not be active.');
		log(`Detected appName: "${vscode.env.appName}"`);
		vscode.window.showInformationMessage(
			t('Kiro Update Checker: This extension only works on Kiro IDE.'),
			{ modal: false }
		);
		return;
	}

	log('Kiro IDE detected. Extension is active.');

	// Register the command to check for updates
	const checkNowCommand = vscode.commands.registerCommand('kiro-update-checker.checkNow', () => {
		checkForUpdates(context, true);
	});
	context.subscriptions.push(checkNowCommand);

	// React to configuration changes at runtime
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('kiroUpdateChecker')) {
				log('Configuration changed.');
			}
		})
	);

	// Check for updates on startup if enabled in settings
	const config = vscode.workspace.getConfiguration('kiroUpdateChecker');
	const enable = config.get<boolean>('enableOnStartup', true);

	if (enable) {
		log('Checking for updates on startup...');
		checkForUpdates(context);
	} else {
		log('Update check on startup is disabled.');
	}
}

function log(message: string) {
	console.log(`[KUC] ${message}`);
	if (outputChannel) {
		outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] ${message}`);
	}
}

interface PlatformInfo {
	platform: string;
	arch: string;
	ext: string;
}

function detectLinuxDistro(): string {
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

function detectPlatform(): PlatformInfo | null {
	const plat = process.platform;
	const arch = process.arch;

	if (plat === 'win32') {
		return { platform: 'win32', arch: 'x64', ext: 'exe' };
	}
	if (plat === 'darwin') {
		return { platform: 'darwin', arch: arch === 'arm64' ? 'arm64' : 'x64', ext: 'dmg' };
	}
	if (plat === 'linux') {
		const config = vscode.workspace.getConfiguration('kiroUpdateChecker');
		const customExt = config.get<string>('packageFormat', 'auto');
		if (customExt && customExt !== 'auto') {
			return { platform: 'linux', arch: arch === 'arm64' ? 'arm64' : 'x64', ext: customExt };
		}
		const distro = detectLinuxDistro();
		const ext = distro === 'debian' ? 'deb' : 'tar.gz';
		return { platform: 'linux', arch: arch === 'arm64' ? 'arm64' : 'x64', ext };
	}
	return null;
}

function getDownloadFolder(): string {
	const config = vscode.workspace.getConfiguration('kiroUpdateChecker');
	const customPath = config.get<string>('downloadFolder', '');

	if (customPath) {
		try {
			if (!fs.existsSync(customPath)) {
				fs.mkdirSync(customPath, { recursive: true });
			}
			if (fs.statSync(customPath).isDirectory()) {
				log(`Using custom download folder: ${customPath}`);
				return customPath;
			}
		} catch (e) {
			log(`Custom folder invalid (${customPath}), falling back to default: ${e}`);
		}
	}

	const defaultPath = path.join(os.homedir(), 'Downloads');
	if (!fs.existsSync(defaultPath)) {
		fs.mkdirSync(defaultPath, { recursive: true });
	}
	log(`Using download folder: ${defaultPath}`);
	return defaultPath;
}

async function checkForUpdates(context: vscode.ExtensionContext, manualCheck: boolean = false) {
	try {
		log('Fetching the Kiro downloads page...');
		const latestVersion = await fetchLatestVersion();

		if (!latestVersion) {
			log('Could not determine the latest version.');

			if (manualCheck) {
				vscode.window.showInformationMessage(t('Could not determine the latest Kiro version. Please try again later.'));
			}
			return;
		}

		log(`Latest Kiro version found: ${latestVersion}`);

		// Get the current Kiro version installed
		const currentVersion = getCurrentKiroVersion();

		if (!currentVersion) {
			log('Could not determine the current Kiro version.');

			if (manualCheck) {
				const selection = await vscode.window.showWarningMessage(
					t('Could not determine the current Kiro version. Please ensure Kiro is installed.'),
					t('Download Latest'),
					t('Open Downloads Page')
				);
				if (selection === t('Download Latest')) {
					const info = detectPlatform();
					if (!info) {
						log('Unsupported platform for direct download. Opening browser page.');
						await vscode.env.openExternal(vscode.Uri.parse(DOWNLOADS_PAGE_URL));
					} else {
						const downloadUrl = buildDownloadUrl(latestVersion, info);
						log(`Opening browser to download URL: ${downloadUrl}`);
						await vscode.env.openExternal(vscode.Uri.parse(downloadUrl));
					}
				} else if (selection === t('Open Downloads Page')) {
					await vscode.env.openExternal(vscode.Uri.parse(DOWNLOADS_PAGE_URL));
				}
			}
			return;
		}

		log(`Current Kiro version: ${currentVersion}`);

		const comparison = compareVersions(latestVersion, currentVersion);
		log(`Comparison result: ${comparison}`);

		if (comparison > 0) {
			const dismissedVersion = context.globalState.get<string>(STATE_KEY_DISMISSED_VERSION);

			if (!manualCheck && dismissedVersion === latestVersion) {
				log(`User has dismissed notifications for version ${latestVersion}. Skipping notification.`);
				return;
			}

			const config = vscode.workspace.getConfiguration('kiroUpdateChecker');
			const autoDownload = config.get<boolean>('autoDownload', false);

			if (autoDownload) {
				log('Auto-download is enabled. Downloading the latest version...');
				await handleAutoDownload(context, currentVersion, latestVersion, manualCheck);
			} else {
				await handleManualDownload(context, currentVersion, latestVersion);
			}
		} else if (manualCheck) {
			vscode.window.showInformationMessage(t('✅ Kiro is up to date! Installed version: {0}', latestVersion));
		}
	} catch (error) {
		log(`Error occurred while checking for updates: ${error}`);

		if (manualCheck) {
			vscode.window.showErrorMessage(t('An error occurred while checking for updates. Please try again later.'));
		}
	}
}

async function handleManualDownload(context: vscode.ExtensionContext, currentVersion: string, latestVersion: string) {
	log('Mode: Manual download (open browser).');
	vscode.window.showWarningMessage(
		t('🚀 New Kiro version available! {0} -> {1}.', currentVersion, latestVersion),
		{ modal: false },
		t('Download Latest'),
		t('Release Notes'),
		t('Dismiss')
	).then(async selection => {
		if (selection === t('Download Latest')) {
			const info = detectPlatform();
			if (!info) {
				log('Unsupported platform. Opening downloads page instead.');
				await vscode.env.openExternal(vscode.Uri.parse(DOWNLOADS_PAGE_URL));
			} else {
				const downloadUrl = buildDownloadUrl(latestVersion, info);
				log(`Opening browser to download URL: ${downloadUrl}`);
				const opened = await vscode.env.openExternal(vscode.Uri.parse(downloadUrl));
				if (!opened) {
					log('Failed to open browser.');
				}
			}
		} else if (selection === t('Release Notes')) {
			log('User requested release notes.');
			await showReleaseNotes(latestVersion);
		} else if (selection === t('Dismiss')) {
			log(`User dismissed notifications for version ${latestVersion}.`);
			await context.globalState.update(STATE_KEY_DISMISSED_VERSION, latestVersion);
		}
	});
}

async function checkUrl(url: string): Promise<number | null> {
	return new Promise((resolve) => {
		const request = https.request(url, {
			method: 'HEAD',
			headers: { 'User-Agent': userAgentStr() },
			timeout: 10000
		}, (response) => {
			resolve(response.statusCode || null);
		});
		request.on('error', () => resolve(null));
		request.on('timeout', () => { request.destroy(); resolve(null); });
		request.end();
	});
}

async function handleAutoDownload(context: vscode.ExtensionContext, currentVersion: string, latestVersion: string, manualCheck: boolean) {
	log('Mode: Auto-download and install.');
	const info = detectPlatform();
	if (!info) {
		log('Unsupported platform for auto-download. Falling back to manual download.');
		handleManualDownload(context, currentVersion, latestVersion);
		return;
	}

	const downloadUrl = buildDownloadUrl(latestVersion, info);

	// Check if the URL is actually accessible before downloading
	const status = await checkUrl(downloadUrl);
	if (status === 403) {
		log(`Download URL returned 403 Forbidden: ${downloadUrl}`);
		const selection = await vscode.window.showErrorMessage(
			t('❌ Kiro Update Checker: Direct download not available for your platform ({0}). Visit the downloads page.', info.ext),
			t('Open Downloads Page')
		);
		if (selection === t('Open Downloads Page')) {
			await vscode.env.openExternal(vscode.Uri.parse(DOWNLOADS_PAGE_URL));
		}
		return;
	}

	const downloadFolder = getDownloadFolder();
	const fileName = `kiro-ide-${latestVersion}-stable-${info.platform}-${info.arch}.${info.ext}`;
	const filePath = path.join(downloadFolder, fileName);

	if (fs.existsSync(filePath)) {
		log(`Installer already exists at ${filePath}.`);
		showInstallNotification(context, currentVersion, latestVersion, filePath);
		return;
	}

	log(`Downloading installer from ${downloadUrl} to ${filePath}...`);

	await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: t('⤵️ Kiro Update Checker: Downloading {0}', latestVersion),
			cancellable: true
		},
		async (progress, token) => {
			return new Promise<void>((resolve) => {
				let completed = false;

				const downloadFile = (url: string, redirectDepth: number = 0) => {
					if (redirectDepth > 5) {
						log('Too many redirects. Aborting download.');
						vscode.window.showErrorMessage(t('❌ Kiro Update Checker: Failed to download {0}. Try manually.', latestVersion));
						resolve();
						return;
					}
					const request = https.get(url, {
						headers: { 'User-Agent': userAgentStr() },
						timeout: 120000
					}, response => {
						if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
							log(`Redirected to ${response.headers.location}`);
							response.destroy();

							const location = response.headers.location;
							const redirectUrl = location.startsWith('http')
								? location
								: new URL(location, url).toString();
							downloadFile(redirectUrl, redirectDepth + 1);
							return;
						}

						if (response.statusCode !== 200) {
							log(`Failed to download file. Status code: ${response.statusCode}`);
							vscode.window.showErrorMessage(t('❌ Kiro Update Checker: Failed to download {0}. Try manually.', latestVersion));
							resolve();
							return;
						}

						const totalSize = parseInt(response.headers['content-length'] || '0', 10);
						let downloadedSize = 0;

						const fileStream = fs.createWriteStream(filePath);

						token.onCancellationRequested(() => {
							log('Download cancelled by user.');
							request.destroy();
							fileStream.destroy();
							try { fs.unlinkSync(filePath); } catch {}
							resolve();
						});

						response.on('data', (chunk: Buffer) => {
							downloadedSize += chunk.length;

							if (totalSize > 0) {
								const percentage = Math.round((downloadedSize / totalSize) * 100);
								progress.report({
									increment: (chunk.length / totalSize) * 100,
									message: `${percentage}% (${formatBytes(downloadedSize)} / ${formatBytes(totalSize)})`
								});
							}
						});

						response.pipe(fileStream);

						fileStream.on('finish', () => {
							completed = true;
							log(`Download completed: ${filePath} (${formatBytes(downloadedSize)})`);
							showInstallNotification(context, currentVersion, latestVersion, filePath);
							resolve();
						});

						fileStream.on('error', (err: NodeJS.ErrnoException) => {
							if (completed) { return; }
							log(`Error writing file to ${filePath}: ${err.message} (code: ${err.code})`);
							try { fs.unlinkSync(filePath); } catch {}
							vscode.window.showErrorMessage(
								t('❌ Kiro Update Checker: Error saving the installer. {0}', err.message)
							);
							resolve();
						});
					});

					request.on('error', (err) => {
						if (completed) { return; }
						log(`Error during download: ${err.message}`);
						try { fs.unlinkSync(filePath); } catch {}
						vscode.window.showErrorMessage(t('❌ Kiro Update Checker: Failed to download {0}. Try manually.', latestVersion));
						resolve();
					});

					request.on('timeout', () => {
						if (completed) { return; }
						log('Download request timed out (120 seconds).');
						request.destroy();
						try { fs.unlinkSync(filePath); } catch {}
						vscode.window.showErrorMessage(t('❌ Kiro Update Checker: Failed to download {0}. Try manually.', latestVersion));
						resolve();
					});
				};

				downloadFile(downloadUrl);
			});
		}
	);
}

function showInstallNotification(context: vscode.ExtensionContext, currentVersion: string, latestVersion: string, filePath: string) {
	const plat = process.platform;
	let shellPath: string | undefined;
	let openCommand: string;

	if (plat === 'win32') {
		shellPath = 'cmd.exe';
		openCommand = `start "" "${filePath}"`;
	} else if (plat === 'darwin') {
		shellPath = undefined;
		openCommand = `open "${filePath}"`;
	} else {
		shellPath = undefined;
		openCommand = `xdg-open "${filePath}"`;
	}

	vscode.window.showInformationMessage(
		t('🚀 New Kiro version ready to install! {0} -> {1}.', currentVersion, latestVersion),
		{ modal: false },
		t('Install Now'),
		t('Open folder'),
		t('Release Notes'),
		t('Dismiss')
	).then(async selection => {
		if (selection === t('Install Now')) {
			log(`Installing Kiro from ${filePath}...`);

			const terminal = vscode.window.createTerminal({ name: 'Kiro Installer', shellPath });
			terminal.sendText(openCommand, true);
			terminal.show();
		} else if (selection === t('Open folder')) {
			const folderPath = path.dirname(filePath);
			log(`Opening folder: ${folderPath}`);
			const opened = await vscode.env.openExternal(vscode.Uri.file(folderPath));
			if (!opened) {
				log('Failed to open folder.');
			}
		} else if (selection === t('Release Notes')) {
			log('User requested release notes.');
			await showReleaseNotes(latestVersion);
		} else if (selection === t('Dismiss')) {
			log(`User dismissed version ${latestVersion}.`);
			await context.globalState.update(STATE_KEY_DISMISSED_VERSION, latestVersion);
		}
	});
}

function formatBytes(bytes: number): string {
	if (bytes === 0) {
		return '0 Bytes';
	}

	const k = 1024;
	const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
	const i = Math.floor(Math.log(bytes) / Math.log(k));
	return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function fetchLatestVersion(): Promise<string | null> {
	return new Promise((resolve) => {
		const followRedirect = (url: string, depth: number = 0) => {
			if (depth > 5) {
				log('Too many redirects fetching downloads page.');
				resolve(null);
				return;
			}
			const request = https.get(url, { 
				headers: { 'User-Agent': userAgentStr() },
				timeout: 15000
			}, (response) => {
				if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
					log(`Redirected to ${response.headers.location}`);
					response.destroy();

					// Resolve relative redirect URLs against the base URL
					const location = response.headers.location;
					const redirectUrl = location.startsWith('http') 
						? location 
						: new URL(location, url).toString();
					
					followRedirect(redirectUrl, depth + 1);
					return;
				}

				log(`Fetching downloads page. Status code: ${response.statusCode}`);
				handleResponse(response, resolve);
			}).on('error', (err) => {
				log(`Error fetching downloads page: ${err.message}`);
				resolve(null);
			}).on('timeout', () => {
				log('Request to fetch downloads page timed out (15 seconds).');
				request.destroy();
				resolve(null);
			});
		};

		followRedirect(DOWNLOADS_PAGE_URL);
	});
}

function handleResponse(response: IncomingMessage, resolve: (value: string | null) => void) {
	let html = '';
	response.on('data', (chunk: Buffer) => {
		html += chunk.toString();
	});
	response.on('end', () => {
		log('HTML content fetched. Extracting version...');
		const version = parseVersionFromHTML(html);

		if (version) {
			log(`Extracted latest version: ${version}`);
		} else {
			log('Could not extract version from HTML.');
			const snippet = html.substring(0, 500);
			log(`HTML snippet for debugging: ${snippet}`);
		}
		resolve(version);
	});
	response.on('error', (err) => {
		log(`Error reading response: ${err.message}`);
		resolve(null);
	});
}

function parseVersionFromHTML(html: string): string | null {
	// Pattern 1: JSON "currentVersion":"X.Y.Z" (server-rendered data)
	const jsonPattern = /"currentVersion"\s*:\s*"(\d+\.\d+\.\d+)"/;
	const jsonMatch = html.match(jsonPattern);
	if (jsonMatch) {
		log(`Found version from JSON: ${jsonMatch[1]}`);
		return jsonMatch[1];
	}

	// Pattern 2: download links kiro-ide-<version>-stable-<platform>-<arch>.<ext>
	const linkPattern = /kiro-ide-(\d+\.\d+\.\d+)-stable-[a-z0-9]+-[a-z0-9]+\.(?:exe|dmg|pkg|deb|tar\.gz|AppImage|zip)/g;
	let match;
	let highestVersion: string | null = null;

	while ((match = linkPattern.exec(html)) !== null) {
		const version = match[1];
		if (!highestVersion || compareVersions(version, highestVersion) > 0) {
			highestVersion = version;
		}
	}

	if (highestVersion) {
		log(`Found version from download links: ${highestVersion}`);
	} else {
		log('No version found in HTML.');
	}

	return highestVersion;
}

function getCurrentKiroVersion(): string | null {
	try {
		const appRoot = vscode.env.appRoot;
		log(`VSCode/Kiro appRoot: ${appRoot}`);

		// Common locations where version might be stored in Kiro/VS Code forks
		const candidatePaths: string[] = [
			path.join(appRoot, 'product.json'),                    // Standard VS Code location
			path.join(appRoot, 'package.json'),                    // Fallback
			path.join(appRoot, 'resources', 'app', 'product.json'), // Some forks
			path.join(appRoot, '..', 'product.json'),              // Portable installs
			path.join(appRoot, '..', 'package.json'),              // Portable fallback
		];

		for (const candidatePath of candidatePaths) {
			if (fs.existsSync(candidatePath)) {
				try {
					const content = fs.readFileSync(candidatePath, 'utf8');
					const json = JSON.parse(content);
					
					// Try multiple possible version fields
					const version = json.version || json.KiroVersion || json.kiroVersion;
					if (version && typeof version === 'string' && version.match(/^\d+\.\d+\.\d+/)) {
						log(`Found version ${version} in ${candidatePath}`);
						return version;
					}
					log(`${candidatePath} found but no valid version field (version: ${json.version}, KiroVersion: ${json.KiroVersion})`);
				} catch (e) {
					log(`Failed to parse ${candidatePath}: ${e}`);
				}
			}
		}

		log('No version found in any candidate location.');
	} catch (error) {
		log(`Error reading current Kiro version: ${error}`);
	}

	return null;
}

function compareVersions(a: string, b: string): number {
	const partsA = a.split('.').map(Number);
	const partsB = b.split('.').map(Number);
	const maxLen = Math.max(partsA.length, partsB.length);

	for (let i = 0; i < maxLen; i++) {
		const numA = partsA[i] || 0;
		const numB = partsB[i] || 0;

		if (numA > numB) {return 1;}
		if (numA < numB) {return -1;}
	}
	return 0;
}

const METADATA_BASE = 'https://prod.download.desktop.kiro.dev/stable';

function metadataUrlForPlatform(info: PlatformInfo | null): string {
	if (info?.platform === 'darwin') {
		return `${METADATA_BASE}/metadata-dmg-${info.platform}-${info.arch}-stable.json`;
	}
	if (info?.platform === 'linux') {
		return `${METADATA_BASE}/metadata-${info.platform}-${info.arch}-stable.json`;
	}
	return `${METADATA_BASE}/metadata-linux-x64-stable.json`;
}

async function fetchReleaseNotes(version: string, info: PlatformInfo | null): Promise<string | null> {
	const url = metadataUrlForPlatform(info);
	try {
		const data = await new Promise<string>((resolve, reject) => {
			const req = https.get(url, { headers: { 'User-Agent': userAgentStr() }, timeout: 10000 }, (res) => {
				let body = '';
				res.on('data', (chunk) => body += chunk);
				res.on('end', () => resolve(body));
			});
			req.on('error', reject);
			req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
		});

		const json = JSON.parse(data);
		const releases = json.releases;
		if (!releases || releases.length === 0) { return null; }

		const latest = releases[releases.length - 1]?.updateTo;
		if (!latest) { return null; }

		const date = latest.pub_date || '';
		const notes = (latest.notes && !latest.notes.startsWith('Kiro-')) ? latest.notes : '';

		let result = `**Version:** ${latest.version}`;
		if (date) { result += `\n**Release date:** ${date}`; }
		if (notes) { result += `\n\n${notes}`; }
		return result;
	} catch {
		return null;
	}
}

async function showReleaseNotes(version: string) {
	const info = detectPlatform();
	const notes = await fetchReleaseNotes(version, info);

	if (notes) {
		const selection = await vscode.window.showInformationMessage(
			notes,
			{ modal: false },
			t('Open Downloads Page')
		);
		if (selection === t('Open Downloads Page')) {
			await vscode.env.openExternal(vscode.Uri.parse(DOWNLOADS_PAGE_URL));
		}
	} else {
		const selection = await vscode.window.showInformationMessage(
			`${t('Release Notes')} (${version})`,
			{ modal: false },
			t('Open Downloads Page'),
			t('Dismiss')
		);
		if (selection === t('Open Downloads Page')) {
			await vscode.env.openExternal(vscode.Uri.parse(DOWNLOADS_PAGE_URL));
		}
	}
}

function buildDownloadUrl(version: string, info: PlatformInfo): string {
	// Linux has an extra path segment: /deb/ or /tar/ before the filename
	let extraPath = '';
	if (info.platform === 'linux') {
		extraPath = info.ext === 'tar.gz' ? 'tar/' : `${info.ext}/`;
	}
	return `https://prod.download.desktop.kiro.dev/releases/stable/${info.platform}-${info.arch}/signed/${version}/${extraPath}kiro-ide-${version}-stable-${info.platform}-${info.arch}.${info.ext}`;
}

export function deactivate() {
	log('Kiro Update Checker deactivated.');
}

// Exported for unit testing
export { compareVersions, formatBytes, buildDownloadUrl, parseVersionFromHTML, detectPlatform, detectLinuxDistro };
