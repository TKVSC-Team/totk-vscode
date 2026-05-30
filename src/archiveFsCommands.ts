import * as path from 'path';
import * as vscode from 'vscode';
import { toSarcUri, type ArchiveTreeItem } from './archiveTree';
import { isAampExtension } from './aampExtensions';
import { isPathInsideArchive, isArchiveFile, getDiskArchivePath, isArchiveFileName } from './archives';
import { getDumpSelection, type DumpTreeItem } from './dumpTree';
import { resolveRomfsPath } from './romfs';

let archiveTreeView: vscode.TreeView<ArchiveTreeItem> | undefined;

const CLIPBOARD_KEY = 'totk-editor.archiveClipboard';

export function setArchiveTreeView(view: vscode.TreeView<ArchiveTreeItem>): void {
    archiveTreeView = view;
}

export function getArchiveSelection(): ArchiveTreeItem[] {
    return [...(archiveTreeView?.selection ?? [])];
}

function parentDirectoryUri(uri: vscode.Uri): vscode.Uri {
    return toSarcUri(vscode.Uri.file(path.dirname(uri.fsPath)));
}

function refreshArchives(): void {
    void vscode.commands.executeCommand('totk-editor.refreshArchives');
}

function selectedItems(item?: ArchiveTreeItem): ArchiveTreeItem[] {
    if (item?.resourceUri) {
        const selected = getArchiveSelection();
        const clickedInSelection = selected.some(
            (selectedItem) =>
                selectedItem.resourceUri.toString() === item.resourceUri.toString(),
        );
        if (clickedInSelection) {
            return selected;
        }
        return [item];
    }
    return getArchiveSelection();
}

function isMsbtFileName(name: string): boolean {
    return /\.msbt(\.zs)?$/i.test(name);
}

function isBymlFileName(name: string): boolean {
    return /\.(byml|bgyml)(\.zs)?$/i.test(name);
}

type TemplatePromptConfig = {
    kindLabel: string;
    filters: Record<string, string[]>;
};

function templatePromptConfigForName(name: string): TemplatePromptConfig | undefined {
    if (isMsbtFileName(name)) {
        return {
            kindLabel: 'MSBT',
            filters: { MSBT: ['msbt', 'zs'], All: ['*'] },
        };
    }
    if (isBymlFileName(name)) {
        return {
            kindLabel: 'BYML',
            filters: { BYML: ['byml', 'bgyml', 'zs'], All: ['*'] },
        };
    }
    if (isAampExtension(name)) {
        return {
            kindLabel: 'AAMP',
            filters: { AAMP: ['zs'], All: ['*'] },
        };
    }
    if (isArchiveFileName(name)) {
        const extMatch = name.match(/\.([a-z0-9]+)(\.zs)?$/i);
        const primaryExt = extMatch ? extMatch[1]!.toLowerCase() : 'sarc';
        const label = primaryExt.toUpperCase();
        return {
            kindLabel: label,
            filters: { [label]: [primaryExt, 'zs'], All: ['*'] },
        };
    }
    return undefined;
}

async function initialContentForNewFile(name: string): Promise<Uint8Array | undefined> {
    const promptConfig = templatePromptConfigForName(name);
    if (!promptConfig) {
        return new Uint8Array();
    }

    const isSarc = isArchiveFileName(name);
    const choices: vscode.QuickPickItem[] = [
        {
            label: `Use existing ${promptConfig.kindLabel} as template...`,
            description: `Recommended: creates a valid ${promptConfig.kindLabel} file immediately`,
        },
    ];

    if (!isSarc) {
        choices.push({
            label: 'Create empty file',
            description:
                promptConfig.kindLabel === 'MSBT'
                    ? 'MSBT may not be writable until replaced with a valid template'
                    : 'Creates an empty file and lets converter build from text on first save',
        });
    }

    const choice = await vscode.window.showQuickPick(
        choices,
        {
            title: `New ${promptConfig.kindLabel} file`,
            placeHolder: `Choose how to initialize this ${promptConfig.kindLabel}`,
        },
    );

    if (!choice) {
        return undefined;
    }

    if (choice.label === 'Create empty file') {
        return new Uint8Array();
    }

    const romfsPath = resolveRomfsPath();
    const defaultUri = romfsPath ? vscode.Uri.file(romfsPath) : undefined;

    const picked = await vscode.window.showOpenDialog({
        canSelectMany: false,
        canSelectFiles: true,
        canSelectFolders: false,
        title: `Pick ${promptConfig.kindLabel} template file`,
        filters: promptConfig.filters,
        defaultUri,
    });
    if (!picked?.[0]) {
        return undefined;
    }

    return await vscode.workspace.fs.readFile(picked[0]);
}

function isDiskMutableItem(item: ArchiveTreeItem): boolean {
    return (
        item.contextValue === 'archiveFile' ||
        item.contextValue === 'archiveVirtualFile' ||
        item.contextValue === 'archivePackage' ||
        item.contextValue === 'archiveDir' ||
        item.contextValue === 'archiveVirtualDir' ||
        item.contextValue === 'archiveRoot'
    );
}

function normalizeFsPath(fsPath: string): string {
    return fsPath.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function pruneNestedSelections(items: ArchiveTreeItem[]): ArchiveTreeItem[] {
    const sorted = [...items].sort(
        (a, b) => normalizeFsPath(a.resourceUri.fsPath).length - normalizeFsPath(b.resourceUri.fsPath).length,
    );
    const kept: ArchiveTreeItem[] = [];

    for (const candidate of sorted) {
        const candidatePath = normalizeFsPath(candidate.resourceUri.fsPath);
        const isInsideKept = kept.some((entry) => {
            const parentPath = normalizeFsPath(entry.resourceUri.fsPath);
            return candidatePath === parentPath || candidatePath.startsWith(`${parentPath}/`);
        });
        if (!isInsideKept) {
            kept.push(candidate);
        }
    }

    return kept;
}

async function resolveTargetFolder(item?: ArchiveTreeItem): Promise<vscode.Uri | undefined> {
    const items = selectedItems(item);
    const target = items[0];
    if (!target?.resourceUri) {
        void vscode.window.showWarningMessage('Select a folder in TOTK Archives first.');
        return undefined;
    }

    if (
        target.contextValue === 'archiveFile' ||
        target.contextValue === 'archiveVirtualFile' ||
        target.contextValue === 'archivePackage'
    ) {
        return parentDirectoryUri(target.resourceUri);
    }

    if (
        target.contextValue === 'archiveDir' ||
        target.contextValue === 'archiveRoot' ||
        target.contextValue === 'archiveVirtualDir'
    ) {
        return target.resourceUri;
    }

    return target.resourceUri;
}

function toFileUri(uri: vscode.Uri): vscode.Uri {
    if (uri.scheme === 'sarc') {
        return vscode.Uri.file(uri.fsPath);
    }
    return uri;
}

async function getUniqueTargetUri(folderUri: vscode.Uri, name: string): Promise<vscode.Uri> {
    let target = vscode.Uri.joinPath(folderUri, name);
    let exists = await vscode.workspace.fs.stat(target).then(
        () => true,
        () => false,
    );
    if (!exists) {
        return target;
    }

    let base = name;
    let ext = '';
    const compoundMatch = name.match(/^(.+?)(\.(?:pack|sarc|genvb|blarc|bfarc|bntx|byml|bgyml|msbt|txtg)(?:\.zs)?)$/i);
    if (compoundMatch) {
        base = compoundMatch[1]!;
        ext = compoundMatch[2]!;
    } else {
        const lastDot = name.lastIndexOf('.');
        if (lastDot > 0) {
            base = name.substring(0, lastDot);
            ext = name.substring(lastDot);
        }
    }

    let counter = 1;
    while (true) {
        const newName = `${base}_${counter}${ext}`;
        target = vscode.Uri.joinPath(folderUri, newName);
        exists = await vscode.workspace.fs.stat(target).then(
            () => true,
            () => false,
        );
        if (!exists) {
            return target;
        }
        counter++;
    }
}

async function parallelMap<T, R>(items: T[], fn: (item: T) => Promise<R>, limit = 10): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let index = 0;
    const workers = Array(limit).fill(0).map(async () => {
        while (index < items.length) {
            const i = index++;
            results[i] = await fn(items[i]);
        }
    });
    await Promise.all(workers);
    return results;
}

async function moveEntry(src: vscode.Uri, dest: vscode.Uri): Promise<void> {
    const isSrcVirtual = isPathInsideArchive(src.fsPath);
    const isDestVirtual = isPathInsideArchive(dest.fsPath);
    const isCrossScheme = src.scheme !== dest.scheme;
    const isCrossArchive =
        isSrcVirtual ||
        isDestVirtual ||
        isCrossScheme ||
        getDiskArchivePath(src.fsPath).toLowerCase() !== getDiskArchivePath(dest.fsPath).toLowerCase();

    if (!isCrossArchive) {
        await vscode.workspace.fs.rename(src, dest, { overwrite: false });
    } else {
        const stat = await vscode.workspace.fs.stat(src);
        const isDirectory = stat.type === vscode.FileType.Directory && !isArchiveFile(src.fsPath);
        if (isDirectory) {
            await vscode.workspace.fs.createDirectory(dest);
            const dirEntries = await captureDirectory(src);
            const dirs = dirEntries.filter((e) => e.type === 'dir');
            const files = dirEntries.filter((e) => e.type === 'file');
            dirs.sort((a, b) => a.relativeUri.length - b.relativeUri.length);
            for (const entry of dirs) {
                const entryDestUri = vscode.Uri.joinPath(dest, entry.relativeUri);
                await vscode.workspace.fs.createDirectory(entryDestUri);
            }
            await parallelMap(files, async (entry) => {
                const entryDestUri = vscode.Uri.joinPath(dest, entry.relativeUri);
                await vscode.workspace.fs.writeFile(entryDestUri, entry.content!);
            });
        } else {
            const data = await vscode.workspace.fs.readFile(src);
            await vscode.workspace.fs.writeFile(dest, data);
        }
        await vscode.workspace.fs.delete(src, {
            recursive: isDirectory,
            useTrash: false,
        });
    }
}

async function copyEntries(
    sources: ArchiveTreeItem[],
    destinationFolder: vscode.Uri,
    move: boolean,
): Promise<vscode.Uri[]> {
    const targets: vscode.Uri[] = [];
    for (const source of sources) {
        if (!source.resourceUri || !isDiskMutableItem(source)) {
            continue;
        }
        const target = await getUniqueTargetUri(destinationFolder, source.entryName);
        targets.push(target);
        try {
            if (move) {
                await moveEntry(source.resourceUri, target);
            } else {
                const isSrcVirtual = isPathInsideArchive(source.resourceUri.fsPath);
                const isDestVirtual = isPathInsideArchive(target.fsPath);
                const isCrossScheme = source.resourceUri.scheme !== target.scheme;
                if (!isSrcVirtual && !isDestVirtual && !isCrossScheme) {
                    await vscode.workspace.fs.copy(
                        toFileUri(source.resourceUri),
                        toFileUri(target),
                        { overwrite: false },
                    );
                } else {
                    const stat = await vscode.workspace.fs.stat(source.resourceUri);
                    const isDirectory = stat.type === vscode.FileType.Directory && !isArchiveFile(source.resourceUri.fsPath);
                    if (isDirectory) {
                        await vscode.workspace.fs.createDirectory(target);
                        const dirEntries = await captureDirectory(source.resourceUri);
                        const dirs = dirEntries.filter((e) => e.type === 'dir');
                        const files = dirEntries.filter((e) => e.type === 'file');
                        dirs.sort((a, b) => a.relativeUri.length - b.relativeUri.length);
                        for (const entry of dirs) {
                            const entryDestUri = vscode.Uri.joinPath(target, entry.relativeUri);
                            await vscode.workspace.fs.createDirectory(entryDestUri);
                        }
                        await parallelMap(files, async (entry) => {
                            const entryDestUri = vscode.Uri.joinPath(target, entry.relativeUri);
                            await vscode.workspace.fs.writeFile(entryDestUri, entry.content!);
                        });
                    } else {
                        const data = await vscode.workspace.fs.readFile(source.resourceUri);
                        await vscode.workspace.fs.writeFile(target, data);
                    }
                }
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`${source.entryName}: ${message}`);
        }
    }
    return targets;
}

interface CapturedEntry {
    type: 'file' | 'dir';
    relativeUri: string;
    content?: Uint8Array;
}

interface DeletedItemBackup {
    uri: vscode.Uri;
    type: 'file' | 'dir';
    fileContent?: Uint8Array;
    dirEntries?: CapturedEntry[];
}

interface HistoryEntry {
    description: string;
    undo: () => Promise<void>;
    redo: () => Promise<void>;
}

async function captureDirectory(dirUri: vscode.Uri): Promise<CapturedEntry[]> {
    const results: CapturedEntry[] = [];
    async function traverse(currentUri: vscode.Uri, relativeParts: string[]) {
        const entries = await vscode.workspace.fs.readDirectory(currentUri);
        for (const [name, fileType] of entries) {
            const childUri = vscode.Uri.joinPath(currentUri, name);
            const childRelativeParts = [...relativeParts, name];
            const relativePath = childRelativeParts.join('/');
            const isDir = fileType === vscode.FileType.Directory && !isArchiveFile(name);
            if (isDir) {
                results.push({ type: 'dir', relativeUri: relativePath });
                await traverse(childUri, childRelativeParts);
            } else {
                const content = await vscode.workspace.fs.readFile(childUri);
                results.push({ type: 'file', relativeUri: relativePath, content });
            }
        }
    }
    await traverse(dirUri, []);
    return results;
}

async function createBackups(items: ArchiveTreeItem[]): Promise<DeletedItemBackup[]> {
    const backups: DeletedItemBackup[] = [];
    await parallelMap(items, async (item) => {
        if (!item.resourceUri) {
            return;
        }
        const isVirtual = isPathInsideArchive(item.resourceUri.fsPath);
        const resolvedUri = isVirtual ? item.resourceUri : toFileUri(item.resourceUri);
        try {
            const stat = await vscode.workspace.fs.stat(resolvedUri);
            const isDirectory = stat.type === vscode.FileType.Directory && !isArchiveFile(resolvedUri.fsPath);
            if (isDirectory) {
                const dirEntries = await captureDirectory(resolvedUri);
                backups.push({
                    uri: resolvedUri,
                    type: 'dir',
                    dirEntries,
                });
            } else {
                const fileContent = await vscode.workspace.fs.readFile(resolvedUri);
                backups.push({
                    uri: resolvedUri,
                    type: 'file',
                    fileContent,
                });
            }
        } catch (err) {
            console.error('Failed to create backup for ' + resolvedUri.toString(), err);
        }
    });
    return backups;
}

async function restoreBackups(backups: DeletedItemBackup[]): Promise<void> {
    await parallelMap(backups, async (backup) => {
        if (backup.type === 'file') {
            await vscode.workspace.fs.writeFile(backup.uri, backup.fileContent!);
        } else {
            await vscode.workspace.fs.createDirectory(backup.uri);
            if (backup.dirEntries) {
                const dirs = backup.dirEntries.filter((e) => e.type === 'dir');
                const files = backup.dirEntries.filter((e) => e.type === 'file');
                dirs.sort((a, b) => a.relativeUri.length - b.relativeUri.length);
                for (const entry of dirs) {
                    const entryUri = vscode.Uri.joinPath(backup.uri, entry.relativeUri);
                    await vscode.workspace.fs.createDirectory(entryUri);
                }
                await parallelMap(files, async (entry) => {
                    const entryUri = vscode.Uri.joinPath(backup.uri, entry.relativeUri);
                    await vscode.workspace.fs.writeFile(entryUri, entry.content!);
                });
            }
        }
    });
}

async function deleteBackups(backups: DeletedItemBackup[]): Promise<void> {
    await parallelMap(backups, async (backup) => {
        try {
            const stat = await vscode.workspace.fs.stat(backup.uri);
            const isDirectory = stat.type === vscode.FileType.Directory && !isArchiveFile(backup.uri.fsPath);
            await vscode.workspace.fs.delete(backup.uri, {
                recursive: isDirectory,
                useTrash: false,
            });
        } catch {
            // Already deleted or not found
        }
    });
}

class ArchiveHistoryManager {
    private undoStack: HistoryEntry[] = [];
    private redoStack: HistoryEntry[] = [];

    push(entry: HistoryEntry) {
        this.undoStack.push(entry);
        this.redoStack = [];
    }

    async undo() {
        const entry = this.undoStack.pop();
        if (!entry) {
            void vscode.window.showInformationMessage('Nothing to undo');
            return;
        }
        try {
            await entry.undo();
            this.redoStack.push(entry);
            void vscode.window.showInformationMessage(`Undid: ${entry.description}`);
            refreshArchives();
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            void vscode.window.showErrorMessage(`Undo failed: ${message}`);
            this.undoStack.push(entry);
        }
    }

    async redo() {
        const entry = this.redoStack.pop();
        if (!entry) {
            void vscode.window.showInformationMessage('Nothing to redo');
            return;
        }
        try {
            await entry.redo();
            this.undoStack.push(entry);
            void vscode.window.showInformationMessage(`Redid: ${entry.description}`);
            refreshArchives();
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            void vscode.window.showErrorMessage(`Redo failed: ${message}`);
            this.redoStack.push(entry);
        }
    }
}

const historyManager = new ArchiveHistoryManager();

export function registerArchiveFileCommands(context: vscode.ExtensionContext): void {
    const initialClipboard = context.workspaceState.get<{ uri: string; move: boolean }[]>(CLIPBOARD_KEY, []);
    void vscode.commands.executeCommand(
        'setContext',
        'totk-editor.archiveClipboardNotEmpty',
        initialClipboard.length > 0,
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(
            'totk-editor.archiveDelete',
            async (item?: ArchiveTreeItem) => {
                const items = pruneNestedSelections(selectedItems(item).filter(isDiskMutableItem));
                if (items.length === 0) {
                    return;
                }
                const label =
                    items.length === 1
                        ? items[0]!.entryName
                        : `${items.length} selected items`;
                const confirm = await vscode.window.showWarningMessage(
                    `Delete ${label}?`,
                    { modal: true },
                    'Delete',
                );
                if (confirm !== 'Delete') {
                    return;
                }
                try {
                    const backups = await createBackups(items);
                    await parallelMap(items, async (entry) => {
                        const exists = await vscode.workspace.fs.stat(entry.resourceUri).then(
                            () => true,
                            () => false,
                        );
                        if (!exists) {
                            return;
                        }
                        const stat = await vscode.workspace.fs.stat(entry.resourceUri);
                        const isDirectory = stat.type === vscode.FileType.Directory && !isArchiveFile(entry.resourceUri.fsPath);
                        await vscode.workspace.fs.delete(entry.resourceUri, {
                            recursive: isDirectory,
                            useTrash: false,
                        });
                    });
                    historyManager.push({
                        description: `Delete ${label}`,
                        undo: async () => {
                            await restoreBackups(backups);
                        },
                        redo: async () => {
                            await deleteBackups(backups);
                        },
                    });
                    refreshArchives();
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    void vscode.window.showErrorMessage(`Delete failed: ${message}`);
                }
            },
        ),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(
            'totk-editor.archiveRename',
            async (item?: ArchiveTreeItem) => {
                const entry = selectedItems(item)[0];
                if (!entry?.resourceUri || !isDiskMutableItem(entry)) {
                    return;
                }
                const newName = await vscode.window.showInputBox({
                    prompt: 'New name',
                    value: entry.entryName,
                    validateInput: (value) =>
                        value.trim() ? undefined : 'Name cannot be empty',
                });
                if (!newName || newName === entry.entryName) {
                    return;
                }
                const sourceUri = entry.resourceUri;
                const target = vscode.Uri.joinPath(parentDirectoryUri(sourceUri), newName);
                try {
                    await vscode.workspace.fs.rename(sourceUri, target, { overwrite: false });
                    historyManager.push({
                        description: `Rename ${entry.entryName} to ${newName}`,
                        undo: async () => {
                            await vscode.workspace.fs.rename(target, sourceUri, { overwrite: false });
                        },
                        redo: async () => {
                            await vscode.workspace.fs.rename(sourceUri, target, { overwrite: false });
                        },
                    });
                    refreshArchives();
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    void vscode.window.showErrorMessage(`Rename failed: ${message}`);
                }
            },
        ),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(
            'totk-editor.archiveNewFile',
            async (item?: ArchiveTreeItem) => {
                const folderUri = await resolveTargetFolder(item);
                if (!folderUri) {
                    return;
                }
                const name = await vscode.window.showInputBox({
                    prompt: 'New file name',
                    validateInput: (value) =>
                        value.trim() ? undefined : 'Name cannot be empty',
                });
                if (!name) {
                    return;
                }
                const target = vscode.Uri.joinPath(folderUri, name);
                try {
                    const initial = await initialContentForNewFile(name);
                    if (initial === undefined) {
                        return;
                    }
                    await vscode.workspace.fs.writeFile(target, initial);
                    historyManager.push({
                        description: `Create file ${name}`,
                        undo: async () => {
                            await vscode.workspace.fs.delete(target, { recursive: false, useTrash: false });
                        },
                        redo: async () => {
                            await vscode.workspace.fs.writeFile(target, initial);
                        },
                    });
                    refreshArchives();
                    await vscode.window.showTextDocument(target);
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    void vscode.window.showErrorMessage(`Create file failed: ${message}`);
                }
            },
        ),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(
            'totk-editor.archiveNewFolder',
            async (item?: ArchiveTreeItem) => {
                const folderUri = await resolveTargetFolder(item);
                if (!folderUri) {
                    return;
                }
                const name = await vscode.window.showInputBox({
                    prompt: 'New folder name',
                    validateInput: (value) =>
                        value.trim() ? undefined : 'Name cannot be empty',
                });
                if (!name) {
                    return;
                }
                const target = vscode.Uri.joinPath(folderUri, name);
                try {
                    await vscode.workspace.fs.createDirectory(target);
                    historyManager.push({
                        description: `Create folder ${name}`,
                        undo: async () => {
                            await vscode.workspace.fs.delete(target, { recursive: true, useTrash: false });
                        },
                        redo: async () => {
                            await vscode.workspace.fs.createDirectory(target);
                        },
                    });
                    refreshArchives();
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    void vscode.window.showErrorMessage(`Create folder failed: ${message}`);
                }
            },
        ),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('totk-editor.archiveCopy', async (item?: ArchiveTreeItem) => {
            let items: (ArchiveTreeItem | DumpTreeItem)[] = [];
            if (item) {
                items = [item];
            } else {
                const archiveSel = getArchiveSelection();
                if (archiveSel.length > 0) {
                    items = archiveSel;
                } else {
                    items = getDumpSelection();
                }
            }
            const validItems = items.filter((entry) => entry && entry.resourceUri);
            if (validItems.length === 0) {
                return;
            }
            await context.workspaceState.update(
                CLIPBOARD_KEY,
                validItems.map((entry) => ({ uri: entry.resourceUri.toString(), move: false })),
            );
            await vscode.commands.executeCommand('setContext', 'totk-editor.archiveClipboardNotEmpty', true);
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('totk-editor.archiveCut', async (item?: ArchiveTreeItem) => {
            let items: ArchiveTreeItem[] = [];
            if (item) {
                items = [item];
            } else {
                items = getArchiveSelection();
            }
            const mutableItems = items.filter(isDiskMutableItem);
            if (mutableItems.length === 0) {
                return;
            }
            await context.workspaceState.update(
                CLIPBOARD_KEY,
                mutableItems.map((entry) => ({ uri: entry.resourceUri.toString(), move: true })),
            );
            await vscode.commands.executeCommand('setContext', 'totk-editor.archiveClipboardNotEmpty', true);
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('totk-editor.archivePaste', async (item?: any) => {
            const clipboard = context.workspaceState.get<{ uri: string; move: boolean }[]>(
                CLIPBOARD_KEY,
                [],
            );
            if (clipboard.length === 0) {
                return;
            }
            let folderUri: vscode.Uri | undefined;
            if (item instanceof vscode.Uri) {
                const stat = await vscode.workspace.fs.stat(item);
                const isDirectory = stat.type === vscode.FileType.Directory && !isArchiveFile(item.fsPath);
                if (isDirectory) {
                    folderUri = item;
                } else {
                    folderUri = vscode.Uri.file(path.dirname(item.fsPath));
                }
            } else {
                folderUri = await resolveTargetFolder(item);
            }

            if (!folderUri) {
                const activeEditor = vscode.window.activeTextEditor;
                if (activeEditor && activeEditor.document.uri.scheme === 'file') {
                    folderUri = vscode.Uri.file(path.dirname(activeEditor.document.uri.fsPath));
                } else if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
                    folderUri = vscode.workspace.workspaceFolders[0].uri;
                }
            }

            if (!folderUri) {
                void vscode.window.showWarningMessage('No destination directory selected to paste.');
                return;
            }

            const sources = clipboard.map((entry) => {
                const uri = vscode.Uri.parse(entry.uri);
                const name = path.basename(uri.fsPath);
                return {
                    resourceUri: uri,
                    entryName: name,
                    contextValue: 'archiveFile',
                } as ArchiveTreeItem;
            });
            const isMove = clipboard[0]!.move;
            try {
                if (isMove) {
                    const targets = await copyEntries(sources, folderUri, true);
                    const moves = sources.map((source, index) => ({
                        src: source.resourceUri,
                        dest: targets[index]!,
                    }));
                    historyManager.push({
                        description: `Move ${sources.length === 1 ? sources[0]!.entryName : `${sources.length} items`}`,
                        undo: async () => {
                            await parallelMap(moves, async (move) => {
                                await moveEntry(move.dest, move.src);
                            });
                        },
                        redo: async () => {
                            await parallelMap(moves, async (move) => {
                                await moveEntry(move.src, move.dest);
                            });
                        },
                    });
                    await context.workspaceState.update(CLIPBOARD_KEY, []);
                    await vscode.commands.executeCommand('setContext', 'totk-editor.archiveClipboardNotEmpty', false);
                } else {
                    const targets = await copyEntries(sources, folderUri, false);
                    const treeTargets = targets.map((target) => ({
                        uri: target,
                        resourceUri: target,
                        entryName: path.basename(target.fsPath),
                    } as ArchiveTreeItem));
                    const backups = await createBackups(treeTargets);
                    historyManager.push({
                        description: `Copy ${sources.length === 1 ? sources[0]!.entryName : `${sources.length} items`}`,
                        undo: async () => {
                            await deleteBackups(backups);
                        },
                        redo: async () => {
                            await restoreBackups(backups);
                        },
                    });
                }
                refreshArchives();
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                void vscode.window.showErrorMessage(`Paste failed: ${message}`);
            }
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('totk-editor.archiveUndo', async () => {
            await historyManager.undo();
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('totk-editor.archiveRedo', async () => {
            await historyManager.redo();
        }),
    );
}

export class ArchiveTreeDragDrop
    implements vscode.TreeDragAndDropController<ArchiveTreeItem>
{
    readonly dropMimeTypes = ['application/vnd.code.tree.totk-archives'];
    readonly dragMimeTypes = ['application/vnd.code.tree.totk-archives'];

    async handleDrag(
        source: readonly ArchiveTreeItem[],
        dataTransfer: vscode.DataTransfer,
        _token: vscode.CancellationToken,
    ): Promise<void> {
        const movable = source.filter(isDiskMutableItem);
        if (movable.length === 0) {
            return;
        }
        dataTransfer.set(
            'application/vnd.code.tree.totk-archives',
            new vscode.DataTransferItem(movable.map((item) => item.resourceUri.toString())),
        );
    }

    async handleDrop(
        _target: ArchiveTreeItem | undefined,
        dataTransfer: vscode.DataTransfer,
        _token: vscode.CancellationToken,
    ): Promise<void> {
        const folderUri = await resolveTargetFolder(_target);
        if (!folderUri) {
            return;
        }
        const transfer = dataTransfer.get('application/vnd.code.tree.totk-archives');
        if (!transfer) {
            return;
        }
        const uris = transfer.value as string[];
        const sources = uris.map((uriString) => {
            const uri = vscode.Uri.parse(uriString);
            return {
                resourceUri: uri,
                entryName: path.basename(uri.fsPath),
                contextValue: 'archiveFile',
            } as ArchiveTreeItem;
        });
        try {
            const targets = await copyEntries(sources, folderUri, true);
            const moves = sources.map((source, index) => ({
                src: source.resourceUri,
                dest: targets[index]!,
            }));
            historyManager.push({
                description: `Drag & Drop Move ${sources.length === 1 ? sources[0]!.entryName : `${sources.length} items`}`,
                undo: async () => {
                    await parallelMap(moves, async (move) => {
                        await moveEntry(move.dest, move.src);
                    });
                },
                redo: async () => {
                    await parallelMap(moves, async (move) => {
                        await moveEntry(move.src, move.dest);
                    });
                },
            });
            refreshArchives();
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            void vscode.window.showErrorMessage(`Move failed: ${message}`);
        }
    }
}
