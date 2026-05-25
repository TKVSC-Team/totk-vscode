import * as path from 'path';
import * as vscode from 'vscode';
import { isPathInsideArchive } from './archives';
import { toSarcUri, type ArchiveTreeItem } from './archiveTree';

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

function isDiskMutableItem(item: ArchiveTreeItem): boolean {
    return (
        item.contextValue === 'archiveFile' ||
        item.contextValue === 'archivePackage' ||
        item.contextValue === 'archiveDir' ||
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

    if (target.contextValue === 'archiveFile' || target.contextValue === 'archivePackage') {
        return parentDirectoryUri(target.resourceUri);
    }

    if (
        target.contextValue === 'archiveDir' ||
        target.contextValue === 'archiveRoot' ||
        target.contextValue === 'archiveVirtualDir'
    ) {
        if (target.contextValue === 'archiveVirtualDir') {
            void vscode.window.showWarningMessage(
                'Cannot create files inside an archive. Create on disk beside the archive file instead.',
            );
            return undefined;
        }
        return target.resourceUri;
    }

    if (isPathInsideArchive(target.resourceUri.fsPath)) {
        void vscode.window.showWarningMessage('Cannot create files inside an archive from here.');
        return undefined;
    }

    return target.resourceUri;
}

async function copyEntries(
    sources: ArchiveTreeItem[],
    destinationFolder: vscode.Uri,
    move: boolean,
): Promise<void> {
    for (const source of sources) {
        if (!source.resourceUri || !isDiskMutableItem(source)) {
            continue;
        }
        const target = vscode.Uri.joinPath(destinationFolder, source.entryName);
        try {
            if (move) {
                await vscode.workspace.fs.rename(source.resourceUri, target, { overwrite: false });
            } else {
                const data = await vscode.workspace.fs.readFile(source.resourceUri);
                await vscode.workspace.fs.writeFile(target, data);
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`${source.entryName}: ${message}`);
        }
    }
}

export function registerArchiveFileCommands(context: vscode.ExtensionContext): void {
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
                    for (const entry of items) {
                        const exists = await vscode.workspace.fs.stat(entry.resourceUri).then(
                            () => true,
                            () => false,
                        );
                        if (!exists) {
                            continue;
                        }
                        const stat = await vscode.workspace.fs.stat(entry.resourceUri);
                        await vscode.workspace.fs.delete(entry.resourceUri, {
                            recursive: stat.type === vscode.FileType.Directory,
                            useTrash: false,
                        });
                    }
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
                const target = vscode.Uri.joinPath(parentDirectoryUri(entry.resourceUri), newName);
                try {
                    await vscode.workspace.fs.rename(entry.resourceUri, target, { overwrite: false });
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
                    await vscode.workspace.fs.writeFile(target, new Uint8Array());
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
            const items = selectedItems(item).filter(isDiskMutableItem);
            if (items.length === 0) {
                return;
            }
            await context.workspaceState.update(
                CLIPBOARD_KEY,
                items.map((entry) => ({ uri: entry.resourceUri.toString(), move: false })),
            );
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('totk-editor.archiveCut', async (item?: ArchiveTreeItem) => {
            const items = selectedItems(item).filter(isDiskMutableItem);
            if (items.length === 0) {
                return;
            }
            await context.workspaceState.update(
                CLIPBOARD_KEY,
                items.map((entry) => ({ uri: entry.resourceUri.toString(), move: true })),
            );
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('totk-editor.archivePaste', async (item?: ArchiveTreeItem) => {
            const clipboard = context.workspaceState.get<{ uri: string; move: boolean }[]>(
                CLIPBOARD_KEY,
                [],
            );
            if (clipboard.length === 0) {
                return;
            }
            const folderUri = await resolveTargetFolder(item);
            if (!folderUri) {
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
            try {
                await copyEntries(sources, folderUri, clipboard[0]!.move);
                if (clipboard[0]!.move) {
                    await context.workspaceState.update(CLIPBOARD_KEY, []);
                }
                refreshArchives();
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                void vscode.window.showErrorMessage(`Paste failed: ${message}`);
            }
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
            await copyEntries(sources, folderUri, true);
            refreshArchives();
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            void vscode.window.showErrorMessage(`Move failed: ${message}`);
        }
    }
}
