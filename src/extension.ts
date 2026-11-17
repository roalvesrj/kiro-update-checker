import * as vscode from 'vscode';
import * as https from 'https';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as crypto from 'crypto';
import { execFileSync, spawn, type ChildProcess } from 'child_process';
import { IncomingMessage } from 'http';
import { setLogSink, log } from './log';
import { resolveSafeUrl, validateDownloadUrl } from './urls';
import { compareVersions, parseChangelogSlugsFromIndex, parseVersion, parseVersionFromHTML, pickChangelogUrl, PreferredPlatform } from './version';
import { buildDownloadUrl, detectPlatform, PlatformInfo } from './platform';
import { artifactFor, FeedArtifact, FeedInfo, feedTargets, parseMetadataFeed } from './feed';

const DOWNLOADS_PAGE_URL = 'https://kiro.dev/downloads/';
const FALLBACK_CHANGELOG_URL = 'https://kiro.dev/changelog/';
const DEFAULT_UPDATE_URL = 'https://prod.download.desktop.kiro.dev';
const DEFAULT_QUALITY = 'stable';
const STATE_KEY_DISMISSED_VERSION = 'kiroUpdateChecker.dismissedVersion';
const STATE_KEY_INSTALLER_PREFIX = 'kiroUpdateChecker.installer.';
const STATE_KEY_PENDING_UPDATE = 'kiroUpdateChecker.pendingUpdate';
const STATE_KEY_PENDING_FLAG = 'kiroUpdateChecker.pendingFlagPath';
const MAX_PAGE_SIZE_BYTES = 5 * 1024 * 1024;
const MAX_FEED_SIZE_BYTES = 1024 * 1024;
const MAX_INSTALLER_SIZE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const HEAD_TIMEOUT_MS = 10000;
const PAGE_TIMEOUT_MS = 15000;
const DOWNLOAD_TIMEOUT_MS = 120000;
const MIN_CHECK_INTERVAL_MINUTES = 5;
const MAX_CHECK_INTERVAL_MINUTES = 24 * 60;
const CHANGELOG_TIMEOUT_MS = 5000;
const INSTALLER_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const QUALITY_PATTERN = /^[A-Za-z0-9._-]+$/;

let outputChannel: vscode.OutputChannel | null = null;
let extensionVersion = '';
let checkInFlight: Promise<void> | null = null;
let intervalHandle: NodeJS.Timeout | null = null;
let windowsUpdateFlagPath: string | null = null;
let restartRequested = false;
let extensionContext: vscode.ExtensionContext | null = null;

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
			quality: typeof json.quality === 'string' && QUALITY_PATTERN.test(json.quality.trim())
				? json.quality.trim()
				: defaults.quality,
			installTarget: typeof json.target === 'string' ? json.target.trim() : ''
		};
	} catch (e) {
		log(`Failed to read product.json: ${e}`);
	}
	return defaults;
}

interface UpdatePreferences {
	autoDownload: boolean;
	autoInstall: boolean;
}

function readUpdatePreferences(): UpdatePreferences {
	const config = vscode.workspace.getConfiguration('kiroUpdateChecker');
	const objectInspect = config.inspect<{ download?: unknown; install?: unknown }>('update');
	const objectIsSet = !!objectInspect && objectInspect.globalValue !== undefined;

	if (objectIsSet) {
		const value = config.get<{ download?: unknown; install?: unknown }>('update') ?? {};
		const autoDownload = value.download === true;
		if (value.install === true && !autoDownload) {
			log('The "install" option requires "download"; ignoring it.');
		}
		return { autoDownload, autoInstall: autoDownload && value.install === true };
	}

	// Legacy flat settings (pre-0.4.0); migrated on activation but still honored.
	const autoDownload = config.get<boolean>('autoDownload', false);
	const autoInstallSetting = config.get<boolean>('autoInstall', false);
	if (autoInstallSetting && !autoDownload) {
		log('autoInstall requires autoDownload; ignoring it.');
	}
	return { autoDownload, autoInstall: autoDownload && autoInstallSetting };
}

async function migrateLegacyUpdateSettings(): Promise<void> {
	const config = vscode.workspace.getConfiguration('kiroUpdateChecker');
	const objectInspect = config.inspect('update');
	if (objectInspect && objectInspect.globalValue !== undefined) {
		return;
	}
	const legacyDownload = config.inspect<boolean>('autoDownload')?.globalValue;
	const legacyInstall = config.inspect<boolean>('autoInstall')?.globalValue;
	if (legacyDownload === undefined && legacyInstall === undefined) {
		return;
	}
	await config.update('update', {
		download: legacyDownload === true,
		install: legacyDownload === true && legacyInstall === true
	}, vscode.ConfigurationTarget.Global);
	await config.update('autoDownload', undefined, vscode.ConfigurationTarget.Global);
	await config.update('autoInstall', undefined, vscode.ConfigurationTarget.Global);
	log(`Migrated legacy update settings (download=${legacyDownload === true}, install=${legacyInstall === true}).`);
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
	sha256?: string;
}

interface PendingUpdate {
	version: string;
	platform: string;
	stagedAt: number;
}

export function activate(context: vscode.ExtensionContext) {
	extensionVersion = context.extension.packageJSON.version || '0.1.0';
	extensionContext = context;
	windowsUpdateFlagPath = context.globalState.get<string>(STATE_KEY_PENDING_FLAG) ?? null;

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

	void migrateLegacyUpdateSettings().catch(err => log(`Settings migration failed: ${err}`));

	const pendingUpdate = context.globalState.get<PendingUpdate>(STATE_KEY_PENDING_UPDATE);
	if (pendingUpdate) {
		const current = getCurrentKiroVersion();
		const applied = current ? compareVersions(current, pendingUpdate.version) >= 0 : false;
		void context.globalState.update(STATE_KEY_PENDING_UPDATE, undefined);
		if (!applied) {
			// The previous staged update did not complete; allow the next automatic
			// check to offer it again instead of staying dismissed forever.
			void context.globalState.update(STATE_KEY_DISMISSED_VERSION, undefined);
			log(`Previous staged update to ${pendingUpdate.version} did not complete; it will be retried.`);
		} else {
			log(`Cleared pending update state (now on ${current}).`);
		}
	}

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

		const { version: latestVersion } = versionInfo;

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

			const { autoDownload, autoInstall } = readUpdatePreferences();

			if (autoDownload && !vscode.workspace.isTrusted) {
				log('Workspace is not trusted; falling back to manual download.');
				await handleManualDownload(context, currentVersion, latestVersion);
			} else if (autoDownload) {
				log(autoInstall
					? 'Automatic download and install enabled.'
					: 'Automatic download enabled.');
				await handleAutoDownload(context, currentVersion, latestVersion, versionInfo.feedArtifacts, autoInstall);
			} else {
				await handleManualDownload(context, currentVersion, latestVersion);
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

async function handleManualDownload(context: vscode.ExtensionContext, currentVersion: string, latestVersion: string): Promise<void> {
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
		await openReleaseNotes(latestVersion);
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

function getUpdateStateDir(): string {
	const dir = path.join(os.tmpdir(), 'kiro-update-checker');
	fs.mkdirSync(dir, { recursive: true });
	return dir;
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

function computeFileSha256(filePath: string): Promise<string | null> {
	return new Promise((resolve) => {
		const hash = crypto.createHash('sha256');
		const stream = fs.createReadStream(filePath);
		stream.on('data', chunk => hash.update(chunk));
		stream.on('end', () => resolve(hash.digest('hex')));
		stream.on('error', err => {
			log(`Failed to hash ${filePath}: ${err}`);
			resolve(null);
		});
	});
}

async function isRecordedInstaller(context: vscode.ExtensionContext, version: string, filePath: string, requireHash: boolean = false): Promise<boolean> {
	const record = context.globalState.get<InstallerRecord>(`${STATE_KEY_INSTALLER_PREFIX}${version}`);
	if (!record || record.filePath !== filePath || !Number.isFinite(record.size) || record.size <= 0) {
		return false;
	}
	if (requireHash && !record.sha256) {
		log('Installer record has no checksum; refusing to trust it.');
		return false;
	}
	try {
		if (fs.statSync(filePath).size !== record.size) {
			return false;
		}
		if (record.sha256) {
			const actual = await computeFileSha256(filePath);
			if (!actual || actual !== record.sha256) {
				log('Installer hash mismatch; refusing to trust the file.');
				return false;
			}
		}
		return true;
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

interface DownloadTarget {
	url: string;
	ext: string;
	silent: boolean;
}

function selectDownloadTarget(info: PlatformInfo, version: string, feedArtifacts: FeedArtifact[]): DownloadTarget | null {
	if (info.platform === 'win32') {
		const fromFeed = artifactFor(feedArtifacts, 'exe', version);
		return { url: fromFeed?.url ?? buildDownloadUrl(version, info), ext: 'exe', silent: true };
	}
	if (info.platform === 'darwin') {
		// The silent updater consumes the .zip artifact from the feed (same as Squirrel.Mac).
		const zip = artifactFor(feedArtifacts, 'zip', version);
		if (zip) {
			return { url: zip.url, ext: 'zip', silent: true };
		}
		log('No updater .zip in the feed for macOS; silent update unavailable.');
		return null;
	}
	if (info.platform === 'linux') {
		if (info.ext === 'tar.gz') {
			const tarGz = artifactFor(feedArtifacts, 'tar.gz', version);
			if (tarGz) {
				return { url: tarGz.url, ext: 'tar.gz', silent: false };
			}
		}
		return { url: buildDownloadUrl(version, info), ext: info.ext, silent: false };
	}
	return null;
}

async function handleAutoDownload(
	context: vscode.ExtensionContext,
	currentVersion: string,
	latestVersion: string,
	feedArtifacts: FeedArtifact[],
	autoInstall: boolean
): Promise<void> {
	log('Mode: Auto-download.');
	const info = detectCurrentPlatform();
	if (!info) {
		log('Unsupported platform for auto-download. Falling back to manual download.');
		await handleManualDownload(context, currentVersion, latestVersion);
		return;
	}

	const target = selectDownloadTarget(info, latestVersion, feedArtifacts);
	if (!target) {
		log('No suitable downloadable artifact for this platform. Falling back to manual download.');
		await handleManualDownload(context, currentVersion, latestVersion);
		return;
	}

	const safeDownloadUrl = validateDownloadUrl(target.url);
	if (!safeDownloadUrl) {
		log(`Blocked download to untrusted URL: ${target.url}`);
		await showDownloadError(latestVersion);
		return;
	}

	const check = await checkUrl(safeDownloadUrl);
	if (!check || !check.status || check.status < 200 || check.status >= 300) {
		log(`Download URL returned ${check ? check.status : 'no response'} for: ${target.url}`);
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
	const fileName = `kiro-ide-${latestVersion}-stable-${info.platform}-${info.arch}.${target.ext}`;

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
		if (await isRecordedInstaller(context, latestVersion, filePath)) {
			log(`Installer already downloaded by this extension at ${filePath}.`);
			await handleDownloadedInstaller(context, info, currentVersion, latestVersion, filePath, autoInstall, target.silent);
			return;
		}
		log('Existing installer file was not recorded by this extension. Re-downloading.');
	}

	log(`Downloading installer from ${target.url} to ${filePath}...`);

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
					const fileHash = crypto.createHash('sha256');

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
						fileHash.update(chunk);

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
						const record: InstallerRecord = {
							filePath,
							size: downloadedSize,
							version: latestVersion,
							sha256: fileHash.digest('hex')
						};
						void context.globalState.update(`${STATE_KEY_INSTALLER_PREFIX}${latestVersion}`, record)
							.then(
								() => handleDownloadedInstaller(context, info, currentVersion, latestVersion, filePath, autoInstall, target.silent),
								err => {
									log(`Failed to record installer: ${err}`);
									return handleDownloadedInstaller(context, info, currentVersion, latestVersion, filePath, autoInstall, target.silent);
								}
							);
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

type StageResult = 'ok' | 'untrusted' | 'failed';

async function stageSilentUpdate(
	context: vscode.ExtensionContext,
	info: PlatformInfo,
	latestVersion: string,
	filePath: string
): Promise<StageResult> {
	const pending = context.globalState.get<PendingUpdate>(STATE_KEY_PENDING_UPDATE);
	if (pending?.version === latestVersion) {
		log(`Update ${latestVersion} is already staged; not applying it again.`);
		return 'ok';
	}

	const trusted = await isRecordedInstaller(context, latestVersion, filePath, true);
	if (!trusted) {
		log('Installer failed integrity checks; refusing to apply it silently.');
		return 'untrusted';
	}

	const applied = await applySilentUpdate(info, latestVersion, filePath);
	if (!applied) {
		return 'failed';
	}

	await context.globalState.update(STATE_KEY_PENDING_UPDATE, {
		version: latestVersion,
		platform: info.platform,
		stagedAt: Date.now()
	} satisfies PendingUpdate);

	if (process.platform === 'win32' && windowsUpdateFlagPath) {
		await context.globalState.update(STATE_KEY_PENDING_FLAG, windowsUpdateFlagPath);
	}

	return 'ok';
}

async function handleDownloadedInstaller(
	context: vscode.ExtensionContext,
	info: PlatformInfo,
	currentVersion: string,
	latestVersion: string,
	filePath: string,
	autoInstall: boolean,
	silentCapable: boolean
): Promise<void> {
	if (autoInstall && silentCapable) {
		log('Auto-install enabled; starting silent update.');
		const staged = await stageSilentUpdate(context, info, latestVersion, filePath);
		if (staged === 'ok') {
			showRestartNotification(context, latestVersion, filePath);
			return;
		}
		if (staged === 'untrusted') {
			await showIntegrityError(filePath);
			return;
		}
		log('Silent update could not be started; offering manual install.');
		await showAutomaticUpdateError(info, filePath);
		return;
	}

	showInstallNotification(context, info, currentVersion, latestVersion, filePath, silentCapable);
}

function showInstallNotification(
	context: vscode.ExtensionContext,
	info: PlatformInfo,
	currentVersion: string,
	latestVersion: string,
	filePath: string,
	silentCapable: boolean
): void {
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
			if (silentCapable) {
				log(`Starting silent update for ${latestVersion}...`);
				const staged = await stageSilentUpdate(context, info, latestVersion, filePath);
				if (staged === 'ok') {
					showRestartNotification(context, latestVersion, filePath);
				} else if (staged === 'untrusted') {
					await showIntegrityError(filePath);
				} else {
					await showAutomaticUpdateError(info, filePath);
				}
			} else {
				// Linux: hand the downloaded package to the system handler (no terminal).
				await openInstallerFile(filePath);
			}
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
			await openReleaseNotes(latestVersion);
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

const WINDOWS_RELAUNCH_TASK = 'KUC-Relaunch';

function scheduleWindowsRelaunch(): void {
	try {
		const exe = process.execPath;
		const scriptPath = path.join(getUpdateStateDir(), 'relaunch.ps1');
		const script = [
			'param([string]$ExePath)',
			'$deadline = (Get-Date).AddMinutes(30)',
			'while ((Get-Date) -lt $deadline) {',
			"  $p = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like 'kiro*' }",
			'  if (-not $p) { break }',
			'  Start-Sleep -Seconds 1',
			'}',
			"$p = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like 'kiro*' }",
			'if (-not $p) { Start-Process -FilePath $ExePath }',
			`schtasks /Delete /TN '${WINDOWS_RELAUNCH_TASK}' /F | Out-Null`,
			'Remove-Item -LiteralPath $MyInvocation.MyCommand.Path -Force -ErrorAction SilentlyContinue'
		].join('\r\n') + '\r\n';
		fs.writeFileSync(scriptPath, script, 'utf8');

		// A child process from the extension host is killed when Kiro quits (the
		// Electron job object closes), so the watcher is launched by Task Scheduler
		// instead, which survives the shutdown.
		const start = new Date(Date.now() + 2 * 60 * 1000);
		const startTime = `${String(start.getHours()).padStart(2, '0')}:${String(start.getMinutes()).padStart(2, '0')}`;
		const taskCommand = `powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "${scriptPath}" -ExePath "${exe}"`;
		execFileSync('schtasks.exe', ['/Create', '/TN', WINDOWS_RELAUNCH_TASK, '/TR', taskCommand, '/SC', 'ONCE', '/ST', startTime, '/F'], {
			timeout: 10000,
			windowsHide: true,
			stdio: 'ignore'
		});
		execFileSync('schtasks.exe', ['/Run', '/TN', WINDOWS_RELAUNCH_TASK], {
			timeout: 10000,
			windowsHide: true,
			stdio: 'ignore'
		});
		log('Relaunch task scheduled; Kiro will start again after the update completes.');
	} catch (err) {
		log(`Failed to schedule the relaunch task: ${err}`);
	}
}

function showRestartNotification(context: vscode.ExtensionContext, latestVersion: string, filePath: string): void {
	const restartBtn = vscode.l10n.t('Restart to Update');
	const releaseNotesBtn = vscode.l10n.t('Release Notes');

	void vscode.window.showInformationMessage(
		vscode.l10n.t('🔄 Kiro {0} is ready. Restart to update.', latestVersion),
		{ modal: false },
		restartBtn,
		releaseNotesBtn
	).then(async selection => {
		if (selection === restartBtn) {
			log('Restart requested; quitting to finish the update...');
			await context.globalState.update(STATE_KEY_DISMISSED_VERSION, latestVersion);
			// The update flag is removed in deactivate(), but only when a restart was
			// actually requested (deactivate also runs on host reloads).
			if (process.platform === 'win32') {
				restartRequested = true;
				scheduleWindowsRelaunch();
			}
			try {
				await vscode.commands.executeCommand('workbench.action.quit');
				// If the quit was vetoed the extension host keeps running; reset the
				// marker so a later reload does not delete the update flag.
				setTimeout(() => {
					if (restartRequested) {
						restartRequested = false;
						log('Quit did not proceed; the update flag was kept for the next attempt.');
					}
				}, 5000);
			} catch (err) {
				log(`Failed to quit the application: ${err}`);
				void vscode.window.showWarningMessage(
					vscode.l10n.t('🔄 Kiro {0} is ready. Restart to update.', latestVersion)
				);
			}
		} else if (selection === releaseNotesBtn) {
			log(`Opening changelog for version ${latestVersion}`);
			await openReleaseNotes(latestVersion);
		}
	}, err => log(`Restart notification failed: ${err}`));
}

async function showAutomaticUpdateError(info: PlatformInfo, filePath: string): Promise<void> {
	await vscode.window.showErrorMessage(
		vscode.l10n.t('❌ Kiro Update Checker: Automatic update failed. Please install manually.')
	);
	if (info.platform === 'darwin') {
		// Opening a .zip with the system handler is not useful for installing.
		await openExternalSafe(DOWNLOADS_PAGE_URL, 'downloads page');
	} else {
		await openInstallerFile(filePath);
	}
}

async function showIntegrityError(filePath: string): Promise<void> {
	log(`Refusing to run the installer at ${filePath}: integrity check failed.`);
	try {
		fs.unlinkSync(filePath);
	} catch { /* ignore */ }
	await vscode.window.showErrorMessage(
		vscode.l10n.t('❌ Kiro Update Checker: Automatic update failed. Please install manually.')
	);
	await openExternalSafe(DOWNLOADS_PAGE_URL, 'downloads page');
}

function applySilentUpdate(info: PlatformInfo, version: string, filePath: string): Promise<boolean> {
	if (info.platform === 'win32') {
		return applySilentUpdateWindows(version, filePath);
	}
	if (info.platform === 'darwin') {
		return applySilentUpdateMacOS(filePath);
	}
	return Promise.resolve(false);
}

function delayMs(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

const SPAWN_RETRY_DELAYS_MS = [1000, 3000, 7000, 15000, 30000];
const SPAWN_ATTEMPT_TIMEOUT_MS = 10000;

interface SpawnOutcome {
	child?: ChildProcess;
	error?: NodeJS.ErrnoException;
}

async function spawnDetachedInstaller(installerPath: string, args: string[], extraEnv?: NodeJS.ProcessEnv): Promise<boolean> {
	for (let attempt = 0; ; attempt++) {
		// Spawn failures arrive as an asynchronous 'error' event; only treat the
		// process as started after the 'spawn' event fires.
		const outcome = await Promise.race<SpawnOutcome>([
			new Promise<SpawnOutcome>((resolve) => {
				let child: ChildProcess;
				try {
					child = spawn(installerPath, args, {
						detached: true,
						stdio: 'ignore',
						windowsVerbatimArguments: true,
						env: extraEnv ? { ...process.env, ...extraEnv } : process.env
					});
				} catch (err) {
					resolve({ error: err as NodeJS.ErrnoException });
					return;
				}
				child.once('spawn', () => resolve({ child }));
				child.once('error', (err) => resolve({ error: err }));
			}),
			delayMs(SPAWN_ATTEMPT_TIMEOUT_MS).then<SpawnOutcome>(() => ({
				error: { code: 'ETIMEDOUT', message: 'spawn did not settle' } as NodeJS.ErrnoException
			}))
		]);

		if (outcome.child) {
			outcome.child.on('error', err => log(`Installer process error: ${err}`));
			outcome.child.unref();
			log(`Installer started (pid ${outcome.child.pid ?? 'unknown'}).`);
			return true;
		}

		const code = outcome.error?.code;
		const retryable = code === 'EBUSY' || code === 'EACCES' || code === 'EPERM' || code === 'ETIMEDOUT';
		const delay = SPAWN_RETRY_DELAYS_MS[attempt];
		if (!retryable || delay === undefined) {
			log(`Failed to start the silent update process: ${outcome.error}`);
			return false;
		}
		// Antivirus scanners briefly lock freshly downloaded installers (EBUSY);
		// back off and retry like other updaters do.
		log(`Could not start the update process (${code}); retrying in ${Math.round(delay / 1000)}s...`);
		await delayMs(delay);
	}
}

function hasWindowsInnoInstaller(): boolean {
	try {
		const installRoot = path.resolve(vscode.env.appRoot, '..', '..');
		const entries = fs.readdirSync(installRoot);
		return entries.some(name => /^unins\d+\.exe$/i.test(name));
	} catch (err) {
		log(`Failed to inspect the Windows install root: ${err}`);
		return false;
	}
}

async function applySilentUpdateWindows(version: string, installerPath: string): Promise<boolean> {
	if (!hasWindowsInnoInstaller()) {
		log('Windows installation does not look like an Inno setup (no unins*.exe); silent update unavailable.');
		return false;
	}

	let updateFlag: string | null = null;
	const cleanupFlag = () => {
		if (updateFlag) {
			try { fs.unlinkSync(updateFlag); } catch { /* ignore */ }
		}
		windowsUpdateFlagPath = null;
	};

	try {
		const product = readKiroProductInfo();
		const installDir = path.resolve(vscode.env.appRoot, '..', '..');
		const flagDir = getUpdateStateDir();

		// Clean stale state from previous attempts (including flags for other versions).
		for (const stale of [path.join(flagDir, 'session-ending.flag'), path.join(flagDir, 'update-progress'), path.join(flagDir, 'cancel.flag')]) {
			try { fs.unlinkSync(stale); } catch { /* ignore */ }
		}
		try {
			for (const name of fs.readdirSync(flagDir)) {
				if (/^KiroSetup-.*\.flag$/i.test(name)) {
					try { fs.unlinkSync(path.join(flagDir, name)); } catch { /* ignore */ }
				}
			}
		} catch { /* ignore */ }

		updateFlag = path.join(flagDir, `KiroSetup-${product.quality}-${version}.flag`);
		const sessionEndFlag = path.join(flagDir, 'session-ending.flag');
		const progressPath = path.join(flagDir, 'update-progress');
		const cancelFlag = path.join(flagDir, 'cancel.flag');
		fs.writeFileSync(updateFlag, 'flag');
		windowsUpdateFlagPath = updateFlag;

		// Exact invocation Kiro's updater uses (validated against 1.1.x and 1.4.x):
		// /dir, /progress, /cancel and RunAsInvoker must match for the setup to stage
		// silently and signal readiness the way the app expects.
		const started = await spawnDetachedInstaller(installerPath, [
			'/verysilent',
			'/log',
			`/dir="${installDir}"`,
			`/update="${updateFlag}"`,
			`/progress="${progressPath}"`,
			`/sessionend="${sessionEndFlag}"`,
			`/cancel="${cancelFlag}"`,
			'/nocloseapplications',
			'/mergetasks=runcode,!desktopicon,!quicklaunchicon'
		], { __COMPAT_LAYER: 'RunAsInvoker' });
		if (started) {
			log(`Silent Windows update started: ${path.basename(installerPath)}.`);
		} else {
			cleanupFlag();
		}
		return started;
	} catch (err) {
		cleanupFlag();
		log(`Failed to start the silent Windows update: ${err}`);
		return false;
	}
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function applySilentUpdateMacOS(zipPath: string): Promise<boolean> {
	try {
		const appBundle = path.resolve(vscode.env.appRoot, '..', '..', '..');
		if (!appBundle.toLowerCase().endsWith('.app')) {
			log(`Cannot determine the macOS app bundle path (got "${appBundle}").`);
			return false;
		}

		// Fail early when this user cannot replace the bundle (e.g. MDM-protected
		// /Applications); otherwise the app would quit and reopen unchanged.
		fs.accessSync(appBundle, fs.constants.W_OK);
		fs.accessSync(path.dirname(appBundle), fs.constants.W_OK);

		// Same idea as Squirrel.Mac: wait for the app to exit, swap the bundle,
		// relaunch. The previous bundle is kept as a backup and restored when
		// extraction, copy or signature verification fails. The log lives outside
		// the script directory so it survives the cleanup trap.
		const scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kuc-update-'));
		const scriptPath = path.join(scriptDir, 'apply.sh');
		const logPath = path.join(getUpdateStateDir(), `macos-update-${Date.now()}.log`);
		const script = [
			'#!/bin/bash',
			'set -u',
			`APP=${shellQuote(appBundle)}`,
			`ZIP=${shellQuote(zipPath)}`,
			`LOG=${shellQuote(logPath)}`,
			'exec >>"$LOG" 2>&1',
			'TMP=$(mktemp -d)',
			`trap 'rm -rf "$TMP" "$(dirname "$0")"' EXIT`,
			'echo "[$(date)] waiting for the app to exit"',
			`while ps -axo command= | grep -F -- "$APP/Contents/MacOS/" | grep -qv 'grep '; do sleep 1; done`,
			'ditto -x -k "$ZIP" "$TMP" || { echo "extract failed"; open "$APP"; exit 1; }',
			'NEW=$(ls -d "$TMP"/*.app 2>/dev/null | head -1)',
			'if [ -z "$NEW" ] || [ ! -f "$NEW/Contents/Info.plist" ]; then echo "invalid app bundle"; open "$APP"; exit 1; fi',
			'BAK="$APP.kuc-backup-$$"',
			'mv "$APP" "$BAK" || { echo "backup failed"; open "$APP"; exit 1; }',
			'if ditto "$NEW" "$APP" && codesign --verify --deep --strict "$APP" >/dev/null 2>&1; then',
			'  xattr -cr "$APP" 2>/dev/null || true',
			'  rm -rf "$BAK"',
			'  echo "update applied"',
			'  open "$APP"',
			'else',
			'  echo "apply or signature verification failed; rolling back"',
			'  rm -rf "$APP"',
			'  mv "$BAK" "$APP"',
			'  open "$APP"',
			'  exit 1',
			'fi'
		].join('\n') + '\n';
		fs.writeFileSync(scriptPath, script, { mode: 0o755 });
		const started = await spawnDetachedInstaller('/bin/bash', [scriptPath]);
		if (started) {
			log(`Silent macOS update script started (log: ${logPath}).`);
		}
		return started;
	} catch (err) {
		log(`Failed to start the silent macOS update: ${err}`);
		return false;
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
	feedArtifacts: FeedArtifact[];
}

function fetchBody(url: string, maxBytes: number, timeoutMs: number, depth: number = 0): Promise<Buffer | null> {
	const safeUrl = validateDownloadUrl(url);
	if (!safeUrl) {
		log(`Blocked untrusted URL: ${url}`);
		return Promise.resolve(null);
	}
	return new Promise((resolve) => {
		let settled = false;
		const done = (value: Buffer | null) => {
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
				// Swallow late errors from the abandoned socket.
				request.on('error', () => { /* ignored */ });
				response.on('error', () => { /* ignored */ });
				response.destroy();
				if (!redirectUrl || depth >= MAX_REDIRECTS) {
					log('Blocked or excessive redirect while fetching.');
					done(null);
					return;
				}
				fetchBody(redirectUrl, maxBytes, timeoutMs, depth + 1)
					.then(done)
					.catch(err => {
						log(`Redirect fetch failed: ${err}`);
						done(null);
					});
				return;
			}

			if (status !== 200) {
				log(`Request returned status ${status}: ${safeUrl}`);
				response.resume();
				done(null);
				return;
			}

			let total = 0;
			const chunks: Buffer[] = [];
			response.on('data', (chunk: Buffer) => {
				total += chunk.length;
				if (total > maxBytes) {
					log('Response exceeded the size limit.');
					response.destroy();
					done(null);
					return;
				}
				chunks.push(chunk);
			});
			response.on('end', () => done(Buffer.concat(chunks)));
			response.on('error', (err) => {
				log(`Response error: ${err.message}`);
				done(null);
			});
		});
		request.on('error', (err) => {
			log(`Request error: ${err.message}`);
			done(null);
		});
		request.on('timeout', () => {
			request.destroy();
			log(`Request timed out (${timeoutMs / 1000} seconds).`);
			done(null);
		});
	});
}

function fetchJson(url: string, maxBytes: number, timeoutMs: number): Promise<unknown | null> {
	return fetchBody(url, maxBytes, timeoutMs).then(body => {
		if (!body) { return null; }
		try {
			return JSON.parse(body.toString('utf8')) as unknown;
		} catch (err) {
			log(`Failed to parse JSON: ${err}`);
			return null;
		}
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

async function resolveChangelogUrl(version: string): Promise<string> {
	const indexUrl = 'https://kiro.dev/changelog/';
	const body = await fetchBody(indexUrl, MAX_PAGE_SIZE_BYTES, CHANGELOG_TIMEOUT_MS);
	if (body) {
		const slugs = parseChangelogSlugsFromIndex(body.toString('utf8'));
		const picked = pickChangelogUrl(version, slugs);
		if (picked) {
			const safe = validateDownloadUrl(picked);
			if (safe) {
				log(`Resolved changelog URL: ${safe}`);
				return safe;
			}
		}
	}

	// The index may be unavailable or not list the release; minor-version pages
	// exist for all release lines (e.g. 1-4, 1-0, 0-12).
	const parsed = parseVersion(version);
	const minorSlug = parsed ? `${parsed.core[0]}-${parsed.core[1]}` : null;
	const fallback = minorSlug ? pickChangelogUrl(version, [minorSlug]) : null;
	const safeFallback = fallback ? validateDownloadUrl(fallback) : null;
	log(`Using changelog fallback for ${version}: ${safeFallback ?? FALLBACK_CHANGELOG_URL}`);
	return safeFallback ?? FALLBACK_CHANGELOG_URL;
}

async function openReleaseNotes(version: string): Promise<void> {
	log(`Opening changelog for version ${version}`);
	const url = await resolveChangelogUrl(version);
	await openExternalSafe(url, 'changelog');
}

async function fetchLatestVersion(): Promise<VersionInfo | null> {
	const product = readKiroProductInfo();
	const platform = detectCurrentPlatform();
	const targets = platform ? feedTargets(platform.platform, platform.arch, product.installTarget) : [];

	const feed = await fetchVersionFeed(targets, product.updateUrl, product.quality);
	if (feed) {
		return { version: feed.version, feedArtifacts: feed.artifacts };
	}

	// The downloads page is client-rendered and its static data can be stale;
	// it is only used when the official feed is unavailable.
	const fromHtml = await fetchVersionFromHtml(platform ?? undefined);
	if (fromHtml) {
		log('Version feed unavailable; using the downloads page result.');
		return { version: fromHtml, feedArtifacts: [] };
	}

	return null;
}

function fetchVersionFromHtml(platformHint?: PreferredPlatform): Promise<string | null> {
	return new Promise((resolve) => {
		let settled = false;
		const done = (value: string | null) => {
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
					// Swallow late errors from the abandoned socket.
					request.on('error', () => { /* ignored */ });
					response.on('error', () => { /* ignored */ });
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

function handleResponse(response: IncomingMessage, platformHint: PreferredPlatform | undefined, resolve: (value: string | null) => void) {
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
			resolve(version);
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
	// Only remove the flag when the user actually requested a restart: deactivate
	// also runs on window reloads and extension host restarts, where the app keeps
	// running and the setup must stay waiting.
	if (process.platform === 'win32' && restartRequested && windowsUpdateFlagPath) {
		try {
			fs.unlinkSync(windowsUpdateFlagPath);
			log('Removed the pending update flag.');
		} catch (err) {
			log(`Could not remove the update flag: ${err}`);
		}
		windowsUpdateFlagPath = null;
		void extensionContext?.globalState.update(STATE_KEY_PENDING_FLAG, undefined);
	}
	setLogSink(null);
	outputChannel = null;
	extensionContext = null;
}

// Exported for unit testing
export { formatBytes, isKiro, getCurrentKiroVersion, shellQuote };
