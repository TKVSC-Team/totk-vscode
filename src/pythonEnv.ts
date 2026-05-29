import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync, execSync } from 'child_process';
import * as vscode from 'vscode';

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
    for (const launcher of getSystemPythonCandidates()) {
        if (!tryLauncher(launcher)) {
            continue;
        }

        const version = launcherVersion(launcher);
        if (version && isVersionSupported(version)) {
            return launcher;
        }
    }
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
    const config = vscode.workspace.getConfiguration('totk-editor');
    await config.update('pythonPath', executable, vscode.ConfigurationTarget.Global);
    const python = await ensurePythonEnvironment(context, true);
    if (python) {
        void vscode.window.showInformationMessage(`TOTK Editor: Using ${executable}`);
        return true;
    }
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
        void vscode.window.showErrorMessage(`TOTK Editor: ${failed}`);
        await browseForPython(context);
        return;
    }

    const choice = await vscode.window.showQuickPick(supported, {
        title: 'Select Python for TOTK Editor',
        placeHolder: 'CMD may list python3 on PATH even when Cursor cannot see it - pick the full path below.',
    });
    if (!choice) {
        return;
    }

    await configurePythonPath(context, choice.launcher.executable);
}

function verifyVenvPython(venvPython: string, vendorPymsbtPath: string): boolean {
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
        return true;
    } catch {
        return false;
    }
}

function createVenv(base: PythonLauncher, venvDir: string): void {
    fs.mkdirSync(path.dirname(venvDir), { recursive: true });
    runQuiet(base, ['-m', 'venv', venvDir]);
}

function installRequirements(venvPython: string, extensionPath: string): void {
    execFileSync(venvPython, ['-m', 'pip', 'install', '--upgrade', 'pip'], {
        stdio: 'pipe',
        timeout: 300_000,
    });
    execFileSync(venvPython, ['-m', 'pip', 'install', extensionPath], {
        stdio: 'pipe',
        timeout: 600_000,
    });
}

async function bootstrapPython(context: vscode.ExtensionContext): Promise<string | undefined> {
    const pyprojectPath = path.join(context.extensionPath, 'pyproject.toml');
    if (!fs.existsSync(pyprojectPath)) {
        void vscode.window.showErrorMessage('TOTK Editor: pyproject.toml is missing from the extension package.');
        return undefined;
    }

    const vendorPymsbtPath = path.join(context.extensionPath, 'vendor', 'pymsbt');

    const requirementsHash = readPyProjectHash(pyprojectPath);
    const storageDir = context.globalStorageUri.fsPath;
    const venvDir = path.join(storageDir, VENV_DIR_NAME);
    const venvPython = getVenvPython(venvDir);
    const markerPath = path.join(venvDir, DEPS_MARKER);

    if (
        fs.existsSync(venvPython) &&
        fs.existsSync(markerPath) &&
        fs.readFileSync(markerPath, 'utf-8').trim() === requirementsHash &&
        verifyVenvPython(venvPython, vendorPymsbtPath)
    ) {
        return venvPython;
    }

    const basePython = findSystemPython();
    if (!basePython) {
        return undefined;
    }

    return vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: 'TOTK Editor',
            cancellable: false,
        },
        async () => {
            if (fs.existsSync(venvDir)) {
                fs.rmSync(venvDir, { recursive: true, force: true });
            }

            createVenv(basePython, venvDir);
            installRequirements(venvPython, context.extensionPath);

            if (!verifyVenvPython(venvPython, vendorPymsbtPath)) {
                throw new Error('Python packages installed but import check failed (oead / zstandard / vendor/pymsbt).');
            }

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
    if (force) {
        setupPromise = undefined;
        cachedPython = undefined;
    }

    if (!setupPromise) {
        setupPromise = bootstrapPython(context)
            .then((python) => {
                cachedPython = python;
                return python;
            })
            .catch((error: unknown) => {
                cachedPython = undefined;
                const message = error instanceof Error ? error.message : String(error);
                void vscode.window.showErrorMessage(`TOTK Editor: Python setup failed - ${message}`);
                return undefined;
            });
    }

    return setupPromise;
}

export async function promptPythonSetup(context: vscode.ExtensionContext): Promise<void> {
    const choice = await vscode.window.showErrorMessage(
        'TOTK Editor could not find Python 3.10+. Cursor/VS Code often use a different PATH than CMD - set the full path to python.exe, or pick from detected installs.',
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
