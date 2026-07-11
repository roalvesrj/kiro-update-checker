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

function userAgentStr(): string {
	return `KiroUpdateChecker/${extensionVersion}`;
}

export function activate(context: vscode.ExtensionContext) {
	extensionVersion = context.extension.packageJSON.version || '0.1.0';

	outputChannel = vscode.window.createOutputChannel('Kiro Update Checker');
	context.subscriptions.push(outputChannel);

	log('Kiro Update Checker activated.');

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
	if (outputChannel) {
		outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] ${message}`);
	}
}

function getDownloadFolder(): string {
	const config = vscode.workspace.getConfiguration('kiroUpdateChecker');
	const customPath = config.get<string>('downloadFolder', '');

	if (customPath && fs.existsSync(customPath) && fs.statSync(customPath).isDirectory()) {
		log(`Using custom download folder: ${customPath}`);
		return customPath;
	}

	return path.join(os.homedir(), 'Downloads');
}

async function checkForUpdates(context: vscode.ExtensionContext, manualCheck: boolean = false) {
	try {
		log('Fetching the Kiro downloads page...');
		const latestVersion = await fetchLatestVersion();

		if (!latestVersion) {
			log('Could not determine the latest version.');

			if (manualCheck) {
				vscode.window.showInformationMessage('Could not determine the latest Kiro version. Please try again later.');
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
					'Could not determine the current Kiro version. Please ensure Kiro is installed.',
					'Download Latest',
					'Open Downloads Page'
				);
				if (selection === 'Download Latest') {
					const downloadUrl = buildDownloadUrl(latestVersion);
					log(`Opening browser to download URL: ${downloadUrl}`);
					await vscode.env.openExternal(vscode.Uri.parse(downloadUrl));
				} else if (selection === 'Open Downloads Page') {
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
			vscode.window.showInformationMessage('You are using the latest version of Kiro: ' + latestVersion);
		}
	} catch (error) {
		log(`Error occurred while checking for updates: ${error}`);

		if (manualCheck) {
			vscode.window.showErrorMessage('An error occurred while checking for updates. Please try again later.');
		}
	}
}

async function handleManualDownload(context: vscode.ExtensionContext, currentVersion: string, latestVersion: string) {
	log('Mode: Manual download (open browser).');
	vscode.window.showWarningMessage(`🚀 A new version of Kiro is available! ${currentVersion} -> ${latestVersion}.`, { modal: false }, 'Download Latest', 'Dismiss').then(async selection => {
		if (selection === 'Download Latest') {
			const downloadUrl = buildDownloadUrl(latestVersion);
			log(`Opening browser to download URL: ${downloadUrl}`);
			const opened = await vscode.env.openExternal(vscode.Uri.parse(downloadUrl));
			if (!opened) {
				log('Failed to open browser.');
			}
		} else if (selection === 'Dismiss') {
			log(`User dismissed notifications for version ${latestVersion}.`);
			await context.globalState.update(STATE_KEY_DISMISSED_VERSION, latestVersion);
		}
	});
}

async function handleAutoDownload(context: vscode.ExtensionContext, currentVersion: string, latestVersion: string, manualCheck: boolean) {
	log('Mode: Auto-download and install.');
	const downloadUrl = buildDownloadUrl(latestVersion);
	const downloadFolder = getDownloadFolder();
	const fileName = `kiro-ide-${latestVersion}-stable-win32-x64.exe`;
	const filePath = path.join(downloadFolder, fileName);

	if (fs.existsSync(filePath)) {
		log(`Installer already exists at ${filePath}.`);
		showInstallNotification(context, currentVersion, latestVersion, filePath);
		return;
	}

	const tempPath = filePath + '.tmp';
	log(`Downloading installer from ${downloadUrl} to ${tempPath}...`);

	await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: `Kiro Update Checker: Downloading ${latestVersion}...`,
			cancellable: true
		},
		async (progress, token) => {
			return new Promise<void>((resolve) => {
				const downloadFile = (url: string) => {
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
							downloadFile(redirectUrl);
							return;
						}

						if (response.statusCode !== 200) {
							log(`Failed to download file. Status code: ${response.statusCode}`);
							vscode.window.showErrorMessage(`Kiro Update Checker: Failed to download installer. Please try again later.`);
							resolve();
							return;
						}

						const totalSize = parseInt(response.headers['content-length'] || '0', 10);
						let downloadedSize = 0;

						const fileStream = fs.createWriteStream(tempPath);

						token.onCancellationRequested(() => {
							log('Download cancelled by user.');
							request.destroy();
							fileStream.close();

							try { fs.unlinkSync(tempPath); } catch {}
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

						fileStream.on('close', () => {
							// Validate download integrity
							if (totalSize > 0 && downloadedSize !== totalSize) {
								log(`Download size mismatch: expected ${totalSize} bytes, got ${downloadedSize} bytes.`);
								try { fs.unlinkSync(tempPath); } catch {}
								vscode.window.showErrorMessage(`Kiro Update Checker: Downloaded file is corrupted (size mismatch). Please try again.`);
								resolve();
								return;
							}

							// Verify it's a valid PE executable (starts with MZ)
							try {
								const buffer = Buffer.alloc(2);
								const fd = fs.openSync(tempPath, 'r');
								fs.readSync(fd, buffer, 0, 2, 0);
								fs.closeSync(fd);
								if (buffer[0] !== 0x4D || buffer[1] !== 0x5A) {
									log(`Downloaded file is not a valid PE executable (missing MZ header).`);
									try { fs.unlinkSync(tempPath); } catch {}
									vscode.window.showErrorMessage(`Kiro Update Checker: Downloaded file is not a valid installer. Please try again.`);
									resolve();
									return;
								}
							} catch (e) {
								log(`Error validating downloaded file: ${e}`);
								try { fs.unlinkSync(tempPath); } catch {}
								vscode.window.showErrorMessage(`Kiro Update Checker: Error validating downloaded file. Please try again.`);
								resolve();
								return;
							}

							// Move temp to final path (rename fails across drives on Windows)
							try {
								fs.renameSync(tempPath, filePath);
							} catch {
								try {
									fs.copyFileSync(tempPath, filePath);
									fs.unlinkSync(tempPath);
								} catch (e) {
									log(`Error saving installer: ${e}`);
									try { fs.unlinkSync(tempPath); } catch {}
									vscode.window.showErrorMessage(`Kiro Update Checker: Error saving installer. Please try again.`);
									resolve();
									return;
								}
							}

							log(`Download completed: ${filePath} (${formatBytes(downloadedSize)})`);
							showInstallNotification(context, currentVersion, latestVersion, filePath);
							resolve();
						}).on('error', (err) => {
							log(`Error writing file: ${err.message}`);
							try { fs.unlinkSync(tempPath); } catch {}
							vscode.window.showErrorMessage(`Kiro Update Checker: Error saving installer. Please try again later.`);
							resolve();
						});
					});

					request.on('error', (err) => {
						log(`Error during download: ${err.message}`);
						try { fs.unlinkSync(tempPath); } catch {}
						vscode.window.showErrorMessage(`Kiro Update Checker: Error downloading installer. Please try again later.`);
						resolve();
					});

					request.on('timeout', () => {
						log('Download request timed out (120 seconds).');
						request.destroy();
						try { fs.unlinkSync(tempPath); } catch {}
						vscode.window.showErrorMessage(`Kiro Update Checker: Download request timed out. Please try again later.`);
						resolve();
					});
				};

				downloadFile(downloadUrl);
			});
		}
	);
}

function showInstallNotification(context: vscode.ExtensionContext, currentVersion: string, latestVersion: string, filePath: string) {
	const isWin = process.platform === 'win32';
	const shellPath = isWin ? 'cmd.exe' : undefined;
	const openCommand = isWin ? `start "" "${filePath}"` : `open "${filePath}"`;

	vscode.window.showInformationMessage(`Kiro ${latestVersion} has been downloaded! ${currentVersion} -> ${latestVersion}.`, { modal: false }, 'Install Now', 'Open folder', 'Dismiss').then(async selection => {
		if (selection === 'Install Now') {
			log(`Installing Kiro from ${filePath}...`);

			const terminal = vscode.window.createTerminal({ name: 'Kiro Installer', shellPath });
			terminal.sendText(openCommand, true);
			terminal.show();
		} else if (selection === 'Open folder') {
			const folderPath = path.dirname(filePath);
			log(`Opening folder: ${folderPath}`);
			const opened = await vscode.env.openExternal(vscode.Uri.file(folderPath));
			if (!opened) {
				log('Failed to open folder.');
			}
		} else if (selection === 'Dismiss') {
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
		const followRedirect = (url: string) => {
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
					
					followRedirect(redirectUrl);
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
	// Extract version from download links: kiro-ide-<version>-stable-<platform>-<arch>.<ext>
	const pattern = /kiro-ide-(\d+\.\d+\.\d+)-stable-[a-z0-9]+-[a-z0-9]+\.(?:exe|dmg|pkg|deb|tar\.gz|AppImage|zip)/g;
	let match;
	let highestVersion: string | null = null;

	while ((match = pattern.exec(html)) !== null) {
		const version = match[1];
		if (!highestVersion || compareVersions(version, highestVersion) > 0) {
			highestVersion = version;
		}
	}

	if (highestVersion) {
		log(`Found version in HTML: ${highestVersion}`);
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

function buildDownloadUrl(version: string): string {
	return `https://prod.download.desktop.kiro.dev/releases/stable/win32-x64/signed/${version}/kiro-ide-${version}-stable-win32-x64.exe`;
}

export function deactivate() {
	log('Kiro Update Checker deactivated.');
}

// Exported for unit testing
export { compareVersions, formatBytes, buildDownloadUrl, parseVersionFromHTML };
