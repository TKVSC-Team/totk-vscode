import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { Buffer } from 'buffer';
import { isBntxTextureResult, runBridgeJson, runBridgeRead, runBridgeReadContent } from './bridge';
import { openTextureViewer } from './textureViewer';
import {
    ensurePythonEnvironment,
    getCachedPythonExecutable,
    promptPythonSetup,
    browseForPython,
    pickDetectedPython,
} from './pythonEnv';
import { registerSyntaxColorSync } from './syntaxColors';
import { isEditableFile, toTotkDiskUri } from './editableFiles';
import { TotkDiskFileSystemProvider } from './totkDiskFs';
import {
    archiveCacheKey,
    getDiskArchivePath,
    getLocatorInsideDiskArchive,
    isArchiveBrowsePath,
    isArchiveFile,
    isPathInsideArchive,
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
    const xlinkTool = config.get<string>('xlinkToolPath', '').trim();
    return {
        ...process.env,
        TOTK_EDITOR_ROMFS: romfsPath,
        TOTK_EXTRA_AAMP_EXTS: extraAamp.map((ext) => ext.replace(/^\./, '')).join(','),
        ...(xlinkTool ? { TOTK_XLINK_TOOL: xlinkTool } : {}),
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

    private loadArchiveListing(diskArchive: string, locator: string): string[] {
        const cacheKey = archiveCacheKey(diskArchive, locator);
        let files = this.fileCache.get(cacheKey);
        if (!files) {
            console.log(`Loading archive: ${diskArchive} @ ${locator || '(root)'}`);
            files = runBridgeJson<string[]>(
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

    private entryTypeForLocator(diskArchive: string, locator: string): vscode.FileType | undefined {
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
        const files = this.loadArchiveListing(diskArchive, parentLocator);
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

    stat(uri: vscode.Uri): vscode.FileStat {
        const fsPath = uri.fsPath;

        if (!this.usesArchiveListing(fsPath)) {
            return this.statDiskPath(fsPath);
        }

        const diskArchive = this.getDiskArchive(fsPath);
        const locator = this.getLocator(fsPath, diskArchive);
        const entryType = this.entryTypeForLocator(diskArchive, locator);
        if (entryType === vscode.FileType.Directory) {
            return { type: entryType, ctime: 0, mtime: 0, size: 0 };
        }
        if (entryType === vscode.FileType.File) {
            return { type: entryType, ctime: 0, mtime: 0, size: 100 };
        }

        throw vscode.FileSystemError.FileNotFound(fsPath);
    }

    readDirectory(uri: vscode.Uri): [string, vscode.FileType][] {
        const fsPath = uri.fsPath;

        if (!this.usesArchiveListing(fsPath)) {
            return this.listDiskDirectory(fsPath);
        }

        const diskArchive = this.getDiskArchive(fsPath);
        const locator = this.getLocator(fsPath, diskArchive);
        const files = this.loadArchiveListing(diskArchive, locator);

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

    readFile(uri: vscode.Uri): Uint8Array {
        const fsPath = uri.fsPath;

        if (!this.usesArchiveListing(fsPath)) {
            if (isEditableFile(fsPath)) {
                try {
                    const content = runBridgeReadContent(
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
            const content = runBridgeReadContent(
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
            `Cannot ${operation} paths inside .pack / .sarc / .genvb / .blarc / .bntx archives. Extract the file or use a dedicated modding tool.`,
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

    writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean }): void {
        const fsPath = uri.fsPath;

        if (this.isMutatableDiskPath(fsPath)) {
            if (isEditableFile(fsPath)) {
                if (!fs.existsSync(fsPath)) {
                    fs.writeFileSync(fsPath, content);
                    return;
                }
                try {
                    const text = new TextDecoder().decode(content);
                    runBridgeJson<{ success: boolean }>(
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
                runBridgeJson<{ success: boolean }>(
                    this.requirePython(),
                    this.bridgePath,
                    ['write', diskArchive, filePath],
                    yamlContent,
                    getBridgeEnv(),
                );
            } else {
                const encoded = Buffer.from(content).toString('base64');
                runBridgeJson<{ success: boolean }>(
                    this.requirePython(),
                    this.bridgePath,
                    ['write-raw', diskArchive, filePath],
                    encoded,
                    getBridgeEnv(),
                );
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

    delete(uri: vscode.Uri, options: { recursive: boolean }): void {
        const fsPath = uri.fsPath;
        if (this.isMutatableDiskPath(fsPath)) {
            deleteDiskPath(fsPath, options.recursive);
            this.notifyChanged(uri, vscode.FileChangeType.Deleted);
            return;
        }

        const diskArchive = this.getDiskArchive(fsPath);
        const filePath = this.getLocator(fsPath, diskArchive);
        runBridgeJson<{ success: boolean }>(
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

    rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean }): void {
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
        runBridgeJson<{ success: boolean }>(
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
    console.log('TOTK Editor is now active!');

    registerSyntaxColorSync(context);
    registerDocumentLanguageModes(context);
    context.subscriptions.push(AinbNodeEditorProvider.register(context));

    const bridgePath = path.join(context.extensionPath, 'python', 'totk_bridge.py');
    const getPython = () => getCachedPythonExecutable() ?? '';

    const sarcProvider = new SarcProvider(bridgePath, getPython);
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
        vscode.commands.registerCommand('totk-editor.openBntxTexture', (uri: vscode.Uri) => {
            const python = getPython();
            if (!python) {
                void vscode.window.showErrorMessage('Python not configured.');
                return;
            }
            try {
                const diskArchive = getDiskArchivePath(uri.fsPath);
                const filePath = getLocatorInsideDiskArchive(uri.fsPath, diskArchive);
                const raw = runBridgeRead(python, bridgePath, ['read', diskArchive, filePath], getBridgeEnv());
                if (isBntxTextureResult(raw)) {
                    const texName = raw.metadata?.name ?? filePath.split('/').pop() ?? 'texture';
                    openTextureViewer(texName, raw);
                } else {
                    void vscode.window.showErrorMessage('Failed to load BNTX texture.');
                }
            } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                void vscode.window.showErrorMessage(`BNTX texture error: ${msg}`);
            }
        }),
    );

    const totkDiskProvider = new TotkDiskFileSystemProvider(bridgePath, getPython, getBridgeEnv);
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
        } else {
            await promptPythonSetup(context);
        }
    });
    context.subscriptions.push(
        setupPython,
        vscode.commands.registerCommand('totk-editor.pickPython', () => pickDetectedPython(context)),
        vscode.commands.registerCommand('totk-editor.browsePython', () => browseForPython(context)),
    );

    const python = await ensurePythonEnvironment(context);
    if (!python) {
        await promptPythonSetup(context);
    }

    await migrateOffStandaloneIconTheme(context);
    registerIconThemeCommands(context);

    const archiveTree = registerArchiveTree(context);
    registerGameDumpTree(context, archiveTree);
    await migrateSarcWorkspaceFolders(archiveTree);

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
                'TOTK Archives': ['pack', 'sarc', 'genvb', 'blarc', 'bntx', 'zs'],
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
