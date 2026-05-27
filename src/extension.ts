import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { Buffer } from 'buffer';
import {
    isBntxTextureResult,
    runBridgeJson,
    runBridgeJsonAsync,
    runBridgeReadAsync,
    runBridgeReadContentAsync,
} from './bridge';
import { openTextureViewer, initTextureViewer } from './textureViewer';
import {
    ensurePythonEnvironment,
    getCachedPythonExecutable,
    promptPythonSetup,
    browseForPython,
    pickDetectedPython,
} from './pythonEnv';
import { isEditableFile, toTotkDiskUri } from './editableFiles';
import { TotkDiskFileSystemProvider } from './totkDiskFs';
import {
    archiveCacheKey,
    getDiskArchivePath,
    getLocatorInsideDiskArchive,
    isArchiveBrowsePath,
    isArchiveFile,
    isPathInsideArchive,
    isTxtgFile,
} from './archives';
import { registerDocumentLanguageModes } from './languageModes';
import { getAampExtensions, initAampExtensions } from './aampExtensions';
import { createDiskDirectory, deleteDiskPath, renameDiskPath } from './diskFsOps';
import {
    focusArchiveSidebar,
    type ArchiveTreeItem,
    migrateSarcWorkspaceFolders,
    registerArchiveTree,
} from './archiveTree';
import { getArchiveSelection } from './archiveFsCommands';
import { getDumpSelection, registerGameDumpTree, type DumpTreeItem } from './dumpTree';
import { createReadonlyArchiveFs } from './readonlyArchiveFs';
import { resolveRomfsPath } from './romfs';
import {
    migrateOffStandaloneIconTheme,
    registerIconThemeCommands,
} from './iconTheme';
import {
    formatExternalToolPrompt,
    registerExternalToolSupport,
} from './externalTools';
import { getCoreExtensions, initCoreFsExtensions } from './coreFsExtensions';
import { AinbNodeEditorProvider } from './nodeEditor/provider';
import { TkprojEditorProvider } from './tkprojEditor';
import { setExtensionPath } from './romfsIndex';
import {
    hasBaseCanonicalPath,
    invalidateCanonicalPathIndex,
    setCanonicalIndexExtensionPath,
} from './canonicalPathIndex';
import { propagateCanonicalSave } from './canonicalSavePropagation';
import { normalizePath, pathsEqual } from './projectPaths';
import type { DiskWriteNotification } from './totkDiskFs';
import {
    ensureProjectCanonicalImport,
    setProjectCanonicalOverlayExtensionPath,
} from './projectCanonicalOverlay';

function shouldOfferExternalToolPrompt(content: string): boolean {
    return content.startsWith('<Binary Data:') || content.startsWith('Error reading file:');
}

function isLikelyBinaryBuffer(data: Uint8Array): boolean {
    const sampleLength = Math.min(data.length, 2048);
    if (sampleLength === 0) {
        return false;
    }

    let suspicious = 0;
    for (let i = 0; i < sampleLength; i++) {
        const byte = data[i]!;
        if (byte === 0) {
            return true;
        }
        const isControl = byte < 9 || (byte > 13 && byte < 32);
        if (isControl) {
            suspicious++;
        }
    }

    return suspicious / sampleLength > 0.2;
}

function getBridgeEnv(): NodeJS.ProcessEnv {
    const config = vscode.workspace.getConfiguration('totk-editor');
    const romfsPath = resolveRomfsPath();
    const extraAamp = config.get<string[]>('extraAampExtensions', []);
    return {
        ...process.env,
        TOTK_EDITOR_ROMFS: romfsPath,
        TOTK_EXTRA_AAMP_EXTS: extraAamp.map((ext) => ext.replace(/^\./, '')).join(','),
    };
}

function pickExportDestinationName(destinationFolder: string, preferredName: string): string {
    const parsed = path.parse(preferredName);
    let candidate = preferredName;
    let index = 1;
    while (fs.existsSync(path.join(destinationFolder, candidate))) {
        candidate = `${parsed.name} (${index})${parsed.ext}`;
        index++;
    }
    return candidate;
}

function selectedUrisFromTree<T extends { resourceUri: vscode.Uri }>(
    clicked: T | undefined,
    selection: T[],
): vscode.Uri[] {
    if (!clicked?.resourceUri) {
        return selection.map((entry) => entry.resourceUri);
    }
    const clickedInSelection = selection.some(
        (entry) => entry.resourceUri.toString() === clicked.resourceUri.toString(),
    );
    if (clickedInSelection) {
        return selection.map((entry) => entry.resourceUri);
    }
    return [clicked.resourceUri];
}

class SarcProvider implements vscode.FileSystemProvider {
    private _onDidChangeFile = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
    readonly onDidChangeFile = this._onDidChangeFile.event;

    private fileCache = new Map<string, string[]>();

    constructor(
        private readonly bridgePath: string,
        private readonly getPython: () => string,
        private readonly onDidWriteArchive?: (info: {
            diskArchivePath: string;
            internalPath: string;
            content: Uint8Array;
            textContent?: string;
        }) => Promise<void>,
    ) {}

    private requirePython(): string {
        const python = this.getPython();
        if (!python) {
            throw new Error(
                'Python environment is not ready. Run "TOTK: Set Up Python Environment" or install Python 3.10+.',
            );
        }
        return python;
    }

    watch(uri: vscode.Uri): vscode.Disposable {
        return new vscode.Disposable(() => { });
    }

    private getDiskArchive(fsPath: string): string {
        return getDiskArchivePath(fsPath);
    }

    private getLocator(fsPath: string, diskArchive: string): string {
        return getLocatorInsideDiskArchive(fsPath, diskArchive);
    }

    private listingPrefix(locator: string): string {
        return locator ? `${locator.replace(/\\/g, '/')}/` : '';
    }

    private async loadArchiveListing(diskArchive: string, locator: string): Promise<string[]> {
        const cacheKey = archiveCacheKey(diskArchive, locator);
        let files = this.fileCache.get(cacheKey);
        if (!files) {
            console.log(`Loading archive: ${diskArchive} @ ${locator || '(root)'}`);
            files = await runBridgeJsonAsync<string[]>(
                this.requirePython(),
                this.bridgePath,
                ['list', diskArchive, locator],
                undefined,
                getBridgeEnv(),
            );
            this.fileCache.set(cacheKey, files!);
            console.log(`Mapped ${files!.length} paths inside archive view.`);
        }
        return files;
    }

    private entryTypeInListing(
        files: string[],
        parentPrefix: string,
        name: string,
    ): vscode.FileType | undefined {
        const fullPath = parentPrefix ? `${parentPrefix}${name}` : name;
        const hasChildren = files.some(
            (entry) => entry.length > fullPath.length + 1 && entry.startsWith(`${fullPath}/`),
        );
        if (hasChildren || isArchiveFile(name)) {
            return vscode.FileType.Directory;
        }
        if (files.includes(fullPath)) {
            return vscode.FileType.File;
        }
        return undefined;
    }

    private async entryTypeForLocator(diskArchive: string, locator: string): Promise<vscode.FileType | undefined> {
        if (!locator) {
            return vscode.FileType.Directory;
        }

        const normalized = locator.replace(/\\/g, '/');
        const name = normalized.split('/').pop() ?? '';
        if (isArchiveFile(name)) {
            return vscode.FileType.Directory;
        }

        const parentLocator = normalized.includes('/')
            ? normalized.replace(/\/[^/]+$/, '')
            : '';
        const files = await this.loadArchiveListing(diskArchive, parentLocator);
        return this.entryTypeInListing(files, this.listingPrefix(parentLocator), name);
    }

    private isMutatableDiskPath(fsPath: string): boolean {
        return !isPathInsideArchive(fsPath);
    }

    private usesArchiveListing(fsPath: string): boolean {
        return isArchiveBrowsePath(fsPath);
    }

    private listDiskDirectory(dirPath: string): [string, vscode.FileType][] {
        if (!fs.existsSync(dirPath)) {
            return [];
        }

        return fs.readdirSync(dirPath, { withFileTypes: true }).map((entry) => {
            const entryPath = path.join(dirPath, entry.name);
            if (entry.isDirectory()) {
                return [entry.name, vscode.FileType.Directory] as [string, vscode.FileType];
            }
            if (isArchiveFile(entryPath)) {
                return [entry.name, vscode.FileType.Directory] as [string, vscode.FileType];
            }
            return [entry.name, vscode.FileType.File] as [string, vscode.FileType];
        });
    }

    private statDiskPath(diskPath: string): vscode.FileStat {
        if (!fs.existsSync(diskPath)) {
            throw vscode.FileSystemError.FileNotFound(diskPath);
        }

        const stat = fs.statSync(diskPath);
        if (stat.isDirectory()) {
            return {
                type: vscode.FileType.Directory,
                ctime: stat.ctimeMs,
                mtime: stat.mtimeMs,
                size: 0,
            };
        }

        if (isArchiveFile(diskPath)) {
            return {
                type: vscode.FileType.Directory,
                ctime: stat.ctimeMs,
                mtime: stat.mtimeMs,
                size: 0,
            };
        }

        return {
            type: vscode.FileType.File,
            ctime: stat.ctimeMs,
            mtime: stat.mtimeMs,
            size: stat.size,
        };
    }

    async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
        const fsPath = uri.fsPath;

        if (!this.usesArchiveListing(fsPath)) {
            return this.statDiskPath(fsPath);
        }

        const diskArchive = this.getDiskArchive(fsPath);
        const locator = this.getLocator(fsPath, diskArchive);
        const entryType = await this.entryTypeForLocator(diskArchive, locator);
        if (entryType === vscode.FileType.Directory) {
            return { type: entryType, ctime: 0, mtime: 0, size: 0 };
        }
        if (entryType === vscode.FileType.File) {
            return { type: entryType, ctime: 0, mtime: 0, size: 100 };
        }

        throw vscode.FileSystemError.FileNotFound(fsPath);
    }

    async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
        const fsPath = uri.fsPath;

        if (!this.usesArchiveListing(fsPath)) {
            return this.listDiskDirectory(fsPath);
        }

        const diskArchive = this.getDiskArchive(fsPath);
        const locator = this.getLocator(fsPath, diskArchive);
        const files = await this.loadArchiveListing(diskArchive, locator);

        const result = new Map<string, vscode.FileType>();
        const prefix = this.listingPrefix(locator);

        for (const entry of files) {
            if (!entry.startsWith(prefix)) {
                continue;
            }
            const remainder = entry.substring(prefix.length);
            const slashIndex = remainder.indexOf('/');
            const name = slashIndex === -1 ? remainder : remainder.substring(0, slashIndex);
            if (!name) {
                continue;
            }
            const entryType = this.entryTypeInListing(files, prefix, name);
            if (entryType !== undefined) {
                result.set(name, entryType);
            }
        }

        return Array.from(result.entries());
    }

    async readFile(uri: vscode.Uri): Promise<Uint8Array> {
        const fsPath = uri.fsPath;

        if (!this.usesArchiveListing(fsPath)) {
            if (isEditableFile(fsPath)) {
                try {
                    const content = await runBridgeReadContentAsync(
                        this.requirePython(),
                        this.bridgePath,
                        ['read-disk', fsPath],
                        getBridgeEnv(),
                    );
                    return new TextEncoder().encode(content);
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    return new TextEncoder().encode(`Error reading file: ${message}`);
                }
            }
            const raw = fs.readFileSync(fsPath);
            // For non-editable binary files opened from archive-related trees, show external-tool actions.
            if ((uri.scheme === 'totk-dump' || uri.scheme === 'sarc') && isLikelyBinaryBuffer(raw)) {
                return new TextEncoder().encode(
                    formatExternalToolPrompt(
                        fsPath,
                        'TOTK Editor does not have a built-in parser for this file type yet.',
                    ),
                );
            }
            return raw;
        }

        const diskArchive = this.getDiskArchive(fsPath);
        const filePath = this.getLocator(fsPath, diskArchive);

        try {
            console.log(`Reading: ${diskArchive} / ${filePath}`);
            const content = await runBridgeReadContentAsync(
                this.requirePython(),
                this.bridgePath,
                ['read', diskArchive, filePath],
                getBridgeEnv(),
            );

            if (shouldOfferExternalToolPrompt(content)) {
                const reason = content.startsWith('Error reading file:')
                    ? content
                    : 'TOTK Editor does not have a built-in parser for this file type yet.';
                return new TextEncoder().encode(formatExternalToolPrompt(filePath, reason));
            }

            return new TextEncoder().encode(content);
        } catch (error) {
            console.error('Python Read Error:', error);
            const message = error instanceof Error ? error.message : String(error);
            return new TextEncoder().encode(
                formatExternalToolPrompt(filePath, `Error reading file: ${message}`),
            );
        }
    }

    private notifyChanged(uri: vscode.Uri, type: vscode.FileChangeType): void {
        this._onDidChangeFile.fire([{ type, uri }]);
    }

    private rejectArchiveMutation(operation: string): never {
        throw vscode.FileSystemError.NoPermissions(
            `Cannot ${operation} paths inside .pack / .sarc / .genvb / .blarc / .bfarc / .bntx archives. Extract the file or use a dedicated modding tool.`,
        );
    }

    createDirectory(uri: vscode.Uri): void {
        const fsPath = uri.fsPath;
        if (this.isMutatableDiskPath(fsPath)) {
            createDiskDirectory(fsPath);
            this.notifyChanged(uri, vscode.FileChangeType.Created);
            return;
        }

        // SARC does not store empty directories explicitly.
        throw vscode.FileSystemError.NoPermissions(
            'Cannot create empty folders inside archives. Create a file in that folder instead.',
        );
    }

    async writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean }): Promise<void> {
        const fsPath = uri.fsPath;

        if (this.isMutatableDiskPath(fsPath)) {
            if (isEditableFile(fsPath)) {
                if (!fs.existsSync(fsPath)) {
                    fs.writeFileSync(fsPath, content);
                    return;
                }
                try {
                    const text = new TextDecoder().decode(content);
                    await runBridgeJsonAsync<{ success: boolean }>(
                        this.requirePython(),
                        this.bridgePath,
                        ['write-disk', fsPath],
                        text,
                        getBridgeEnv(),
                    );
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    vscode.window.showErrorMessage(`Failed to save: ${message}`);
                    throw vscode.FileSystemError.Unavailable(message);
                }
                return;
            }
            fs.writeFileSync(fsPath, content);
            return;
        }

        const diskArchive = this.getDiskArchive(fsPath);
        const filePath = this.getLocator(fsPath, diskArchive);

        try {
            console.log(`Writing back to: ${diskArchive} / ${filePath}`);
            if (isEditableFile(fsPath) && content.length > 0 && !isLikelyBinaryBuffer(content)) {
                const yamlContent = new TextDecoder().decode(content);
                await runBridgeJsonAsync<{ success: boolean }>(
                    this.requirePython(),
                    this.bridgePath,
                    ['write', diskArchive, filePath],
                    yamlContent,
                    getBridgeEnv(),
                );
                await this.onDidWriteArchive?.({
                    diskArchivePath: diskArchive,
                    internalPath: filePath,
                    content,
                    textContent: yamlContent,
                });
            } else {
                const encoded = Buffer.from(content).toString('base64');
                await runBridgeJsonAsync<{ success: boolean }>(
                    this.requirePython(),
                    this.bridgePath,
                    ['write-raw', diskArchive, filePath],
                    encoded,
                    getBridgeEnv(),
                );
                await this.onDidWriteArchive?.({
                    diskArchivePath: diskArchive,
                    internalPath: filePath,
                    content,
                });
            }

            for (const key of [...this.fileCache.keys()]) {
                if (key.startsWith(`${diskArchive}::`)) {
                    this.fileCache.delete(key);
                }
            }
            console.log('Successfully saved and repacked SARC!');
        } catch (error) {
            console.error('Python Write Error:', error);
            vscode.window.showErrorMessage(`Failed to save: ${error}`);
            throw vscode.FileSystemError.Unavailable(error as string);
        }
    }

    async delete(uri: vscode.Uri, options: { recursive: boolean }): Promise<void> {
        const fsPath = uri.fsPath;
        if (this.isMutatableDiskPath(fsPath)) {
            deleteDiskPath(fsPath, options.recursive);
            this.notifyChanged(uri, vscode.FileChangeType.Deleted);
            return;
        }

        const diskArchive = this.getDiskArchive(fsPath);
        const filePath = this.getLocator(fsPath, diskArchive);
        await runBridgeJsonAsync<{ success: boolean }>(
            this.requirePython(),
            this.bridgePath,
            ['delete-entry', diskArchive, filePath],
            undefined,
            getBridgeEnv(),
        );
        for (const key of [...this.fileCache.keys()]) {
            if (key.startsWith(`${diskArchive}::`)) {
                this.fileCache.delete(key);
            }
        }
        this.notifyChanged(uri, vscode.FileChangeType.Deleted);
    }

    async rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean }): Promise<void> {
        const oldPath = oldUri.fsPath;
        const newPath = newUri.fsPath;
        if (this.isMutatableDiskPath(oldPath) && this.isMutatableDiskPath(newPath)) {
            renameDiskPath(oldPath, newPath, options.overwrite);
            this.notifyChanged(oldUri, vscode.FileChangeType.Deleted);
            this.notifyChanged(newUri, vscode.FileChangeType.Created);
            return;
        }

        const oldDiskArchive = this.getDiskArchive(oldPath);
        const newDiskArchive = this.getDiskArchive(newPath);
        if (oldDiskArchive !== newDiskArchive) {
            this.rejectArchiveMutation('move files across different archives');
        }
        const oldLocator = this.getLocator(oldPath, oldDiskArchive);
        const newLocator = this.getLocator(newPath, newDiskArchive);
        await runBridgeJsonAsync<{ success: boolean }>(
            this.requirePython(),
            this.bridgePath,
            ['rename-entry', oldDiskArchive, oldLocator, newLocator],
            undefined,
            getBridgeEnv(),
        );
        for (const key of [...this.fileCache.keys()]) {
            if (key.startsWith(`${oldDiskArchive}::`)) {
                this.fileCache.delete(key);
            }
        }
        this.notifyChanged(oldUri, vscode.FileChangeType.Deleted);
        this.notifyChanged(newUri, vscode.FileChangeType.Created);
    }
}

export async function activate(context: vscode.ExtensionContext) {
    initAampExtensions(context.extensionPath);
    initCoreFsExtensions(context.extensionPath);
    initTextureViewer(context.extensionUri);
    setExtensionPath(context.extensionPath);
    setCanonicalIndexExtensionPath(context.extensionPath);
    setProjectCanonicalOverlayExtensionPath(context.extensionPath);
    console.log('TOTK Editor is now active!');
    const output = vscode.window.createOutputChannel('TOTK Editor');
    context.subscriptions.push(output);

    registerDocumentLanguageModes(context);
    context.subscriptions.push(TkprojEditorProvider.register(context));

    const bridgePath = path.join(context.extensionPath, 'python', 'totk_bridge.py');
    const getPython = () => getCachedPythonExecutable() ?? '';
    const romfsIndexPath = path.join(context.globalStorageUri.fsPath, 'romfs-index.sqlite');
    const canonicalIndexPath = path.join(context.globalStorageUri.fsPath, 'canonical-paths.sqlite');
    const projectCanonicalOverlayPath = path.join(
        context.globalStorageUri.fsPath,
        'canonical-project-overlays.sqlite',
    );
    const romfsIndexStatePath = path.join(context.globalStorageUri.fsPath, 'romfs-index.state.json');
    const canonicalIndexStatePath = path.join(context.globalStorageUri.fsPath, 'canonical-paths.state.json');
    const ROMFS_INDEX_STATE_KEY = 'totk-editor.romfsIndexState';
    const CANONICAL_INDEX_STATE_KEY = 'totk-editor.canonicalIndexState';
    const ROMFS_INDEX_SCHEMA_VERSION = 3;
    const CANONICAL_INDEX_SCHEMA_VERSION = 3;
    const PROJECT_CANONICAL_IMPORT_SCHEMA_VERSION = 2;
    let romfsIndexBuildPromise: Promise<void> | undefined;
    let canonicalIndexBuildPromise: Promise<void> | undefined;
    let gameDumpTree: ReturnType<typeof registerGameDumpTree> | undefined;
    let archiveTree: ReturnType<typeof registerArchiveTree> | undefined;

    const shouldPropagateCanonicalSaves = (): boolean => {
        const config = vscode.workspace.getConfiguration('totk-editor');
        return config.get<boolean>('enableCanonicalSavePropagation', true);
    };
    const getCanonicalBlacklistPrefixes = (): string[] => {
        const config = vscode.workspace.getConfiguration('totk-editor');
        return config.get<string[]>('canonicalSyncBlacklistPrefixes', ['Mals', 'UI']);
    };
    const getCanonicalArchiveTypeBlacklist = (): string[] => {
        const config = vscode.workspace.getConfiguration('totk-editor');
        return config.get<string[]>('canonicalSyncArchiveTypeBlacklist', ['.sarc', '.blarc']);
    };

    type IndexState = { romfsPath: string; schemaVersion: number };

    const readIndexState = (
        key: string,
    ): IndexState | undefined =>
        context.globalState.get<IndexState>(key);

    const readIndexStateFromFile = (statePath: string): IndexState | undefined => {
        try {
            if (!fs.existsSync(statePath)) {
                return undefined;
            }
            const parsed = JSON.parse(fs.readFileSync(statePath, 'utf-8')) as Partial<IndexState>;
            if (typeof parsed.romfsPath !== 'string' || typeof parsed.schemaVersion !== 'number') {
                return undefined;
            }
            return {
                romfsPath: normalizePath(parsed.romfsPath),
                schemaVersion: parsed.schemaVersion,
            };
        } catch {
            return undefined;
        }
    };

    const writeIndexState = async (
        key: string,
        statePath: string,
        romfsPath: string,
        schemaVersion: number,
    ): Promise<void> => {
        const state: IndexState = {
            romfsPath: normalizePath(romfsPath),
            schemaVersion,
        };
        await context.globalState.update(key, state);
        await fs.promises.mkdir(path.dirname(statePath), { recursive: true });
        await fs.promises.writeFile(statePath, JSON.stringify(state), 'utf-8');
    };

    const shouldRebuildIndex = (
        dbPath: string,
        romfsPath: string,
        schemaVersion: number,
        stateKey: string,
        statePath: string,
    ): boolean => {
        if (!fs.existsSync(dbPath)) {
            return true;
        }
        const state = readIndexStateFromFile(statePath) ?? readIndexState(stateKey);
        if (!state) {
            return true;
        }
        if (state.schemaVersion !== schemaVersion) {
            return true;
        }
        return !pathsEqual(state.romfsPath, romfsPath);
    };

    const buildRomfsIndex = async (force = false): Promise<void> => {
        if (romfsIndexBuildPromise) {
            return romfsIndexBuildPromise;
        }
        const romfsPath = resolveRomfsPath();
        const pythonExe = getPython();
        if (!romfsPath || !pythonExe || !gameDumpTree) {
            return;
        }
        if (!force && !shouldRebuildIndex(
            romfsIndexPath,
            romfsPath,
            ROMFS_INDEX_SCHEMA_VERSION,
            ROMFS_INDEX_STATE_KEY,
            romfsIndexStatePath,
        )) {
            return;
        }

        gameDumpTree.setExternalIndexBuilding(true);
        romfsIndexBuildPromise = (async () => {
            try {
                await fs.promises.mkdir(context.globalStorageUri.fsPath, { recursive: true });
                await runBridgeJsonAsync<{ path: string; count: number }>(
                    pythonExe,
                    bridgePath,
                    ['build-romfs-index', romfsIndexPath],
                    undefined,
                    getBridgeEnv(),
                );
                await writeIndexState(
                    ROMFS_INDEX_STATE_KEY,
                    romfsIndexStatePath,
                    romfsPath,
                    ROMFS_INDEX_SCHEMA_VERSION,
                );
                gameDumpTree?.onExternalIndexUpdated();
            } catch {
                // Keep search functional with TypeScript fallback indexing.
            } finally {
                gameDumpTree?.setExternalIndexBuilding(false);
                romfsIndexBuildPromise = undefined;
            }
        })();
        return romfsIndexBuildPromise;
    };

    const buildCanonicalIndex = async (force = false): Promise<void> => {
        if (canonicalIndexBuildPromise) {
            return canonicalIndexBuildPromise;
        }
        const romfsPath = resolveRomfsPath();
        const pythonExe = getPython();
        if (!romfsPath || !pythonExe) {
            return;
        }
        if (!force && !shouldRebuildIndex(
            canonicalIndexPath,
            romfsPath,
            CANONICAL_INDEX_SCHEMA_VERSION,
            CANONICAL_INDEX_STATE_KEY,
            canonicalIndexStatePath,
        )) {
            return;
        }

        canonicalIndexBuildPromise = (async () => {
            try {
                await fs.promises.mkdir(context.globalStorageUri.fsPath, { recursive: true });
                await runBridgeJsonAsync<{ path: string; count: number }>(
                    pythonExe,
                    bridgePath,
                    ['build-canonical-path-index', canonicalIndexPath],
                    undefined,
                    getBridgeEnv(),
                );
                await writeIndexState(
                    CANONICAL_INDEX_STATE_KEY,
                    canonicalIndexStatePath,
                    romfsPath,
                    CANONICAL_INDEX_SCHEMA_VERSION,
                );
                output.appendLine('[canonical-save] Canonical path index rebuilt.');
                invalidateCanonicalPathIndex();
            } catch {
                output.appendLine('[canonical-save] Failed to build canonical path index.');
            } finally {
                canonicalIndexBuildPromise = undefined;
            }
        })();
        return canonicalIndexBuildPromise;
    };

    const runCanonicalPropagation = async (info: {
        diskArchivePath: string;
        internalPath: string;
        content: Uint8Array;
        textContent?: string;
    }): Promise<void> => {
        const pythonExe = getPython();
        const romfsPath = resolveRomfsPath();
        if (!pythonExe || !romfsPath) {
            return;
        }
        await propagateCanonicalSave({
            enabled: shouldPropagateCanonicalSaves(),
            romfsPath,
            canonicalIndexPath,
            bridgePath,
            pythonExecutable: pythonExe,
            bridgeEnv: getBridgeEnv(),
            projectRoots: archiveTree?.getProjectRoots() ?? [],
            projectOverlayDbPath: projectCanonicalOverlayPath,
            blacklistPrefixes: getCanonicalBlacklistPrefixes(),
            archiveTypeBlacklist: getCanonicalArchiveTypeBlacklist(),
            onPulledNewFiles: () => archiveTree?.refresh(),
            writeInput: {
                diskArchivePath: normalizePath(info.diskArchivePath),
                internalPath: info.internalPath,
                textContent: info.textContent,
                rawContent: info.textContent === undefined ? info.content : undefined,
            },
            output,
        });
    };

    const importKnownProjectCanonicalPaths = async (): Promise<void> => {
        const pythonExe = getPython();
        const romfsPath = resolveRomfsPath();
        if (!archiveTree || !pythonExe || !romfsPath) {
            return;
        }
        for (const root of archiveTree.getProjectRoots()) {
            await ensureProjectCanonicalImport({
                overlayDbPath: projectCanonicalOverlayPath,
                projectRoot: root.fsPath,
                romfsPath,
                pythonExecutable: pythonExe,
                bridgePath,
                bridgeEnv: getBridgeEnv(),
                output,
                importSchemaVersion: PROJECT_CANONICAL_IMPORT_SCHEMA_VERSION,
                shouldIncludeCanonicalPath: async (canonicalPath: string) => {
                    const existsInBase = await hasBaseCanonicalPath(
                        canonicalIndexPath,
                        romfsPath,
                        canonicalPath,
                    );
                    return !existsInBase;
                },
            });
        }
    };

    const sarcProvider = new SarcProvider(bridgePath, getPython, runCanonicalPropagation);
    context.subscriptions.push(
        vscode.workspace.registerFileSystemProvider('sarc', sarcProvider, {
            isCaseSensitive: true,
            isReadonly: false,
        }),
    );

    context.subscriptions.push(
        vscode.workspace.registerFileSystemProvider(
            'totk-dump',
            createReadonlyArchiveFs(sarcProvider),
            {
                isCaseSensitive: true,
                isReadonly: true,
            },
        ),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('totk-editor.openBntxTexture', async (uri: vscode.Uri) => {
            const python = getPython();
            if (!python) {
                void vscode.window.showErrorMessage('Python not configured.');
                return;
            }
            try {
                const diskArchive = getDiskArchivePath(uri.fsPath);
                const filePath = getLocatorInsideDiskArchive(uri.fsPath, diskArchive);
                const commandArgs = isTxtgFile(uri.fsPath)
                    ? (filePath ? ['render-txtg', diskArchive, filePath] : ['render-txtg', diskArchive])
                    : ['read', diskArchive, filePath];
                const raw = await runBridgeReadAsync(
                    python,
                    bridgePath,
                    commandArgs,
                    getBridgeEnv(),
                );
                if (isBntxTextureResult(raw)) {
                    const texName = raw.metadata?.name ?? filePath.split('/').pop() ?? 'texture';
                    openTextureViewer(texName, raw);
                } else {
                    void vscode.window.showErrorMessage('Failed to load texture preview.');
                }
            } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                void vscode.window.showErrorMessage(`Texture preview error: ${msg}`);
            }
        }),
    );

    const totkDiskProvider = new TotkDiskFileSystemProvider(
        bridgePath,
        getPython,
        getBridgeEnv,
        async (write: DiskWriteNotification) => {
            if (!isPathInsideArchive(write.diskPath)) {
                return;
            }
            const diskArchivePath = getDiskArchivePath(write.diskPath);
            const internalPath = getLocatorInsideDiskArchive(write.diskPath, diskArchivePath);
            await runCanonicalPropagation({
                diskArchivePath,
                internalPath,
                content: write.content,
                textContent: write.textContent,
            });
        },
    );
    context.subscriptions.push(
        vscode.workspace.registerFileSystemProvider('totk-disk', totkDiskProvider, {
            isCaseSensitive: true,
            isReadonly: false,
        }),
    );
    registerExternalToolSupport(context, { bridgePath, getPython, getBridgeEnv });

    const redirectedDocuments = new Set<string>();
    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument(async (document) => {
            if (document.uri.scheme !== 'file') {
                return;
            }
            if (!isEditableFile(document.uri.fsPath)) {
                return;
            }
            const key = document.uri.toString();
            if (redirectedDocuments.has(key)) {
                return;
            }
            redirectedDocuments.add(key);

            const totkUri = toTotkDiskUri(document.uri);
            const existingColumn = vscode.window.visibleTextEditors.find(
                (editor) => editor.document === document,
            )?.viewColumn;

            await vscode.window.showTextDocument(totkUri, {
                viewColumn: existingColumn,
                preview: false,
            });

            for (const group of vscode.window.tabGroups.all) {
                for (const tab of group.tabs) {
                    const input = tab.input;
                    if (
                        input instanceof vscode.TabInputText &&
                        input.uri.toString() === key
                    ) {
                        await vscode.window.tabGroups.close(tab);
                        break;
                    }
                }
            }
        }),
    );

    const setupPython = vscode.commands.registerCommand('totk-editor.setupPython', async () => {
        const python = await ensurePythonEnvironment(context, true);
        if (python) {
            void vscode.window.showInformationMessage('TOTK Editor: Python environment is ready.');
            void buildRomfsIndex();
            void buildCanonicalIndex();
            void importKnownProjectCanonicalPaths();
        } else {
            await promptPythonSetup(context);
        }
    });
    context.subscriptions.push(
        setupPython,
        vscode.commands.registerCommand('totk-editor.pickPython', () => pickDetectedPython(context)),
        vscode.commands.registerCommand('totk-editor.browsePython', () => browseForPython(context)),
        vscode.commands.registerCommand('totk-editor.rebuildRomfsIndex', async () => {
            const romfsPath = resolveRomfsPath();
            if (!romfsPath) {
                void vscode.window.showWarningMessage(
                    'Set totk-editor.romfsPath before rebuilding the search index.',
                );
                return;
            }
            const python = getPython();
            if (!python) {
                await promptPythonSetup(context);
                return;
            }
            void vscode.window.showInformationMessage('TOTK Editor: Rebuilding RomFS search index...');
            await buildRomfsIndex(true);
            void vscode.window.showInformationMessage('TOTK Editor: RomFS search index rebuilt.');
        }),
        vscode.commands.registerCommand('totk-editor.rebuildCanonicalPathIndex', async () => {
            const romfsPath = resolveRomfsPath();
            if (!romfsPath) {
                void vscode.window.showWarningMessage(
                    'Set totk-editor.romfsPath before rebuilding the canonical path index.',
                );
                return;
            }
            const python = getPython();
            if (!python) {
                await promptPythonSetup(context);
                return;
            }
            void vscode.window.showInformationMessage('TOTK Editor: Rebuilding canonical path index...');
            await buildCanonicalIndex(true);
            void vscode.window.showInformationMessage('TOTK Editor: Canonical path index rebuilt.');
        }),
    );

    // Start Python bootstrap in background so activation doesn't block the extension host.
    void ensurePythonEnvironment(context).then(async (python) => {
        if (!python) {
            await promptPythonSetup(context);
            return;
        }
        void buildRomfsIndex();
        void buildCanonicalIndex();
        void importKnownProjectCanonicalPaths();
    });

    await migrateOffStandaloneIconTheme(context);
    registerIconThemeCommands(context);

    archiveTree = registerArchiveTree(context);
    gameDumpTree = registerGameDumpTree(context, archiveTree);
    gameDumpTree.setExternalIndexPath(romfsIndexPath);
    await migrateSarcWorkspaceFolders(archiveTree);
    void buildRomfsIndex();
    void buildCanonicalIndex();
    void importKnownProjectCanonicalPaths();

    context.subscriptions.push(
        archiveTree.onDidChangeRoots(() => {
            void importKnownProjectCanonicalPaths();
        }),
    );

    context.subscriptions.push(
        AinbNodeEditorProvider.register(context, async (info) => {
            if (!isPathInsideArchive(info.diskPath)) {
                return;
            }
            const diskArchivePath = getDiskArchivePath(info.diskPath);
            const internalPath = getLocatorInsideDiskArchive(info.diskPath, diskArchivePath);
            await runCanonicalPropagation({
                diskArchivePath,
                internalPath,
                content: info.content,
            });
        }),
    );

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration('totk-editor.romfsPath')) {
                void buildRomfsIndex();
                void buildCanonicalIndex();
                invalidateCanonicalPathIndex();
            }
        }),
    );

    const exportFromArchiveSelection = async (
        sourceUris: vscode.Uri[],
    ): Promise<void> => {
        const archiveUris = sourceUris.filter((uri) => isPathInsideArchive(uri.fsPath));
        if (archiveUris.length === 0) {
            void vscode.window.showWarningMessage('Select one or more files inside an archive first.');
            return;
        }

        const fileUris: vscode.Uri[] = [];
        for (const uri of archiveUris) {
            try {
                const stat = await vscode.workspace.fs.stat(uri);
                if (stat.type === vscode.FileType.File) {
                    fileUris.push(uri);
                }
            } catch {
                // skip
            }
        }
        if (fileUris.length === 0) {
            void vscode.window.showWarningMessage('No files selected (folders are not exported).');
            return;
        }

        const picked = await vscode.window.showOpenDialog({
            canSelectMany: false,
            canSelectFiles: false,
            canSelectFolders: true,
            title: 'Choose export destination folder',
            openLabel: 'Export Here',
        });
        const destinationFolder = picked?.[0]?.fsPath;
        if (!destinationFolder) {
            return;
        }

        const pythonExe = getPython();
        if (!pythonExe) {
            await promptPythonSetup(context);
            return;
        }

        let exported = 0;
        for (const uri of fileUris) {
            try {
                const diskArchive = getDiskArchivePath(uri.fsPath);
                const locator = getLocatorInsideDiskArchive(uri.fsPath, diskArchive);
                const exportedPath = runBridgeJson<{ path: string }>(
                    pythonExe,
                    bridgePath,
                    ['export-temp', diskArchive, locator],
                    undefined,
                    getBridgeEnv(),
                ).path;
                const data = fs.readFileSync(exportedPath);
                fs.unlinkSync(exportedPath);

                const desiredName = path.basename(locator) || path.basename(uri.fsPath);
                const finalName = pickExportDestinationName(destinationFolder, desiredName);
                fs.writeFileSync(path.join(destinationFolder, finalName), data);
                exported++;
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                void vscode.window.showErrorMessage(`Export failed for ${uri.fsPath}: ${message}`);
            }
        }

        if (exported > 0) {
            void vscode.window.showInformationMessage(
                `Exported ${exported}/${fileUris.length} file(s) to ${destinationFolder}`,
            );
        }
    };

    context.subscriptions.push(
        vscode.commands.registerCommand(
            'totk-editor.archiveExport',
            async (item?: ArchiveTreeItem) => {
                const uris = selectedUrisFromTree(item, getArchiveSelection());
                await exportFromArchiveSelection(uris);
            },
        ),
        vscode.commands.registerCommand(
            'totk-editor.dumpExport',
            async (item?: DumpTreeItem) => {
                const uris = selectedUrisFromTree(item, getDumpSelection());
                await exportFromArchiveSelection(uris);
            },
        ),
    );

    const exportYaml = vscode.commands.registerCommand('totk-editor.exportYaml', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            void vscode.window.showWarningMessage('No active editor to export.');
            return;
        }
        const text = editor.document.getText();
        const baseName = editor.document.uri.path.split('/').pop() ?? 'export';
        const dest = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(baseName + '.yaml'),
            filters: { 'YAML': ['yaml', 'yml'] },
        });
        if (dest) {
            await vscode.workspace.fs.writeFile(dest, Buffer.from(text, 'utf-8'));
            void vscode.window.showInformationMessage(`Exported to ${dest.fsPath}`);
        }
    });
    context.subscriptions.push(exportYaml);

    const openEditableFile = vscode.commands.registerCommand('totk-editor.openEditableFile', async () => {
        const aampFilterExtensions = [...getAampExtensions()];
        const coreFilterExtensions = Object.keys(getCoreExtensions());
        const fileUri = await vscode.window.showOpenDialog({
            canSelectMany: false,
            filters: {
                'TOTK Files': [
                    ...coreFilterExtensions,
                    'zs',
                    ...aampFilterExtensions,
                ]
            },
        });

        if (fileUri?.[0]) {
            const totkUri = toTotkDiskUri(fileUri[0]);
            await vscode.window.showTextDocument(totkUri);
        }
    });
    context.subscriptions.push(openEditableFile);

    const openArchive = vscode.commands.registerCommand('totk-editor.openPack', async () => {
        const fileUri = await vscode.window.showOpenDialog({
            canSelectMany: false,
            filters: {
                'TOTK Archives': ['pack', 'sarc', 'genvb', 'blarc', 'bfarc', 'bntx', 'zs'],
            },
        });

        if (fileUri?.[0]) {
            archiveTree.addRoot(fileUri[0]);
            void focusArchiveSidebar();
        }
    });

    context.subscriptions.push(openArchive);
}

export function deactivate() { }
