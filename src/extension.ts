import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { logger } from './logger';
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
    getTkmmRecentJsonPath,
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
import { TkprojEditorProvider } from './tkprojEditor';
import { TkvscEditorProvider } from './tkvscEditor';
import { FontViewerProvider } from './fontViewer';
import { InfoJsonEditorProvider } from './infoJsonEditor';
import { setExtensionPath } from './romfsIndex';
import {
    hasBaseCanonicalPath,
    invalidateCanonicalPathIndex,
    setCanonicalIndexExtensionPath,
} from './canonicalPathIndex';
import { propagateCanonicalSave } from './canonicalSavePropagation';
import { normalizePath, pathsEqual } from './projectPaths';
import type { DiskWriteNotification } from './totkDiskFs';
import { configureFilteringRules } from './filteringRules';
import {
    clearProjectImportState,
    ensureProjectCanonicalOverlayExists,
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
    const config = vscode.workspace.getConfiguration('TKVSC');
    const romfsPath = resolveRomfsPath();
    const extraAamp = config.get<string[]>('extraAampExtensions', []);
    return {
        ...process.env,
        TOTK_EDITOR_ROMFS: romfsPath,
        TOTK_TAG_PRODUCT_FORMAT: config.get<string>('tagProductFormat', 'json'),
        TOTK_EXTRA_AAMP_EXTS: extraAamp.map((ext) => ext.replace(/^\./, '')).join(','),
        TOTK_BYML_INLINE_CONTAINER_MAX_COUNT: String(config.get<number>('bymlInlineContainerMaxCount', 1)),
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
    private virtualDirectories = new Map<string, string>();
    private fileContentCache = new Map<string, string | Uint8Array>();

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
                'Python environment is not ready. Run "TKVSC: Set Up Python Environment" or install Python 3.10+.',
            );
        }
        return python;
    }

    watch(_uri: vscode.Uri): vscode.Disposable {
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
            logger.info(`Loading archive: ${diskArchive} @ ${locator || '(root)'}`);
            files = await runBridgeJsonAsync<string[]>(
                this.requirePython(),
                this.bridgePath,
                ['list', diskArchive, locator],
                undefined,
                getBridgeEnv(),
            );
            this.fileCache.set(cacheKey, files!);
            logger.info(`Mapped ${files!.length} paths inside archive view.`);
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

        const normalized = fsPath.replace(/\\/g, '/');
        const lower = normalized.toLowerCase();
        
        if (this.virtualDirectories.has(lower)) {
            return { type: vscode.FileType.Directory, ctime: 0, mtime: 0, size: 0 };
        }
        for (const virtLower of this.virtualDirectories.keys()) {
            if (virtLower.startsWith(lower + '/')) {
                return { type: vscode.FileType.Directory, ctime: 0, mtime: 0, size: 0 };
            }
        }

        const diskArchive = this.getDiskArchive(fsPath);
        const locator = this.getLocator(fsPath, diskArchive);
        
        if (!locator) {
            return this.statDiskPath(diskArchive);
        }

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

        const targetPrefix = fsPath.replace(/\\/g, '/').toLowerCase().replace(/\/$/, '') + '/';
        for (const [virtLower, virtOriginal] of this.virtualDirectories.entries()) {
            if (virtLower.startsWith(targetPrefix) && virtLower.length > targetPrefix.length) {
                const remainderOriginal = virtOriginal.substring(targetPrefix.length);
                const slashIndex = remainderOriginal.indexOf('/');
                const childName = slashIndex === -1 ? remainderOriginal : remainderOriginal.substring(0, slashIndex);
                if (childName) {
                    const existingKey = Array.from(result.keys()).find(k => k.toLowerCase() === childName.toLowerCase());
                    if (!existingKey) {
                        result.set(childName, vscode.FileType.Directory);
                    }
                }
            }
        }

        return Array.from(result.entries());
    }

    async readFile(uri: vscode.Uri): Promise<Uint8Array> {
        const fsPath = uri.fsPath;

        if (!this.usesArchiveListing(fsPath) || (!isPathInsideArchive(fsPath) && isArchiveFile(fsPath))) {
            if (isEditableFile(fsPath)) {
                try {
                    logger.showProcessingToast(fsPath);
                    const content = await runBridgeReadContentAsync(
                        this.requirePython(),
                        this.bridgePath,
                        ['read-disk', fsPath],
                        getBridgeEnv(),
                    );
                    this.fileContentCache.set(uri.toString(), content);
                    return new TextEncoder().encode(content);
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    return new TextEncoder().encode(`Error reading file: ${message}`);
                }
            }
            const raw = await fs.promises.readFile(fsPath);
            this.fileContentCache.set(uri.toString(), raw);
            // For non-editable binary files opened from archive-related trees, show external-tool actions.
            if ((uri.scheme === 'totk-dump' || uri.scheme === 'sarc') && isLikelyBinaryBuffer(raw) && !isArchiveFile(fsPath)) {
                return new TextEncoder().encode(
                    formatExternalToolPrompt(
                        fsPath,
                        'TKVSC does not have a built-in parser for this file type yet.',
                    ),
                );
            }
            return raw;
        }

        const diskArchive = this.getDiskArchive(fsPath);
        const filePath = this.getLocator(fsPath, diskArchive);

        try {
            logger.info(`Reading: ${diskArchive} / ${filePath}`);
            if (isEditableFile(fsPath)) {
                logger.showProcessingToast(fsPath);
            }
            const content = await runBridgeReadContentAsync(
                this.requirePython(),
                this.bridgePath,
                ['read', diskArchive, filePath],
                getBridgeEnv(),
            );

            if (shouldOfferExternalToolPrompt(content)) {
                const reason = content.startsWith('Error reading file:')
                    ? content
                    : 'TKVSC does not have a built-in parser for this file type yet.';
                return new TextEncoder().encode(formatExternalToolPrompt(filePath, reason));
            }

            if (isEditableFile(fsPath)) {
                this.fileContentCache.set(uri.toString(), content);
            } else {
                this.fileContentCache.set(uri.toString(), new TextEncoder().encode(content));
            }

            return new TextEncoder().encode(content);
        } catch (error) {
            logger.error('Python Read Error:', error as Error);
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

    async createDirectory(uri: vscode.Uri): Promise<void> {
        const fsPath = uri.fsPath;
        if (this.isMutatableDiskPath(fsPath)) {
            await createDiskDirectory(fsPath);
            this.notifyChanged(uri, vscode.FileChangeType.Created);
            return;
        }

        const normalized = fsPath.replace(/\\/g, '/');
        this.virtualDirectories.set(normalized.toLowerCase(), normalized);
        this.notifyChanged(uri, vscode.FileChangeType.Created);
    }

    async writeFile(uri: vscode.Uri, content: Uint8Array, _options: { create: boolean; overwrite: boolean }): Promise<void> {
        const fsPath = uri.fsPath;

        if (this.isMutatableDiskPath(fsPath)) {
            if (isEditableFile(fsPath)) {
                if (!fs.existsSync(fsPath)) {
                    await fs.promises.writeFile(fsPath, content);
                    logger.showSavedToast(fsPath);
                    this.fileContentCache.set(uri.toString(), new TextDecoder().decode(content));
                    return;
                }
                try {
                    logger.showProcessingToast(fsPath);
                    const text = new TextDecoder().decode(content);

                    const cached = this.fileContentCache.get(uri.toString());
                    if (cached !== undefined && cached === text) {
                        logger.info(`Skipping write and canonical sync for unchanged file: ${fsPath}`);
                        return;
                    }

                    await runBridgeJsonAsync<{ success: boolean }>(
                        this.requirePython(),
                        this.bridgePath,
                        ['write-disk', fsPath],
                        text,
                        getBridgeEnv(),
                    );
                    logger.showSavedToast(fsPath);
                    this.fileContentCache.set(uri.toString(), text);
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    vscode.window.showErrorMessage(`Failed to save: ${message}`);
                    throw vscode.FileSystemError.Unavailable(message);
                }
                return;
            }

            const cached = this.fileContentCache.get(uri.toString());
            if (cached instanceof Uint8Array && cached.length === content.length && Buffer.compare(cached, content) === 0) {
                logger.info(`Skipping write for unchanged file: ${fsPath}`);
                return;
            }
            await fs.promises.writeFile(fsPath, content);
            this.fileContentCache.set(uri.toString(), content);
            return;
        }

        const diskArchive = this.getDiskArchive(fsPath);
        const filePath = this.getLocator(fsPath, diskArchive);

        try {
            logger.info(`Writing back to: ${diskArchive} / ${filePath}`);
            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: `Saving and repacking ${path.basename(diskArchive)}...`,
                    cancellable: false,
                },
                async () => {
                    if (isEditableFile(fsPath) && content.length > 0 && !isLikelyBinaryBuffer(content)) {
                        logger.showProcessingToast(fsPath);
                        const yamlContent = new TextDecoder().decode(content);

                        const cached = this.fileContentCache.get(uri.toString());
                        if (cached !== undefined && cached === yamlContent) {
                            logger.info(`Skipping write and canonical sync for unchanged file inside archive: ${fsPath}`);
                            return;
                        }

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
                        logger.showSavedToast(fsPath);
                        this.fileContentCache.set(uri.toString(), yamlContent);
                    } else {
                        const cached = this.fileContentCache.get(uri.toString());
                        if (cached instanceof Uint8Array && cached.length === content.length && Buffer.compare(cached, content) === 0) {
                            logger.info(`Skipping write and canonical sync for unchanged file inside archive: ${fsPath}`);
                            return;
                        }

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
                        this.fileContentCache.set(uri.toString(), content);
                    }

                    for (const key of [...this.fileCache.keys()]) {
                        if (key.startsWith(`${diskArchive}::`)) {
                            this.fileCache.delete(key);
                        }
                    }
                    logger.info('Successfully saved and repacked SARC!');
                }
            );
        } catch (error) {
            logger.error('Python Write Error:', error as Error);
            vscode.window.showErrorMessage(`Failed to save: ${error}`);
            throw vscode.FileSystemError.Unavailable(error as string);
        }
    }

    async delete(uri: vscode.Uri, options: { recursive: boolean }): Promise<void> {
        const fsPath = uri.fsPath;
        this.fileContentCache.delete(uri.toString());
        if (this.isMutatableDiskPath(fsPath)) {
            await deleteDiskPath(fsPath, options.recursive);
            this.notifyChanged(uri, vscode.FileChangeType.Deleted);
            return;
        }

        const normalizedPath = fsPath.replace(/\\/g, '/');
        const lowerPath = normalizedPath.toLowerCase();
        let deletedVirtual = false;
        
        if (this.virtualDirectories.has(lowerPath)) {
            this.virtualDirectories.delete(lowerPath);
            deletedVirtual = true;
        }
        for (const virtLower of this.virtualDirectories.keys()) {
            if (virtLower.startsWith(lowerPath + '/')) {
                this.virtualDirectories.delete(virtLower);
                deletedVirtual = true;
            }
        }

        const diskArchive = this.getDiskArchive(fsPath);
        const filePath = this.getLocator(fsPath, diskArchive);
        
        try {
            await runBridgeJsonAsync<{ success: boolean }>(
                this.requirePython(),
                this.bridgePath,
                ['delete-entry', diskArchive, filePath],
                undefined,
                getBridgeEnv(),
            );
        } catch (error) {
            if (!deletedVirtual) {
                throw error;
            }
        }

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
        const cached = this.fileContentCache.get(oldUri.toString());
        if (cached !== undefined) {
            this.fileContentCache.delete(oldUri.toString());
            this.fileContentCache.set(newUri.toString(), cached);
        }
        if (this.isMutatableDiskPath(oldPath) && this.isMutatableDiskPath(newPath)) {
            await renameDiskPath(oldPath, newPath, options.overwrite);
            this.notifyChanged(oldUri, vscode.FileChangeType.Deleted);
            this.notifyChanged(newUri, vscode.FileChangeType.Created);
            return;
        }

        const oldNormalized = oldPath.replace(/\\/g, '/');
        const oldLower = oldNormalized.toLowerCase();
        const newNormalized = newPath.replace(/\\/g, '/');
        const newLower = newNormalized.toLowerCase();
        let renamedVirtual = false;

        for (const [virtLower, virtOriginal] of Array.from(this.virtualDirectories.entries())) {
            if (virtLower === oldLower) {
                this.virtualDirectories.delete(virtLower);
                this.virtualDirectories.set(newLower, newNormalized);
                renamedVirtual = true;
            } else if (virtLower.startsWith(oldLower + '/')) {
                this.virtualDirectories.delete(virtLower);
                const remainder = virtOriginal.substring(oldNormalized.length);
                const newVirtOriginal = newNormalized + remainder;
                this.virtualDirectories.set(newVirtOriginal.toLowerCase(), newVirtOriginal);
                renamedVirtual = true;
            }
        }

        const oldDiskArchive = this.getDiskArchive(oldPath);
        const newDiskArchive = this.getDiskArchive(newPath);
        if (oldDiskArchive !== newDiskArchive) {
            this.rejectArchiveMutation('move files across different archives');
        }
        const oldLocator = this.getLocator(oldPath, oldDiskArchive);
        const newLocator = this.getLocator(newPath, newDiskArchive);
        
        try {
            await runBridgeJsonAsync<{ success: boolean }>(
                this.requirePython(),
                this.bridgePath,
                ['rename-entry', oldDiskArchive, oldLocator, newLocator],
                undefined,
                getBridgeEnv(),
            );
        } catch (error) {
            if (!renamedVirtual) {
                throw error;
            }
        }

        for (const key of [...this.fileCache.keys()]) {
            if (key.startsWith(`${oldDiskArchive}::`)) {
                this.fileCache.delete(key);
            }
        }
        this.notifyChanged(oldUri, vscode.FileChangeType.Deleted);
        this.notifyChanged(newUri, vscode.FileChangeType.Created);
    }
}

function cleanupOldTempFiles() {
    try {
        const tmpdir = os.tmpdir();
        const files = fs.readdirSync(tmpdir);
        const prefixes = ['totk-tex-', 'totk-txtg-', 'totk-tool-', 'totk-cvt-', 'totk-xlnk-'];
        
        for (const file of files) {
            if (prefixes.some(p => file.startsWith(p))) {
                try {
                    const fullPath = path.join(tmpdir, file);
                    const stat = fs.statSync(fullPath);
                    // Delete files older than 1 hour to avoid deleting temp files currently in use by another VS Code window
                    if (stat.isFile() && Date.now() - stat.mtimeMs > 3600000) {
                        fs.unlinkSync(fullPath);
                    }
                } catch { }
            }
        }
    } catch (e) {
        logger.error('Failed to cleanup old temp files:', e as Error);
    }
}

export async function activate(context: vscode.ExtensionContext) {
    logger.init(context);
    logger.info('Activating TKVSC extension...');
    
    // Clean up leftover temp files from previous sessions
    cleanupOldTempFiles();
    
    initAampExtensions(context.extensionPath);
    initCoreFsExtensions(context.extensionPath);
    initTextureViewer(context.extensionUri);
    setExtensionPath(context.extensionPath);
    setCanonicalIndexExtensionPath(context.extensionPath);
    setProjectCanonicalOverlayExtensionPath(context.extensionPath);
    logger.info('TKVSC dependencies initialized.');
    
    const output: vscode.OutputChannel = {
        name: 'TKVSC',
        append: (value: string) => logger.info(value),
        appendLine: (value: string) => logger.info(value),
        clear: () => {},
        show: () => logger.show(),
        hide: () => {},
        dispose: () => {}
    } as any;

    context.subscriptions.push(
        vscode.commands.registerCommand('totk-editor.setupPython', async () => {
            const python = await ensurePythonEnvironment(context, true);
            if (python) {
                void vscode.window.showInformationMessage('TKVSC: Python environment is ready.');
                void runFirstTimeSetup(context);
            } else {
                await promptPythonSetup(context);
            }
        }),
        vscode.commands.registerCommand('totk-editor.runSetup', async () => {
            await context.globalState.update('TKVSC.hasPromptedRomfsPath', false);
            await context.globalState.update('TKVSC.hasPromptedProjectsPath', false);
            await context.globalState.update('TKVSC.hasPromptedTKMMImport', false);
            void runFirstTimeSetup(context);
        }),
        vscode.commands.registerCommand('totk-editor.pickPython', () => pickDetectedPython(context)),
        vscode.commands.registerCommand('totk-editor.browsePython', () => browseForPython(context)),
    );

    registerDocumentLanguageModes(context);
    context.subscriptions.push(TkprojEditorProvider.register(context));
    context.subscriptions.push(TkvscEditorProvider.register(context));
    
    const bridgePath = path.join(context.extensionPath, 'python', 'totk_bridge.py');
    const getPython = () => getCachedPythonExecutable() ?? '';

    const getRawFontBytes = async (uri: vscode.Uri): Promise<Uint8Array> => {
        if (uri.scheme === 'file') {
            return await fs.promises.readFile(uri.fsPath);
        }
        
        const fsPath = uri.fsPath;
        const diskArchive = getDiskArchivePath(fsPath);
        const locator = getLocatorInsideDiskArchive(fsPath, diskArchive);
        
        if (!locator || diskArchive === fsPath) {
            return await fs.promises.readFile(fsPath);
        }

        const result = await runBridgeJsonAsync<{ path: string }>(
            getPython(),
            bridgePath,
            ['export-temp', diskArchive, locator],
            undefined,
            getBridgeEnv()
        );
        const raw = await fs.promises.readFile(result.path);
        try {
            fs.unlinkSync(result.path);
        } catch {}
        return raw;
    };
    context.subscriptions.push(FontViewerProvider.register(context, getRawFontBytes));
    context.subscriptions.push(InfoJsonEditorProvider.register(context));

    context.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider('totk-font', {
            provideTextDocumentContent: () => 'Font preview not supported as text.',
        })
    );
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
    const PROJECT_CANONICAL_IMPORT_SCHEMA_VERSION = 3;
    let romfsIndexBuildPromise: Promise<void> | undefined;
    let canonicalIndexBuildPromise: Promise<void> | undefined;
    let gameDumpTree: ReturnType<typeof registerGameDumpTree> | undefined;
    let archiveTree: ReturnType<typeof registerArchiveTree> | undefined;

    const shouldPropagateCanonicalSaves = (): boolean => {
        const config = vscode.workspace.getConfiguration('TKVSC');
        return config.get<boolean>('enableCanonicalSavePropagation', true);
    };
    const getCanonicalBlacklistPrefixes = (): string[] => {
        const config = vscode.workspace.getConfiguration('TKVSC');
        return config.get<string[]>('canonicalSyncBlacklistPrefixes', ['Mals', 'UI']);
    };
    const getCanonicalArchiveTypeBlacklist = (): string[] => {
        const config = vscode.workspace.getConfiguration('TKVSC');
        return config.get<string[]>('canonicalSyncArchiveTypeBlacklist', ['.sarc', '.blarc']);
    };
    const getCanonicalFileExtensionBlacklist = (): string[] => {
        const config = vscode.workspace.getConfiguration('TKVSC');
        return config.get<string[]>('canonicalSyncFileExtensionBlacklist', []);
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
        romfsIndexBuildPromise = Promise.resolve(vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Building RomFS search index (this can take a few minutes)...',
                cancellable: false,
            },
            async () => {
                try {
                    logger.info(`Starting RomFS search index build at: ${romfsIndexPath}`);
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
                    logger.info('RomFS search index built successfully.');
                    gameDumpTree?.onExternalIndexUpdated();
                } catch (err) {
                    logger.error('Failed to build RomFS search index:', err as Error);
                } finally {
                    gameDumpTree?.setExternalIndexBuilding(false);
                    romfsIndexBuildPromise = undefined;
                }
            }
        ));
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

        canonicalIndexBuildPromise = Promise.resolve(vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Building Canonical Path Index (this can take a few minutes)...',
                cancellable: false,
            },
            async () => {
                try {
                    logger.info(`Starting canonical path index build at: ${canonicalIndexPath}`);
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
                    logger.info('Canonical path index built successfully.');
                    invalidateCanonicalPathIndex();
                    await clearProjectImportState(projectCanonicalOverlayPath);
                    void importKnownProjectCanonicalPaths();
                } catch (err) {
                    logger.error('Failed to build canonical path index:', err as Error);
                } finally {
                    canonicalIndexBuildPromise = undefined;
                }
            }
        ));
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
            fileExtensionBlacklist: getCanonicalFileExtensionBlacklist(),
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
        await ensureProjectCanonicalOverlayExists(projectCanonicalOverlayPath);
        if (!archiveTree || !pythonExe || !romfsPath) {
            return;
        }
        await buildCanonicalIndex();
        const roots = archiveTree.getProjectRoots();
        if (roots.length === 0) {
            return;
        }

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Scanning project files and mapping canonical paths...',
                cancellable: false,
            },
            async () => {
                for (const root of roots) {
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
            }
        );
    };

    context.subscriptions.push(
        vscode.commands.registerCommand(
            'totk-editor.configureFilteringRules',
            async (item: any) => {
                let uri: vscode.Uri | undefined;
                if (item instanceof vscode.Uri) {
                    uri = item;
                } else if (item && typeof item === 'object' && 'resourceUri' in item && item.resourceUri) {
                    uri = item.resourceUri;
                } else {
                    uri = vscode.window.activeTextEditor?.document.uri;
                }

                if (!uri) {
                    void vscode.window.showWarningMessage('No active file selected to configure filter rules.');
                    return;
                }

                const projectRoots = archiveTree?.getProjectRoots() ?? [];
                await configureFilteringRules(uri, projectRoots);
            }
        ),
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
            void vscode.window.showInformationMessage('TKVSC: Rebuilding RomFS search index...');
            await buildRomfsIndex(true);
            void vscode.window.showInformationMessage('TKVSC: RomFS search index rebuilt.');
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
            void vscode.window.showInformationMessage('TKVSC: Rebuilding canonical path index...');
            await buildCanonicalIndex(true);
            void vscode.window.showInformationMessage('TKVSC: Canonical path index rebuilt.');
        }),
        vscode.commands.registerCommand('totk-editor.canonicalSyncOn', async () => {
            const config = vscode.workspace.getConfiguration('TKVSC');
            await config.update('enableCanonicalSavePropagation', false, vscode.ConfigurationTarget.Global);
            void vscode.window.showInformationMessage('TKVSC: Canonical sync disabled.');
        }),
        vscode.commands.registerCommand('totk-editor.canonicalSyncOff', async () => {
            const config = vscode.workspace.getConfiguration('TKVSC');
            await config.update('enableCanonicalSavePropagation', true, vscode.ConfigurationTarget.Global);
            void vscode.window.showInformationMessage('TKVSC: Canonical sync enabled.');
        }),
    );

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
                    openTextureViewer(texName, raw, diskArchive, filePath, async (data) => {
                        const payloadStr = JSON.stringify(data);
                        const updateArgs = isTxtgFile(uri.fsPath)
                            ? ['update-txtg-metadata', diskArchive, filePath, payloadStr]
                            : ['update-metadata', diskArchive, filePath, payloadStr];
                        
                        const result = await runBridgeReadAsync(
                            python,
                            bridgePath,
                            updateArgs,
                            getBridgeEnv()
                        );
                        if (result && (result as any).error) {
                            throw new Error((result as any).error);
                        }
                        
                        // Automatically refresh the texture viewer to show the applied changes
                        void vscode.commands.executeCommand('totk-editor.openBntxTexture', uri);
                    });
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

    // Start Python bootstrap in background so activation doesn't block the extension host.
    logger.info('Starting Python background environment setup...');
    void ensurePythonEnvironment(context).then(async (python) => {
        if (!python) {
            logger.warn('Python environment is not ready after activation check.');
            await promptPythonSetup(context);
            return;
        }
        logger.info('Python background setup completed. Commencing search and canonical index building.');
        void buildRomfsIndex();
        void buildCanonicalIndex();
        void importKnownProjectCanonicalPaths();

        void runFirstTimeSetup(context);
    }).catch(async (err) => {
        logger.error('Error in background Python setup:', err as Error);
        await promptPythonSetup(context);
    });

    try {
        await migrateOffStandaloneIconTheme(context);
    } catch (error) {
        output.appendLine(`Icon theme migration failed: ${error}`);
    }
    registerIconThemeCommands(context);

    archiveTree = registerArchiveTree(context);
    gameDumpTree = registerGameDumpTree(context, archiveTree, () => importKnownProjectCanonicalPaths());
    gameDumpTree.setExternalIndexPath(romfsIndexPath);
    void ensureProjectCanonicalOverlayExists(projectCanonicalOverlayPath);
    await migrateSarcWorkspaceFolders(archiveTree);
    void buildRomfsIndex();
    void buildCanonicalIndex();
    void importKnownProjectCanonicalPaths();

    context.subscriptions.push(
        archiveTree.onDidChangeRoots(() => {
            void importKnownProjectCanonicalPaths();
        }),
    );

    const EXPORT_FILTERS: Record<string, Record<string, string[]>> = {
        '.bntx': { 'Binary Texture': ['bntx'], 'DDS': ['dds'], 'PNG': ['png'], 'JPEG': ['jpg'], 'TGA': ['tga'], 'BMP': ['bmp'] },
        '.bftex': { 'Binary Texture': ['bftex'], 'DDS': ['dds'], 'PNG': ['png'], 'JPEG': ['jpg'], 'TGA': ['tga'], 'BMP': ['bmp'] },
        '.nutexb': { 'Smash Ultimate Texture': ['nutexb'], 'DDS': ['dds'], 'PNG': ['png'], 'JPEG': ['jpg'], 'TGA': ['tga'], 'BMP': ['bmp'] },
        '.bfmdl': { 'Bfres Model': ['bfmdl'], 'FBX': ['fbx'], 'DAE': ['dae'], 'OBJ': ['obj'] },
        '.bfobj': { 'Bfres Object': ['bfobj'], 'DAE': ['dae'] },
        '.bfska': { 'Bfres Skeletal Animation': ['bfska'], 'Maya Anim': ['anim'], 'SE Anim': ['seanim'], 'SMD': ['smd'], 'CHR0': ['chr0'] },
        '.bfmaa': { 'Bfres Material Animation': ['bfmaa'], 'YAML': ['yaml'] },
        '.bfshu': { 'Bfres Shader Param Animation': ['bfshu'], 'YAML': ['yaml'] },
        '.bftsh': { 'Bfres Texture SRT Animation': ['bftsh'], 'YAML': ['yaml'] },
        '.bfcsh': { 'Bfres Color Animation': ['bfcsh'], 'YAML': ['yaml'] },
        '.bftxp': { 'Bfres Texture Pattern Animation': ['bftxp'], 'YAML': ['yaml'], 'GIF': ['gif'] },
        '.byml': { 'BYML': ['byml'], 'YAML': ['yaml'] },
        '.bgyml': { 'BYML': ['bgyml'], 'YAML': ['yaml'] },
        '.txtg': { 'TexToGo Image': ['txtg'], 'DDS': ['dds'], 'PNG': ['png'], 'JPEG': ['jpg'], 'TGA': ['tga'], 'BMP': ['bmp'] },
        '.msbt': { 'Message Text': ['msbt'], 'JSON': ['json'], 'Text': ['txt'] },
    };

    const getFiltersForExtension = (ext: string): Record<string, string[]> => {
        const rawExt = ext.replace('.', '').toLowerCase();
        if (getAampExtensions().has(rawExt)) {
            return { 'AAMP Parameter': [rawExt], 'YAML': ['yaml'] };
        }
        return EXPORT_FILTERS[ext.toLowerCase()] ?? { 'Original format': [rawExt || '*'] };
    };

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration('TKVSC.romfsPath')) {
                void buildRomfsIndex();
                void buildCanonicalIndex();
                invalidateCanonicalPathIndex();
            }
        }),
    );

    const exportFromArchiveSelection = async (
        sourceUris: vscode.Uri[],
    ): Promise<void> => {
        if (sourceUris.length === 0) {
            void vscode.window.showWarningMessage('Select one or more files to export.');
            return;
        }

        const fileUris: vscode.Uri[] = [];
        for (const uri of sourceUris) {
            try {
                const stat = await vscode.workspace.fs.stat(uri);
                if (stat.type === vscode.FileType.File) {
                    fileUris.push(uri);
                }
            } catch {
                // Pass
            }
        }
        if (fileUris.length === 0) {
            void vscode.window.showWarningMessage('No files selected (folders are not exported).');
            return;
        }

        if (fileUris.length === 1) {
            const singleUri = fileUris[0];
            const originalName = path.basename(singleUri.fsPath);
            const extMatch = originalName.match(/(\.[a-zA-Z0-9]+)$/);
            let ext = extMatch ? extMatch[1] : '';
            
            // Handle extensionless files inside BNTX (they are just the texture names)
            if (!ext && (singleUri.fsPath.includes('.bntx') || singleUri.fsPath.includes('.bftex') || singleUri.fsPath.includes('.nutexb'))) {
                ext = '.bftex';
            }
            
            const filters = getFiltersForExtension(ext);

            const destUri = await vscode.window.showSaveDialog({
                title: 'Export As...',
                defaultUri: vscode.Uri.file(originalName),
                filters
            });

            if (!destUri) {
                return;
            }

            const pythonExe = getPython();
            if (!pythonExe) {
                await promptPythonSetup(context);
                return;
            }

            try {
                const diskArchive = getDiskArchivePath(singleUri.fsPath);
                const locator = getLocatorInsideDiskArchive(singleUri.fsPath, diskArchive);
                
                // Get the target format extension
                const targetExt = path.extname(destUri.fsPath).toLowerCase();

                const bridgeResult = await runBridgeJsonAsync<{ path: string; error?: string }>(
                    pythonExe,
                    bridgePath,
                    ['export-converted', diskArchive, locator, targetExt],
                    undefined,
                    getBridgeEnv(),
                );
                
                if (bridgeResult.error) {
                    throw new Error(bridgeResult.error);
                }
                
                const exportedPath = bridgeResult.path;
                const data = await fs.promises.readFile(exportedPath);
                try {
                    await fs.promises.unlink(exportedPath);
                } catch {
                    // best effort
                }
                
                await vscode.workspace.fs.writeFile(destUri, data);
                void vscode.window.showInformationMessage(`Exported to ${destUri.fsPath}`);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                void vscode.window.showErrorMessage(`Export failed for ${singleUri.fsPath}: ${message}`);
            }
        } else {
            const picked = await vscode.window.showOpenDialog({
                canSelectMany: false,
                canSelectFiles: false,
                canSelectFolders: true,
                title: 'Choose export destination folder (Batch Export)',
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

            const tasks = fileUris.map(async (uri) => {
                try {
                    const diskArchive = getDiskArchivePath(uri.fsPath);
                    const locator = getLocatorInsideDiskArchive(uri.fsPath, diskArchive);
                    const bridgeResult = await runBridgeJsonAsync<{ path: string; error?: string }>(
                        pythonExe,
                        bridgePath,
                        ['export-temp', diskArchive, locator],
                        undefined,
                        getBridgeEnv(),
                    );
                    if (bridgeResult.error) {
                        throw new Error(bridgeResult.error);
                    }
                    const exportedPath = bridgeResult.path;
                    const data = await fs.promises.readFile(exportedPath);
                    try {
                        await fs.promises.unlink(exportedPath);
                    } catch {
                        // best effort
                    }
                    return { uri, locator, data };
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    void vscode.window.showErrorMessage(`Export failed for ${uri.fsPath}: ${message}`);
                    return null;
                }
            });

            const fetched = await Promise.all(tasks);

            let exported = 0;
            for (const item of fetched) {
                if (!item) {
                    continue;
                }
                try {
                    const desiredName = path.basename(item.locator) || path.basename(item.uri.fsPath);
                    const finalName = pickExportDestinationName(destinationFolder, desiredName);
                    await fs.promises.writeFile(path.join(destinationFolder, finalName), item.data);
                    exported++;
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    void vscode.window.showErrorMessage(`Export failed for ${item.uri.fsPath}: ${message}`);
                }
            }

            if (exported > 0) {
                void vscode.window.showInformationMessage(
                    `Exported ${exported}/${fileUris.length} file(s) to ${destinationFolder}`,
                );
            }
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
        vscode.commands.registerCommand(
            'totk-editor.explorerExport',
            async (uri?: vscode.Uri, selectedUris?: vscode.Uri[]) => {
                const uris = selectedUris && selectedUris.length > 0 ? selectedUris : (uri ? [uri] : []);
                if (uris.length > 0) {
                    await exportFromArchiveSelection(uris);
                }
            }
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
            await archiveTree.addRoot(fileUri[0]);
            void focusArchiveSidebar();
        }
    });

    context.subscriptions.push(openArchive);
}

async function runFirstTimeSetup(context: vscode.ExtensionContext): Promise<void> {
    const romfsPathPrompted = context.globalState.get<boolean>('TKVSC.hasPromptedRomfsPath');
    if (!romfsPathPrompted) {
        let validRomfsSelected = false;
        while (!validRomfsSelected) {
            const pathChoice = await vscode.window.showInformationMessage(
                'TKVSC: Please select your RomFS (game dump) directory.',
                'Browse',
                'Skip'
            );
            if (pathChoice === 'Browse') {
                const folderUri = await vscode.window.showOpenDialog({
                    canSelectFiles: false,
                    canSelectFolders: true,
                    canSelectMany: false,
                    openLabel: 'Select RomFS Folder'
                });
                if (folderUri && folderUri.length > 0) {
                    const fsPath = folderUri[0].fsPath;
                    
                    const zsdicPath = path.join(fsPath, 'Pack', 'ZsDic.pack.zs');
                    if (fs.existsSync(zsdicPath)) {
                        const config = vscode.workspace.getConfiguration('TKVSC');
                        await config.update('romfsPath', fsPath, vscode.ConfigurationTarget.Global);
                        void vscode.window.showInformationMessage(`TKVSC: RomFS path set to ${fsPath}`);
                        validRomfsSelected = true;
                    } else {
                        let foundNested = false;
                        try {
                            const entries = await vscode.workspace.fs.readDirectory(folderUri[0]);
                            for (const [name, type] of entries) {
                                if (type === vscode.FileType.Directory) {
                                    const nestedPath = path.join(fsPath, name);
                                    if (fs.existsSync(path.join(nestedPath, 'Pack', 'ZsDic.pack.zs'))) {
                                        const config = vscode.workspace.getConfiguration('TKVSC');
                                        await config.update('romfsPath', nestedPath, vscode.ConfigurationTarget.Global);
                                        void vscode.window.showInformationMessage(`TKVSC: RomFS path set to ${nestedPath}`);
                                        validRomfsSelected = true;
                                        foundNested = true;
                                        break;
                                    }
                                }
                            }
                        } catch {
                            // ignore
                        }
                        
                        if (foundNested) {
                            continue;
                        }
                        
                        await vscode.window.showWarningMessage('TKVSC: The selected directory must contain a "Pack/ZsDic.pack.zs" file. Please choose a valid game dump directory.', { modal: true });
                    }
                } else {
                    break;
                }
            } else {
                break;
            }
        }
        void context.globalState.update('TKVSC.hasPromptedRomfsPath', true);
    }

    const projectsPathPrompted = context.globalState.get<boolean>('TKVSC.hasPromptedProjectsPath');
    if (!projectsPathPrompted) {
        void context.globalState.update('TKVSC.hasPromptedProjectsPath', true);
        const pathChoice = await vscode.window.showInformationMessage(
            'TKVSC: Please select a default directory where new projects will be saved.',
            'Browse',
            'Skip'
        );
        if (pathChoice === 'Browse') {
            const folderUri = await vscode.window.showOpenDialog({
                canSelectFiles: false,
                canSelectFolders: true,
                canSelectMany: false,
                openLabel: 'Select Default Project Folder'
            });
            if (folderUri && folderUri.length > 0) {
                const config = vscode.workspace.getConfiguration('TKVSC');
                await config.update('projectsPath', folderUri[0].fsPath, vscode.ConfigurationTarget.Global);
                void vscode.window.showInformationMessage(`TKVSC: Default project folder set to ${folderUri[0].fsPath}`);
            }
        }
    }

    const tkmmPrompted = context.globalState.get<boolean>('TKVSC.hasPromptedTKMMImport');
    if (!tkmmPrompted) {
        void context.globalState.update('TKVSC.hasPromptedTKMMImport', true);
        const tkmmPath = await getTkmmRecentJsonPath();
        if (tkmmPath) {
            void vscode.window.showInformationMessage(
                'TKVSC: Would you like to import your existing projects from TKMM?',
                'Yes',
                'No'
            ).then(choice => {
                if (choice === 'Yes') {
                    void vscode.commands.executeCommand('totk-editor.importTKMMProjects');
                }
            });
        }
    }
}

export function deactivate() { }
