import * as vscode from 'vscode';
import * as https from 'https';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as crypto from 'crypto';
import { execFileSync } from 'child_process';
import { IncomingMessage } from 'http';
import { setLogSink, log } from './log';
import { resolveSafeUrl, validateDownloadUrl } from './urls';
import { compareVersions, parseVersionFromHTML, parseChangelogUrlFromHTML, PreferredPlatform } from './version';
import { buildDownloadUrl, detectPlatform, PlatformInfo } from './platform';
import { FeedInfo, feedTargets, parseMetadataFeed } from './feed';

const DOWNLOADS_PAGE_URL = 'https://kiro.dev/downloads/';
const FALLBACK_CHANGELOG_URL = 'https://kiro.dev/changelog/';
const DEFAULT_UPDATE_URL = 'https://prod.download.desktop.kiro.dev';
const DEFAULT_QUALITY = 'stable';
const STATE_KEY_DISMISSED_VERSION = 'kiroUpdateChecker.dismissedVersion';
const STATE_KEY_INSTALLER_PREFIX = 'kiroUpdateChecker.installer.';
const MAX_PAGE_SIZE_BYTES = 5 * 1024 * 1024;
const MAX_FEED_SIZE_BYTES = 1024 * 1024;
const MAX_INSTALLER_SIZE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const HEAD_TIMEOUT_MS = 10000;
const PAGE_TIMEOUT_MS = 15000;
const DOWNLOAD_TIMEOUT_MS = 120000;
const MIN_CHECK_INTERVAL_MINUTES = 5;
const MAX_CHECK_INTERVAL_MINUTES = 24 * 60;
const INSTALLER_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

let outputChannel: vscode.OutputChannel | null = null;
let extensionVersion = '';
let checkInFlight: Promise<void> | null = null;
let intervalHandle: NodeJS.Timeout | null = null;

function userAgentStr(): string {
	return `KiroUpdateChecker/${extensionVersion}`;
}

interface KiroProductInfo {
	version: string | null;
	updateUrl: string;
	quality: string;
	installTarget: string;
}

function readKiroProductInfo(): KiroProductInfo {
	const defaults: KiroProductInfo = {
		version: null,
		updateUrl: DEFAULT_UPDATE_URL,
		quality: DEFAULT_QUALITY,
		installTarget: ''
	};
	try {
		const productPath = path.join(vscode.env.appRoot, 'product.json');
		if (!fs.existsSync(productPath)) {
			return defaults;
		}
		const json = JSON.parse(fs.readFileSync(productPath, 'utf8'));
		return {
			version: typeof json.version === 'string' && INSTALLER_VERSION_PATTERN.test(json.version.trim())
				? json.version.trim()
				: null,
			updateUrl: typeof json.updateUrl === 'string' && json.updateUrl.trim()
				? json.updateUrl.trim()
				: defaults.updateUrl,
			quality: typeof json.quality === 'string' && json.quality.trim()
				? json.quality.trim()
				: defaults.quality,
			installTarget: typeof json.target === 'string' ? json.target.trim() : ''
		};
	} catch (e) {
		log(`Failed to read product.json: ${e}`);
	}
	return defaults;
}

function isKiro(): boolean {
	try {
		const appRoot = vscode.env.appRoot;
		if (appRoot) {
			const productPath = path.join(appRoot, 'product.json');
			if (fs.existsSync(productPath)) {
				try {
					const product = JSON.parse(fs.readFileSync(productPath, 'utf8'));
					if (product.applicationName === 'kiro') { return true; }
					if (typeof product.urlProtocol === 'string' && product.urlProtocol.toLowerCase() === 'kiro') { return true; }
					if (typeof product.dataFolderName === 'string' && /^\.?kiro$/i.test(product.dataFolderName)) { return true; }
					if (typeof product.nameShort === 'string' && /kiro/i.test(product.nameShort)) { return true; }
					if (typeof product.nameLong === 'string' && /kiro/i.test(product.nameLong)) { return true; }
				} catch (e) {
					log(`Failed to parse product.json: ${e}`);
				}
			}
		}

		if (/kiro/i.test(vscode.env.appName || '')) {
			return true;
		}
	} catch (e) {
		log(`Kiro detection failed: ${e}`);
	}
	return false;
}

interface InstallerRecord {
	filePath: string;
	size: number;
	version: string;
}

export function activate(context: vscode.ExtensionContext) {
	extensionVersion = context.extension.packageJSON.version || '0.1.0';

	outputChannel = vscode.window.createOutputChannel('Kiro Update Checker');
	context.subscriptions.push(outputChannel);
	setLogSink(message => {
		outputChannel?.appendLine(`[${new Date().toLocaleTimeString()}] ${message}`);
	});

	log('Kiro Update Checker activated.');

	if (!isKiro()) {
		log('Not running on Kiro IDE. Extension will not be active.');
		log(`Detected appName: "${vscode.env.appName}"`);
		vscode.window.showInformationMessage(
			vscode.l10n.t('Kiro Update Checker: This extension only works on Kiro IDE.'),
			{ modal: false }
		);
		return;
	}

	log('Kiro IDE detected. Extension is active.');

	context.subscriptions.push(vscode.commands.registerCommand('kiro-update-checker.checkNow', () => {
		void checkForUpdates(context, true);
	}));

	// React to configuration changes at runtime
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration(e => {
			if (!e.affectsConfiguration('kiroUpdateChecker')) { return; }
			log('Configuration changed.');
			if (e.affectsConfiguration('kiroUpdateChecker.checkInterval')) {
				scheduleInterval(context);
			}
		})
	);

	context.subscriptions.push({
		dispose: () => {
			if (intervalHandle) {
				clearInterval(intervalHandle);
				intervalHandle = null;
			}
		}
	});

	// Check for updates on startup if enabled in settings
	const config = vscode.workspace.getConfiguration('kiroUpdateChecker');
	if (config.get<boolean>('enableOnStartup', true)) {
		log('Checking for updates on startup...');
		void checkForUpdates(context);
	} else {
		log('Update check on startup is disabled.');
	}

	scheduleInterval(context);
}

function scheduleInterval(context: vscode.ExtensionContext): void {
	if (intervalHandle) {
		clearInterval(intervalHandle);
		intervalHandle = null;
	}

	const config = vscode.workspace.getConfiguration('kiroUpdateChecker');
	const configured = config.get<number>('checkInterval', 60);

	if (typeof configured !== 'number' || !Number.isFinite(configured) || configured <= 0) {
		log('Periodic update checks are disabled.');
		return;
	}

	let minutes = Math.floor(configured);
	if (minutes < MIN_CHECK_INTERVAL_MINUTES) {
		log(`Clamping checkInterval from ${minutes} to ${MIN_CHECK_INTERVAL_MINUTES} minutes.`);
		minutes = MIN_CHECK_INTERVAL_MINUTES;
	}
	if (minutes > MAX_CHECK_INTERVAL_MINUTES) {
		log(`Clamping checkInterval from ${minutes} to ${MAX_CHECK_INTERVAL_MINUTES} minutes.`);
		minutes = MAX_CHECK_INTERVAL_MINUTES;
	}

	log(`Scheduling periodic update checks every ${minutes} minute(s).`);
	intervalHandle = setInterval(() => {
		void checkForUpdates(context);
	}, minutes * 60 * 1000);
}

function checkForUpdates(context: vscode.ExtensionContext, manualCheck: boolean = false): Promise<void> {
	if (checkInFlight) {
		log('An update check is already in progress; skipping duplicate request.');
		if (manualCheck) {
			void vscode.window.showInformationMessage(
				vscode.l10n.t('Kiro Update Checker: An update check is already in progress.')
			);
		}
		return checkInFlight;
	}

	checkInFlight = runCheckForUpdates(context, manualCheck).finally(() => {
		checkInFlight = null;
	});
	return checkInFlight;
}

async function runCheckForUpdates(context: vscode.ExtensionContext, manualCheck: boolean): Promise<void> {
	try {
		log('Fetching the latest Kiro version...');
		const versionInfo = await fetchLatestVersion();

		if (!versionInfo) {
			log('Could not determine the latest version.');

			if (manualCheck) {
				void vscode.window.showInformationMessage(vscode.l10n.t('Could not determine the latest Kiro version. Please try again later.'));
			}
			return;
		}

		const { version: latestVersion, changelogUrl: latestChangelogUrl } = versionInfo;

		log(`Latest Kiro version found: ${latestVersion}`);

		const currentVersion = getCurrentKiroVersion();

		if (!currentVersion) {
			log('Could not determine the current Kiro version.');

			if (manualCheck) {
				const downloadBtn = vscode.l10n.t('Download Latest');
				const openPageBtn = vscode.l10n.t('Open Downloads Page');
				const selection = await vscode.window.showWarningMessage(
					vscode.l10n.t('Could not determine the current Kiro version. Please ensure Kiro is installed.'),
					downloadBtn,
					openPageBtn
				);
				if (selection === downloadBtn) {
					const info = detectCurrentPlatform();
					if (!info) {
						log('Unsupported platform for direct download. Opening browser page.');
						await openExternalSafe(DOWNLOADS_PAGE_URL, 'downloads page');
					} else {
						const downloadUrl = buildDownloadUrl(latestVersion, info);
						log(`Opening browser to download URL: ${downloadUrl}`);
						await openExternalSafe(downloadUrl, 'download URL');
					}
				} else if (selection === openPageBtn) {
					await openExternalSafe(DOWNLOADS_PAGE_URL, 'downloads page');
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

			if (autoDownload && !vscode.workspace.isTrusted) {
				log('Workspace is not trusted; falling back to manual download.');
				await handleManualDownload(context, currentVersion, latestVersion, latestChangelogUrl);
			} else if (autoDownload) {
				log('Automatic download enabled.');
				await handleAutoDownload(context, currentVersion, latestVersion, latestChangelogUrl);
			} else {
				await handleManualDownload(context, currentVersion, latestVersion, latestChangelogUrl);
			}
		} else if (manualCheck) {
			void vscode.window.showInformationMessage(
				vscode.l10n.t('✅ Kiro is up to date! Installed version: {0}', currentVersion)
			);
		}
	} catch (error) {
		log(`Error occurred while checking for updates: ${error}`);

		if (manualCheck) {
			void vscode.window.showErrorMessage(vscode.l10n.t('An error occurred while checking for updates. Please try again later.'));
		}
	}
}

async function handleManualDownload(context: vscode.ExtensionContext, currentVersion: string, latestVersion: string, changelogUrl: string): Promise<void> {
	log('Mode: Manual download (open browser).');
	const downloadBtn = vscode.l10n.t('Download Latest');
	const releaseNotesBtn = vscode.l10n.t('Release Notes');
	const dismissBtn = vscode.l10n.t('Dismiss');

	const selection = await vscode.window.showWarningMessage(
		vscode.l10n.t('🚀 New Kiro version available! {0} -> {1}.', currentVersion, latestVersion),
		{ modal: false },
		downloadBtn,
		releaseNotesBtn,
		dismissBtn
	);

	if (selection === downloadBtn) {
		const info = detectCurrentPlatform();
		if (!info) {
			log('Unsupported platform. Opening downloads page instead.');
			await openExternalSafe(DOWNLOADS_PAGE_URL, 'downloads page');
			return;
		}
		const downloadUrl = buildDownloadUrl(latestVersion, info);
		log(`Opening browser to download URL: ${downloadUrl}`);
		await openExternalSafe(downloadUrl, 'download URL');
	} else if (selection === releaseNotesBtn) {
		log(`Opening changelog for version ${latestVersion}`);
		await openExternalSafe(changelogUrl, 'changelog');
	} else if (selection === dismissBtn) {
		log(`User dismissed notifications for version ${latestVersion}.`);
		await context.globalState.update(STATE_KEY_DISMISSED_VERSION, latestVersion);
	}
}

interface UrlCheckResult {
	status: number | null;
	size: number;
}

function detectCurrentPlatform(): PlatformInfo | null {
	const config = vscode.workspace.getConfiguration('kiroUpdateChecker');
	const packageFormat = config.get<string>('packageFormat', 'auto');
	return detectPlatform(process.platform, process.arch, packageFormat);
}

function getDownloadFolder(): string {
	const config = vscode.workspace.getConfiguration('kiroUpdateChecker');
	const customPath = config.get<string>('downloadFolder', '').trim();

	if (customPath) {
		try {
			const resolved = path.resolve(customPath);
			fs.mkdirSync(resolved, { recursive: true });
			if (fs.statSync(resolved).isDirectory()) {
				log(`Using custom download folder: ${resolved}`);
				return resolved;
			}
			log(`Custom download folder is not a directory: ${resolved}`);
		} catch (e) {
			log(`Custom folder invalid (${customPath}), falling back to default: ${e}`);
		}
	}

	const defaultPath = defaultDownloadFolder();
	fs.mkdirSync(defaultPath, { recursive: true });
	log(`Using download folder: ${defaultPath}`);
	return defaultPath;
}

function defaultDownloadFolder(): string {
	if (process.platform === 'linux') {
		try {
			const xdgDownload = execFileSync('xdg-user-dir', ['DOWNLOAD'], { timeout: 2000, encoding: 'utf8' }).trim();
			if (xdgDownload && xdgDownload !== os.homedir() && fs.existsSync(xdgDownload)) {
				return xdgDownload;
			}
		} catch {
			// xdg-user-dir not available; fall through to ~/Downloads
		}
	}
	return path.join(os.homedir(), 'Downloads');
}

function resolveWithin(folder: string, fileName: string): string | null {
	if (path.basename(fileName) !== fileName) {
		return null;
	}
	const base = path.resolve(folder);
	const target = path.resolve(base, fileName);
	if (!target.startsWith(base + path.sep)) {
		return null;
	}
	return target;
}

function isRecordedInstaller(context: vscode.ExtensionContext, version: string, filePath: string): boolean {
	const record = context.globalState.get<InstallerRecord>(`${STATE_KEY_INSTALLER_PREFIX}${version}`);
	if (!record || record.filePath !== filePath || !Number.isFinite(record.size) || record.size <= 0) {
		return false;
	}
	try {
		return fs.statSync(filePath).size === record.size;
	} catch {
		return false;
	}
}

async function checkUrl(url: string): Promise<UrlCheckResult | null> {
	const safeUrl = validateDownloadUrl(url);
	if (!safeUrl) {
		log(`Blocked HEAD check to untrusted URL: ${url}`);
		return null;
	}
	return new Promise((resolve) => {
		let settled = false;
		const done = (value: UrlCheckResult | null) => {
			if (settled) { return; }
			settled = true;
			resolve(value);
		};
		const request = https.request(safeUrl, {
			method: 'HEAD',
			headers: { 'User-Agent': userAgentStr() },
			timeout: HEAD_TIMEOUT_MS
		}, (response) => {
			const contentLength = parseInt(response.headers['content-length'] || '', 10);
			response.resume();
			response.on('error', () => done(null));
			done({
				status: response.statusCode || null,
				size: Number.isFinite(contentLength) && contentLength > 0 ? contentLength : 0
			});
		});
		request.on('error', () => done(null));
		request.on('timeout', () => {
			request.destroy();
			done(null);
		});
		request.end();
	});
}

async function handleAutoDownload(context: vscode.ExtensionContext, currentVersion: string, latestVersion: string, changelogUrl: string): Promise<void> {
	log('Mode: Auto-download.');
	const info = detectCurrentPlatform();
	if (!info) {
		log('Unsupported platform for auto-download. Falling back to manual download.');
		await handleManualDownload(context, currentVersion, latestVersion, changelogUrl);
		return;
	}

	const downloadUrl = buildDownloadUrl(latestVersion, info);
	const safeDownloadUrl = validateDownloadUrl(downloadUrl);
	if (!safeDownloadUrl) {
		log(`Blocked download to untrusted URL: ${downloadUrl}`);
		await showDownloadError(latestVersion);
		return;
	}

	const check = await checkUrl(safeDownloadUrl);
	if (!check || !check.status || check.status < 200 || check.status >= 300) {
		log(`Download URL returned ${check ? check.status : 'no response'} for: ${downloadUrl}`);
		const openPageBtn = vscode.l10n.t('Open Downloads Page');
		const selection = await vscode.window.showErrorMessage(
			vscode.l10n.t('❌ Kiro Update Checker: Direct download not available for your platform ({0}). Visit the downloads page.', info.ext),
			openPageBtn
		);
		if (selection === openPageBtn) {
			await openExternalSafe(DOWNLOADS_PAGE_URL, 'downloads page');
		}
		return;
	}

	const downloadFolder = getDownloadFolder();
	const fileName = `kiro-ide-${latestVersion}-stable-${info.platform}-${info.arch}.${info.ext}`;

	if (!INSTALLER_VERSION_PATTERN.test(latestVersion)) {
		log(`Refusing install for unexpected version format: ${latestVersion}`);
		await showDownloadError(latestVersion);
		return;
	}

	const filePath = resolveWithin(downloadFolder, fileName);
	if (!filePath) {
		log(`Refusing path outside the download folder: ${fileName}`);
		await showDownloadError(latestVersion);
		return;
	}
	const partPath = `${filePath}.part`;

	if (fs.existsSync(filePath)) {
		// Only trust a file this extension downloaded and recorded for this version;
		// anything else is treated as tampered/stale and replaced after a fresh download.
		if (isRecordedInstaller(context, latestVersion, filePath)) {
			log(`Installer already downloaded by this extension at ${filePath}.`);
			showInstallNotification(context, currentVersion, latestVersion, filePath, changelogUrl);
			return;
		}
		log('Existing installer file was not recorded by this extension. Re-downloading.');
	}

	log(`Downloading installer from ${downloadUrl} to ${filePath}...`);

	await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: vscode.l10n.t('⤵️ Kiro Update Checker: Downloading {0}', latestVersion),
			cancellable: true
		},
		(progress, token) => new Promise<void>((resolve) => {
			let settled = false;
			let cancelled = false;
			let activeRequest: ReturnType<typeof https.get> | null = null;
			let activeStream: fs.WriteStream | null = null;

			const finish = () => {
				if (settled) { return; }
				settled = true;
				resolve();
			};

			const cleanupPart = () => {
				try { fs.unlinkSync(partPath); } catch { /* ignore */ }
			};

			token.onCancellationRequested(() => {
				cancelled = true;
				log('Download cancelled by user.');
				activeRequest?.destroy();
				activeStream?.destroy();
				cleanupPart();
				finish();
			});

			const downloadFile = (url: string, redirectDepth: number) => {
				if (settled) { return; }
				if (redirectDepth > MAX_REDIRECTS) {
					log('Too many redirects. Aborting download.');
					void showDownloadError(latestVersion);
					finish();
					return;
				}

				let attemptDone = false;

				const attemptFail = (message: string) => {
					if (attemptDone) { return; }
					attemptDone = true;
					activeStream?.destroy();
					activeStream = null;
					activeRequest = null;
					cleanupPart();
					log(message);
					if (!cancelled) {
						void showDownloadError(latestVersion);
					}
					finish();
				};

				const request = https.get(url, {
					headers: { 'User-Agent': userAgentStr() },
					timeout: DOWNLOAD_TIMEOUT_MS
				}, response => {
					const status = response.statusCode || 0;

					if (status >= 300 && status < 400 && response.headers.location) {
						const location = response.headers.location;
						log(`Redirected to ${location}`);
						const redirectUrl = resolveSafeUrl(location, url);

						// Detach the abandoned attempt so late socket events cannot
						// interfere with the new one (e.g. deleting its .part file).
						attemptDone = true;
						activeRequest = null;
						request.removeAllListeners();
						response.removeAllListeners();
						response.destroy();

						if (!redirectUrl) {
							log('Blocked redirect to untrusted destination during download.');
							void showDownloadError(latestVersion);
							finish();
							return;
						}
						downloadFile(redirectUrl, redirectDepth + 1);
						return;
					}

					if (status !== 200) {
						response.resume();
						attemptFail(`Failed to download file. Status code: ${status}`);
						return;
					}

					const parsedLength = parseInt(response.headers['content-length'] || '', 10);
					const totalSize = Number.isFinite(parsedLength) && parsedLength > 0 ? parsedLength : 0;
					let downloadedSize = 0;

					cleanupPart();
					try {
						activeStream = fs.createWriteStream(partPath, { flags: 'wx' });
					} catch (err) {
						attemptFail(`Failed to create download file: ${err}`);
						return;
					}
					const fileStream = activeStream;

					response.on('data', (chunk: Buffer) => {
						if (attemptDone || settled) { return; }
						downloadedSize += chunk.length;

						if (downloadedSize > MAX_INSTALLER_SIZE_BYTES) {
							response.destroy();
							attemptFail(`Installer exceeds the maximum allowed size (${formatBytes(MAX_INSTALLER_SIZE_BYTES)}).`);
							return;
						}

						if (totalSize > 0) {
							const percentage = Math.round((downloadedSize / totalSize) * 100);
							progress.report({
								increment: (chunk.length / totalSize) * 100,
								message: `${percentage}% (${formatBytes(downloadedSize)} / ${formatBytes(totalSize)})`
							});
						}
					});

					response.pipe(fileStream);

					response.on('error', (err) => {
						attemptFail(`Error reading download response: ${err.message}`);
					});

					fileStream.on('finish', () => {
						if (attemptDone || settled) { return; }
						if (totalSize > 0 && downloadedSize !== totalSize) {
							attemptFail(`Download incomplete: expected ${totalSize} bytes, got ${downloadedSize}.`);
							return;
						}
						attemptDone = true;
						try {
							fs.renameSync(partPath, filePath);
						} catch (err) {
							cleanupPart();
							log(`Failed to finalize installer file: ${err}`);
							void vscode.window.showErrorMessage(
								vscode.l10n.t('❌ Kiro Update Checker: Error saving the installer. {0}', String(err))
							);
							finish();
							return;
						}
						log(`Download completed: ${filePath} (${formatBytes(downloadedSize)})`);
						void context.globalState.update(`${STATE_KEY_INSTALLER_PREFIX}${latestVersion}`, {
							filePath,
							size: downloadedSize,
							version: latestVersion
						} satisfies InstallerRecord).then(undefined, err => log(`Failed to record installer: ${err}`));
						showInstallNotification(context, currentVersion, latestVersion, filePath, changelogUrl);
						finish();
					});

					fileStream.on('error', (err: NodeJS.ErrnoException) => {
						attemptFail(`Error writing file to ${partPath}: ${err.message} (code: ${err.code})`);
					});
				});

				activeRequest = request;

				request.on('error', (err) => {
					attemptFail(`Error during download: ${err.message}`);
				});

				request.on('timeout', () => {
					request.destroy();
					attemptFail(`Download request timed out (${DOWNLOAD_TIMEOUT_MS / 1000} seconds).`);
				});
			};

			downloadFile(safeDownloadUrl, 0);
		})
	);
}

async function showDownloadError(latestVersion: string): Promise<void> {
	await vscode.window.showErrorMessage(
		vscode.l10n.t('❌ Kiro Update Checker: Failed to download {0}. Try manually.', latestVersion)
	);
}

function showInstallNotification(context: vscode.ExtensionContext, currentVersion: string, latestVersion: string, filePath: string, changelogUrl: string): void {
	const installBtn = vscode.l10n.t('Install Now');
	const openFolderBtn = vscode.l10n.t('Open folder');
	const releaseNotesBtn = vscode.l10n.t('Release Notes');
	const dismissBtn = vscode.l10n.t('Dismiss');

	void vscode.window.showInformationMessage(
		vscode.l10n.t('🚀 New Kiro version ready to install! {0} -> {1}.', currentVersion, latestVersion),
		{ modal: false },
		installBtn,
		openFolderBtn,
		releaseNotesBtn,
		dismissBtn
	).then(async selection => {
		if (selection === installBtn) {
			// Hand the downloaded installer to the system handler (no terminal window).
			await openInstallerFile(filePath);
		} else if (selection === openFolderBtn) {
			const folderPath = path.dirname(filePath);
			log(`Opening folder: ${folderPath}`);
			try {
				const opened = await vscode.env.openExternal(vscode.Uri.file(folderPath));
				if (!opened) {
					log('Failed to open folder.');
				}
			} catch (err) {
				log(`Error opening folder: ${err}`);
			}
		} else if (selection === releaseNotesBtn) {
			log(`Opening changelog for version ${latestVersion}`);
			await openExternalSafe(changelogUrl, 'changelog');
		} else if (selection === dismissBtn) {
			log(`User dismissed version ${latestVersion}.`);
			await context.globalState.update(STATE_KEY_DISMISSED_VERSION, latestVersion);
		}
	}, err => log(`Install notification failed: ${err}`));
}

async function openInstallerFile(filePath: string): Promise<void> {
	try {
		const opened = await vscode.env.openExternal(vscode.Uri.file(filePath));
		if (!opened) {
			log(`Failed to open installer with the system handler: ${filePath}`);
		}
	} catch (err) {
		log(`Error opening installer: ${err}`);
	}
}

async function openExternalSafe(url: string, label: string): Promise<void> {
	const safeUrl = validateDownloadUrl(url);
	if (!safeUrl) {
		log(`Refusing to open untrusted ${label} URL: ${url}`);
		return;
	}
	try {
		const opened = await vscode.env.openExternal(vscode.Uri.parse(safeUrl));
		if (!opened) {
			log(`Failed to open ${label}.`);
		}
	} catch (err) {
		log(`Error opening ${label}: ${err}`);
	}
}

function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) {
		return '0 Bytes';
	}

	const k = 1024;
	const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
	const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
	return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

interface VersionInfo {
	version: string;
	changelogUrl: string;
}

function fetchJson(url: string, maxBytes: number, timeoutMs: number, depth: number = 0): Promise<unknown | null> {
	const safeUrl = validateDownloadUrl(url);
	if (!safeUrl) {
		log(`Blocked untrusted feed URL: ${url}`);
		return Promise.resolve(null);
	}
	return new Promise((resolve) => {
		let settled = false;
		const done = (value: unknown | null) => {
			if (settled) { return; }
			settled = true;
			resolve(value);
		};
		const request = https.get(safeUrl, {
			headers: { 'User-Agent': userAgentStr() },
			timeout: timeoutMs
		}, (response) => {
			const status = response.statusCode || 0;

			if (status >= 300 && status < 400 && response.headers.location) {
				const location = response.headers.location;
				const redirectUrl = resolveSafeUrl(location, safeUrl);
				request.removeAllListeners();
				response.removeAllListeners();
				response.destroy();
				if (!redirectUrl || depth >= MAX_REDIRECTS) {
					log('Blocked or excessive redirect while fetching feed.');
					done(null);
					return;
				}
				fetchJson(redirectUrl, maxBytes, timeoutMs, depth + 1).then(done);
				return;
			}

			if (status !== 200) {
				log(`Feed request returned status ${status}: ${safeUrl}`);
				response.resume();
				done(null);
				return;
			}

			let total = 0;
			const chunks: Buffer[] = [];
			response.on('data', (chunk: Buffer) => {
				total += chunk.length;
				if (total > maxBytes) {
					log('Feed response exceeded the size limit.');
					response.destroy();
					done(null);
					return;
				}
				chunks.push(chunk);
			});
			response.on('end', () => {
				try {
					done(JSON.parse(Buffer.concat(chunks).toString('utf8')));
				} catch (err) {
					log(`Failed to parse feed JSON: ${err}`);
					done(null);
				}
			});
			response.on('error', (err) => {
				log(`Feed response error: ${err.message}`);
				done(null);
			});
		});
		request.on('error', (err) => {
			log(`Feed request error: ${err.message}`);
			done(null);
		});
		request.on('timeout', () => {
			request.destroy();
			log(`Feed request timed out (${timeoutMs / 1000} seconds).`);
			done(null);
		});
	});
}

async function fetchVersionFeed(targets: string[], updateUrl: string, quality: string): Promise<FeedInfo | null> {
	if (targets.length === 0) {
		return null;
	}
	const base = updateUrl.replace(/\/+$/, '');
	for (const target of targets) {
		const url = `${base}/${quality}/metadata-${target}-${quality}.json`;
		const payload = await fetchJson(url, MAX_FEED_SIZE_BYTES, PAGE_TIMEOUT_MS);
		if (!payload) { continue; }
		const feed = parseMetadataFeed(payload);
		if (feed) {
			log(`Version feed (${target}): ${feed.version}`);
			return feed;
		}
		log(`Feed (${target}) returned an unexpected payload shape.`);
	}
	return null;
}

function fallbackChangelogUrl(version: string): string {
	const url = `https://kiro.dev/changelog/ide/${version.replace(/\./g, '-')}/`;
	return validateDownloadUrl(url) ?? FALLBACK_CHANGELOG_URL;
}

async function fetchLatestVersion(): Promise<VersionInfo | null> {
	const product = readKiroProductInfo();
	const platform = detectCurrentPlatform();
	const targets = platform ? feedTargets(platform.platform, platform.arch, product.installTarget) : [];

	const [feed, fromHtml] = await Promise.all([
		fetchVersionFeed(targets, product.updateUrl, product.quality),
		fetchVersionFromHtml(platform ?? undefined)
	]);

	if (feed) {
		if (fromHtml && fromHtml.version !== feed.version) {
			log(`Version mismatch: feed=${feed.version}, page=${fromHtml.version}; trusting the feed.`);
		}
		return {
			version: feed.version,
			changelogUrl: fromHtml?.changelogUrl ?? fallbackChangelogUrl(feed.version)
		};
	}

	if (fromHtml) {
		log('Version feed unavailable; using the downloads page result.');
		return fromHtml;
	}

	return null;
}

function fetchVersionFromHtml(platformHint?: PreferredPlatform): Promise<VersionInfo | null> {
	return new Promise((resolve) => {
		let settled = false;
		const done = (value: VersionInfo | null) => {
			if (settled) { return; }
			settled = true;
			resolve(value);
		};

		const followRedirect = (url: string, depth: number) => {
			if (depth > MAX_REDIRECTS) {
				log('Too many redirects fetching downloads page.');
				done(null);
				return;
			}
			const request = https.get(url, {
				headers: { 'User-Agent': userAgentStr() },
				timeout: PAGE_TIMEOUT_MS
			}, (response) => {
				if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
					const location = response.headers.location;
					log(`Redirected to ${location}`);
					const redirectUrl = resolveSafeUrl(location, url);

					request.removeAllListeners();
					response.removeAllListeners();
					response.destroy();

					if (!redirectUrl) {
						log('Blocked redirect to untrusted destination while fetching downloads page.');
						done(null);
						return;
					}
					followRedirect(redirectUrl, depth + 1);
					return;
				}

				if (response.statusCode !== 200) {
					log(`Unexpected status code fetching downloads page: ${response.statusCode}`);
					response.resume();
					done(null);
					return;
				}

				log(`Fetching downloads page. Status code: ${response.statusCode}`);
				handleResponse(response, platformHint, done);
			});
			request.on('error', (err) => {
				log(`Error fetching downloads page: ${err.message}`);
				done(null);
			});
			request.on('timeout', () => {
				log(`Request to fetch downloads page timed out (${PAGE_TIMEOUT_MS / 1000} seconds).`);
				request.destroy();
				done(null);
			});
		};

		followRedirect(DOWNLOADS_PAGE_URL, 0);
	});
}

function handleResponse(response: IncomingMessage, platformHint: PreferredPlatform | undefined, resolve: (value: VersionInfo | null) => void) {
	const chunks: Buffer[] = [];
	let totalBytes = 0;
	let capped = false;

	response.on('data', (chunk: Buffer) => {
		if (capped) { return; }
		totalBytes += chunk.length;
		if (totalBytes > MAX_PAGE_SIZE_BYTES) {
			capped = true;
			log('HTML content exceeded size limit; aborting download of the downloads page.');
			response.destroy();
			resolve(null);
			return;
		}
		chunks.push(chunk);
	});

	response.on('end', () => {
		if (capped) { return; }
		log('HTML content fetched. Extracting version...');
		const html = Buffer.concat(chunks).toString('utf8');
		const version = parseVersionFromHTML(html, platformHint);

		if (version) {
			log(`Extracted version from page: ${version}`);
			const changelogUrl = parseChangelogUrlFromHTML(html);
			if (changelogUrl) {
				log(`Extracted changelog URL: ${changelogUrl}`);
			} else {
				log('Could not extract changelog URL from HTML, using generic fallback.');
			}
			resolve({ version, changelogUrl: changelogUrl || FALLBACK_CHANGELOG_URL });
		} else {
			const digest = crypto.createHash('sha256').update(html).digest('hex').slice(0, 16);
			log(`Could not extract version from HTML (size: ${totalBytes} bytes, sha256: ${digest}).`);
			resolve(null);
		}
	});

	response.on('error', (err) => {
		if (capped) { return; }
		log(`Error reading response: ${err.message}`);
		resolve(null);
	});
}

function getCurrentKiroVersion(): string | null {
	const fromProduct = readKiroProductInfo().version;
	if (fromProduct) {
		log(`Current Kiro version from product.json: ${fromProduct}`);
		return fromProduct;
	}

	try {
		const appRoot = vscode.env.appRoot;
		log(`VSCode/Kiro appRoot: ${appRoot}`);

		const candidatePaths: string[] = [
			path.join(appRoot, 'resources', 'app', 'product.json'),
			path.join(appRoot, 'package.json'),
			path.join(appRoot, '..', 'package.json')
		];

		for (const candidatePath of candidatePaths) {
			if (!fs.existsSync(candidatePath)) { continue; }
			try {
				const json = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
				const raw = json.version || json.KiroVersion || json.kiroVersion;
				if (typeof raw === 'string') {
					const version = raw.trim();
					if (INSTALLER_VERSION_PATTERN.test(version)) {
						log(`Found version ${version} in ${candidatePath}`);
						return version;
					}
					log(`${candidatePath} has a version field in an unexpected format: "${version}"`);
				}
			} catch (e) {
				log(`Failed to parse ${candidatePath}: ${e}`);
			}
		}

		log('No version found in any candidate location.');
	} catch (error) {
		log(`Error reading current Kiro version: ${error}`);
	}

	return null;
}

export function deactivate() {
	log('Kiro Update Checker deactivated.');
	setLogSink(null);
	outputChannel = null;
}

// Exported for unit testing
export { formatBytes, isKiro, getCurrentKiroVersion };
