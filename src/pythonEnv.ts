import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync, execSync } from 'child_process';
import * as vscode from 'vscode';
import { logger } from './logger';

const VENV_DIR_NAME = 'python-env';
const DEPS_MARKER = '.deps-installed';
const MIN_PYTHON = [3, 10] as const;

export type PythonLauncher = {
    executable: string;
    prefixArgs: string[];
};

let cachedPython: string | undefined;
let setupPromise: Promise<string | undefined> | undefined;

function getVenvPython(venvDir: string): string {
    return process.platform === 'win32'
        ? path.join(venvDir, 'Scripts', 'python.exe')
        : path.join(venvDir, 'bin', 'python');
}

function readPyProjectHash(pyprojectPath: string): string {
    return crypto.createHash('sha256').update(fs.readFileSync(pyprojectPath)).digest('hex');
}

function runQuiet(launcher: PythonLauncher, args: string[]): void {
    execFileSync(launcher.executable, [...launcher.prefixArgs, ...args], {
        stdio: 'pipe',
        timeout: 120_000,
    });
}

function tryLauncher(launcher: PythonLauncher): boolean {
    try {
        runQuiet(launcher, ['--version']);
        return true;
    } catch {
        return false;
    }
}

function parsePythonVersion(output: string): [number, number] | undefined {
    const match = output.match(/Python (\d+)\.(\d+)/i);
    if (!match) {
        return undefined;
    }
    return [Number(match[1]), Number(match[2])];
}

function isVersionSupported(version: [number, number]): boolean {
    if (version[0] > MIN_PYTHON[0]) {
        return true;
    }
    return version[0] === MIN_PYTHON[0] && version[1] >= MIN_PYTHON[1];
}

function launcherVersion(launcher: PythonLauncher): [number, number] | undefined {
    try {
        const output = execFileSync(launcher.executable, [...launcher.prefixArgs, '--version'], {
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 30_000,
        });
        return parsePythonVersion(output);
    } catch {
        return undefined;
    }
}

function isLikelyRealPythonExe(exePath: string): boolean {
    try {
        const stat = fs.statSync(exePath);
        if (!stat.isFile()) {
            return false;
        }
        if (process.platform === 'win32' && stat.size < 10_000) {
            return false;
        }
        return true;
    } catch {
        return false;
    }
}

function resolveNamesViaShell(names: string[]): string[] {
    const found: string[] = [];
    const seen = new Set<string>();

    for (const name of names) {
        try {
            const command =
                process.platform === 'win32'
                    ? `where "${name}" 2>nul`
                    : `command -v "${name}" 2>/dev/null`;
            const output = execSync(command, {
                encoding: 'utf-8',
                timeout: 15_000,
                stdio: ['ignore', 'pipe', 'pipe'],
                env: process.env,
                ...(process.platform === 'win32' ? { shell: 'cmd.exe' } : { shell: '/bin/sh' }),
            });
            for (const line of output.split(/\r?\n/)) {
                const trimmed = line.trim().replace(/^"(.*)"$/, '$1');
                if (!trimmed || seen.has(trimmed.toLowerCase())) {
                    continue;
                }
                if (!fs.existsSync(trimmed)) {
                    continue;
                }
                if (process.platform === 'win32' && !isLikelyRealPythonExe(trimmed)) {
                    continue;
                }
                seen.add(trimmed.toLowerCase());
                found.push(trimmed);
            }
        } catch {
            // Pass
        }
    }

    return found;
}

function collectExecutablesInDir(rootDir: string, depth = 2): string[] {
    const results: string[] = [];
    if (!fs.existsSync(rootDir)) {
        return results;
    }

    const tryExe = (dir: string) => {
        const exe =
            process.platform === 'win32'
                ? path.join(dir, 'python.exe')
                : path.join(dir, 'bin', 'python3');
        const fallback = path.join(dir, 'bin', 'python');
        for (const candidate of [exe, fallback]) {
            if (fs.existsSync(candidate) && isLikelyRealPythonExe(candidate)) {
                results.push(candidate);
            }
        }
    };

    tryExe(rootDir);

    if (depth <= 0) {
        return results;
    }

    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(rootDir, { withFileTypes: true });
    } catch {
        return results;
    }

    for (const entry of entries) {
        if (!entry.isDirectory()) {
            continue;
        }
        results.push(...collectExecutablesInDir(path.join(rootDir, entry.name), depth - 1));
    }

    return results;
}

function discoverInstalledPythonExecutables(): string[] {
    const seen = new Set<string>();
    const results: string[] = [];

    const push = (exe: string) => {
        const normalized = path.normalize(exe);
        const key = normalized.toLowerCase();
        if (seen.has(key)) {
            return;
        }
        if (!isLikelyRealPythonExe(normalized)) {
            return;
        }
        seen.add(key);
        results.push(normalized);
    };

    for (const exe of resolveNamesViaShell([
        'python3.12',
        'python3.11',
        'python3.10',
        'python3',
        'python',
        'py',
    ])) {
        push(exe);
    }

    const roots: string[] = [];
    if (process.platform === 'win32') {
        const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
        roots.push(path.join(localAppData, 'Programs', 'Python'));
        roots.push(path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Python'));
        const programFilesX86 = process.env['ProgramFiles(x86)'];
        if (programFilesX86) {
            roots.push(path.join(programFilesX86, 'Python'));
        }
        roots.push(path.join(os.homedir(), '.pyenv', 'pyenv-win', 'versions'));
        roots.push(path.join(os.homedir(), 'scoop', 'apps', 'python', 'current'));
    } else {
        roots.push('/usr/local/bin', '/opt/homebrew/bin', path.join(os.homedir(), '.pyenv', 'versions'));
    }

    for (const root of roots) {
        for (const exe of collectExecutablesInDir(root, 2)) {
            push(exe);
        }
    }

    return results;
}

function launcherLabel(launcher: PythonLauncher, version?: [number, number]): string {
    const versionText = version ? `Python ${version[0]}.${version[1]}` : 'Python';
    const args = launcher.prefixArgs.length ? ` ${launcher.prefixArgs.join(' ')}` : '';
    return `${versionText} - ${launcher.executable}${args}`;
}

export function getSystemPythonCandidates(): PythonLauncher[] {
    const candidates: PythonLauncher[] = [];
    const seen = new Set<string>();

    const add = (launcher: PythonLauncher) => {
        const key = `${launcher.executable}\0${launcher.prefixArgs.join(' ')}`;
        if (seen.has(key)) {
            return;
        }
        seen.add(key);
        candidates.push(launcher);
    };

    const configured = vscode.workspace.getConfiguration('totk-editor').get<string>('pythonPath', '').trim();
    if (configured) {
        add({ executable: configured, prefixArgs: [] });
    }

    if (process.platform === 'win32') {
        const pyPath = resolveNamesViaShell(['py'])[0];
        if (pyPath) {
            for (const ver of ['-3.12', '-3.11', '-3.10', '-3']) {
                add({ executable: pyPath, prefixArgs: [ver] });
            }
        } else {
            for (const ver of ['-3.12', '-3.11', '-3.10', '-3']) {
                add({ executable: 'py', prefixArgs: [ver] });
            }
        }
    }

    for (const exe of discoverInstalledPythonExecutables()) {
        add({ executable: exe, prefixArgs: [] });
    }

    for (const name of ['python3.12', 'python3.11', 'python3.10', 'python3', 'python']) {
        add({ executable: name, prefixArgs: [] });
    }

    return candidates;
}

export function findSystemPython(): PythonLauncher | undefined {
    logger.debug('Scanning for system Python candidates...');
    const candidates = getSystemPythonCandidates();
    logger.debug(`Scanning ${candidates.length} Python candidates...`);
    for (const launcher of candidates) {
        logger.debug(`Checking candidate: ${launcher.executable} ${launcher.prefixArgs.join(' ')}`);
        if (!tryLauncher(launcher)) {
            logger.debug(`Candidate ${launcher.executable} is not functional.`);
            continue;
        }

        const version = launcherVersion(launcher);
        if (version) {
            logger.debug(`Candidate version parsed: ${version[0]}.${version[1]}`);
            if (isVersionSupported(version)) {
                logger.info(`Candidate selected: ${launcher.executable} (Version: ${version[0]}.${version[1]})`);
                return launcher;
            } else {
                logger.debug(`Candidate version ${version[0]}.${version[1]} is older than minimum supported version 3.10.`);
            }
        } else {
            logger.debug(`Could not parse version for candidate: ${launcher.executable}`);
        }
    }
    logger.warn('No functional, supported Python installation was found.');
    return undefined;
}

export async function listDetectedPythonLaunchers(): Promise<
    { label: string; launcher: PythonLauncher; supported: boolean }[]
> {
    const items: { label: string; launcher: PythonLauncher; supported: boolean }[] = [];

    for (const launcher of getSystemPythonCandidates()) {
        if (!tryLauncher(launcher)) {
            continue;
        }
        const version = launcherVersion(launcher);
        const supported = version !== undefined && isVersionSupported(version);
        items.push({
            label: launcherLabel(launcher, version),
            launcher,
            supported,
        });
    }

    return items;
}

export async function configurePythonPath(
    context: vscode.ExtensionContext,
    executable: string,
): Promise<boolean> {
    logger.info(`Configuring manual pythonPath: ${executable}`);
    const config = vscode.workspace.getConfiguration('totk-editor');
    await config.update('pythonPath', executable, vscode.ConfigurationTarget.Global);
    const python = await ensurePythonEnvironment(context, true);
    if (python) {
        logger.info(`Manual pythonPath successfully configured and bootstrapped: ${executable}`);
        void vscode.window.showInformationMessage(`TKVSC: Using ${executable}`);
        return true;
    }
    logger.error(`Manual pythonPath failed verification or bootstrapping: ${executable}`);
    return false;
}

export async function browseForPython(context: vscode.ExtensionContext): Promise<void> {
    const selection = await vscode.window.showOpenDialog({
        title: 'Select python.exe (Python 3.10+)',
        filters: process.platform === 'win32' ? { Python: ['exe'] } : undefined,
        canSelectMany: false,
    });
    const picked = selection?.[0]?.fsPath;
    if (!picked) {
        return;
    }
    await configurePythonPath(context, picked);
}

export async function pickDetectedPython(context: vscode.ExtensionContext): Promise<void> {
    const detected = await listDetectedPythonLaunchers();
    const supported = detected.filter((item) => item.supported);

    if (supported.length === 0) {
        const failed = detected.length
            ? 'Found Python installs, but none are version 3.10 or newer.'
            : 'No working Python installs were found. Use Browse if python3 works in CMD but not here.';
        void vscode.window.showErrorMessage(`TKVSC: ${failed}`);
        await browseForPython(context);
        return;
    }

    const choice = await vscode.window.showQuickPick(supported, {
        title: 'Select Python for TKVSC',
        placeHolder: 'CMD may list python3 on PATH even when Cursor cannot see it - pick the full path below.',
    });
    if (!choice) {
        return;
    }

    await configurePythonPath(context, choice.launcher.executable);
}

function verifyVenvPython(venvPython: string, vendorPymsbtPath: string): boolean {
    logger.debug(`Running package verification check with venv executable: ${venvPython}`);
    try {
        const vendorPathLiteral = JSON.stringify(vendorPymsbtPath);
        execFileSync(
            venvPython,
            [
                '-c',
                `import sys; sys.path.insert(0, ${vendorPathLiteral}); import oead, zstandard, mmh3; from pymsbt.msbt import MSBTFile`,
            ],
            { stdio: 'pipe', timeout: 60_000 },
        );
        logger.debug('Package verification check succeeded.');
        return true;
    } catch (e) {
        logger.warn(`Package verification check failed: ${e}`);
        return false;
    }
}

function createVenv(base: PythonLauncher, venvDir: string): void {
    logger.info(`Running venv creation command using: ${base.executable} (args: ${base.prefixArgs.join(' ')})`);
    fs.mkdirSync(path.dirname(venvDir), { recursive: true });
    runQuiet(base, ['-m', 'venv', venvDir]);
    logger.info('Venv creation command executed successfully.');
}

function installRequirements(venvPython: string, extensionPath: string): void {
    logger.info('Upgrading pip in venv...');
    execFileSync(venvPython, ['-m', 'pip', 'install', '--upgrade', 'pip'], {
        stdio: 'pipe',
        timeout: 300_000,
    });
    logger.info(`Installing packages from extension at path: ${extensionPath}`);
    execFileSync(venvPython, ['-m', 'pip', 'install', extensionPath], {
        stdio: 'pipe',
        timeout: 600_000,
    });
    logger.info('Pip packages installation completed.');
}

async function bootstrapPython(context: vscode.ExtensionContext): Promise<string | undefined> {
    const pyprojectPath = path.join(context.extensionPath, 'pyproject.toml');
    if (!fs.existsSync(pyprojectPath)) {
        logger.error(`pyproject.toml is missing from the extension package at: ${pyprojectPath}`);
        void vscode.window.showErrorMessage('TKVSC: pyproject.toml is missing from the extension package.');
        return undefined;
    }
    logger.debug(`Found pyproject.toml at: ${pyprojectPath}`);

    const vendorPymsbtPath = path.join(context.extensionPath, 'vendor', 'pymsbt');
    logger.debug(`Vendor pymsbt path: ${vendorPymsbtPath}`);

    const requirementsHash = readPyProjectHash(pyprojectPath);
    logger.debug(`Requirements hash from pyproject.toml: ${requirementsHash}`);

    const storageDir = context.globalStorageUri.fsPath;
    const venvDir = path.join(storageDir, VENV_DIR_NAME);
    const venvPython = getVenvPython(venvDir);
    const markerPath = path.join(venvDir, DEPS_MARKER);
    logger.info(`Venv path configured at: ${venvDir}`);

    if (
        fs.existsSync(venvPython) &&
        fs.existsSync(markerPath) &&
        fs.readFileSync(markerPath, 'utf-8').trim() === requirementsHash
    ) {
        logger.info('Found existing virtual environment. Verifying packages compatibility...');
        if (verifyVenvPython(venvPython, vendorPymsbtPath)) {
            logger.info(`Virtual environment verified successfully! Using: ${venvPython}`);
            return venvPython;
        } else {
            logger.warn('Virtual environment exists but package import checks failed. Proceeding to rebuild.');
        }
    } else {
        logger.info('Virtual environment is either missing or pyproject.toml dependencies changed.');
    }

    logger.info('Looking for system Python installations...');
    const basePython = findSystemPython();
    if (!basePython) {
        logger.error('No supported system Python 3.10+ installation found. Cannot boot virtual environment.');
        return undefined;
    }
    logger.info(`Supported base system Python found: ${basePython.executable} (args: ${basePython.prefixArgs.join(' ')})`);

    return vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: 'TKVSC',
            cancellable: false,
        },
        async (progress) => {
            if (fs.existsSync(venvDir)) {
                logger.info('Cleaning up existing virtual environment directory...');
                fs.rmSync(venvDir, { recursive: true, force: true });
            }

            logger.info('Creating new virtual environment...');
            progress.report({ message: 'Creating Python virtual environment...' });
            createVenv(basePython, venvDir);

            logger.info('Upgrading pip and installing extension package requirements...');
            progress.report({ message: 'Installing Python package dependencies (oead, zstandard)...' });
            installRequirements(venvPython, context.extensionPath);

            logger.info('Verifying package imports in newly created virtual environment...');
            if (!verifyVenvPython(venvPython, vendorPymsbtPath)) {
                logger.error('Newly installed virtual environment failed package imports check.');
                throw new Error('Python packages installed but import check failed (oead / zstandard / vendor/pymsbt).');
            }

            logger.info('Virtual environment package imports check succeeded. Creating dependency marker file.');
            fs.writeFileSync(markerPath, requirementsHash, 'utf-8');
            return venvPython;
        },
    );
}

export function getCachedPythonExecutable(): string | undefined {
    return cachedPython;
}

export function ensurePythonEnvironment(
    context: vscode.ExtensionContext,
    force = false,
): Promise<string | undefined> {
    logger.debug(`ensurePythonEnvironment called. force=${force}`);
    if (force) {
        logger.info('Forcing python environment rebuild, clearing cached environments.');
        setupPromise = undefined;
        cachedPython = undefined;
    }

    if (!setupPromise) {
        logger.info('Initializing Python setup bootstrap sequence...');
        setupPromise = bootstrapPython(context)
            .then((python) => {
                if (python) {
                    logger.info(`Python environment is successfully ready. Target path: ${python}`);
                } else {
                    logger.warn('Python setup returned undefined (no supported python executable available).');
                }
                cachedPython = python;
                return python;
            })
            .catch((error: unknown) => {
                cachedPython = undefined;
                const message = error instanceof Error ? error.message : String(error);
                logger.error('Python environment bootstrap failed:', error as Error);
                void vscode.window.showErrorMessage(`TKVSC: Python setup failed - ${message}`);
                return undefined;
            });
    } else {
        logger.debug('Reusing existing Python setup promise.');
    }

    return setupPromise;
}

export async function promptPythonSetup(context: vscode.ExtensionContext): Promise<void> {
    const choice = await vscode.window.showErrorMessage(
        'TKVSC could not find Python 3.10+. Cursor/VS Code often use a different PATH than CMD - set the full path to python.exe, or pick from detected installs.',
        'Pick Python',
        'Browse for python.exe',
        'Retry Setup',
        'Open Settings',
    );

    if (choice === 'Pick Python') {
        await pickDetectedPython(context);
    } else if (choice === 'Browse for python.exe') {
        await browseForPython(context);
    } else if (choice === 'Retry Setup') {
        await ensurePythonEnvironment(context, true);
    } else if (choice === 'Open Settings') {
        await vscode.commands.executeCommand('workbench.action.openSettings', 'totk-editor.pythonPath');
    }
}
