import * as path from 'path';
import * as vscode from 'vscode';
import { isArchiveFile, isBntxTextureUri, isPathInsideArchive, isTxtgFile } from './archives';
import { registerArchiveFileCommands, ArchiveTreeDragDrop, setArchiveTreeView } from './archiveFsCommands';

const STORAGE_KEY = 'totk-editor.archiveRoots';

let extensionUri: vscode.Uri | undefined;

function isTkprojFile(name: string): boolean {
    return name.toLowerCase().endsWith('.tkproj');
}

function isTkvscFile(name: string): boolean {
    return name.toLowerCase() === '.tkvsc';
}

export function toSarcUri(fileUri: vscode.Uri): vscode.Uri {
    return fileUri.with({ scheme: 'sarc' });
}

export class ArchiveTreeItem extends vscode.TreeItem {
    constructor(
        public readonly entryName: string,
        public readonly resourceUri: vscode.Uri,
        collapsibleState: vscode.TreeItemCollapsibleState,
        options?: { isRoot?: boolean; contextValue?: string },
    ) {
        super(entryName, collapsibleState);
        this.resourceUri = resourceUri;
        this.id = resourceUri.toString();
        this.contextValue =
            options?.contextValue ?? (options?.isRoot ? 'archiveRoot' : undefined);
        if (options?.isRoot) {
            this.description = path.dirname(resourceUri.fsPath);
            this.tooltip = resourceUri.fsPath;
        } else if (collapsibleState === vscode.TreeItemCollapsibleState.None) {
            this.command = (isBntxTextureUri(resourceUri) || isTxtgFile(resourceUri.fsPath))
                ? { command: 'totk-editor.openBntxTexture', title: 'View Texture', arguments: [resourceUri] }
                : { command: 'vscode.open', title: 'Open', arguments: [resourceUri] };
        }
        if (isArchiveFile(entryName)) {
            this.iconPath = new vscode.ThemeIcon('package');
        } else if ((isBntxTextureUri(resourceUri) || isTxtgFile(resourceUri.fsPath)) && extensionUri) {
            this.iconPath = vscode.Uri.joinPath(extensionUri, 'icons', 'texture.svg');
        } else if (isTkprojFile(entryName) && extensionUri) {
            this.iconPath = vscode.Uri.joinPath(extensionUri, 'icons', 'tkproj.svg');
        } else if (isTkvscFile(entryName) && extensionUri) {
            this.iconPath = vscode.Uri.joinPath(extensionUri, 'icons', 'tkvsc.svg');
        }
    }
}

export class ArchiveTreeProvider implements vscode.TreeDataProvider<ArchiveTreeItem> {
    private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<ArchiveTreeItem | undefined>();
    readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;
    private readonly onDidChangeRootsEmitter = new vscode.EventEmitter<void>();
    readonly onDidChangeRoots = this.onDidChangeRootsEmitter.event;

    private roots: vscode.Uri[] = [];

    private sortRoots(): void {
        this.roots.sort((a, b) =>
            path.basename(a.fsPath).localeCompare(path.basename(b.fsPath), undefined, {
                sensitivity: 'base',
            }),
        );
    }

    constructor(private readonly context: vscode.ExtensionContext) {
        const stored = context.globalState.get<string[]>(STORAGE_KEY, []);
        this.roots = stored.map((fsPath) => toSarcUri(vscode.Uri.file(fsPath)));
        this.sortRoots();
    }

    getTreeItem(element: ArchiveTreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: ArchiveTreeItem): Promise<ArchiveTreeItem[]> {
        if (!element) {
            return this.roots.map(
                (root) =>
                    new ArchiveTreeItem(
                        path.basename(root.fsPath),
                        root,
                        vscode.TreeItemCollapsibleState.Collapsed,
                        { isRoot: true },
                    ),
            );
        }

        try {
            const entries = await vscode.workspace.fs.readDirectory(element.resourceUri);
            return entries
                .sort(compareEntriesFoldersFirstKeepingArchivesMixed)
                .map(([name, fileType]) => {
                    const childUri = vscode.Uri.joinPath(element.resourceUri, name);
                    const isDirectory = fileType === vscode.FileType.Directory || isArchiveFile(name);
                    return new ArchiveTreeItem(
                        name,
                        childUri,
                        isDirectory
                            ? vscode.TreeItemCollapsibleState.Collapsed
                            : vscode.TreeItemCollapsibleState.None,
                        { contextValue: archiveContextValue(name, isDirectory, childUri.fsPath) },
                    );
                });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            void vscode.window.showErrorMessage(`TOTK Archives: ${message}`);
            return [];
        }
    }

    private async ensureRomfsFolder(rootUri: vscode.Uri): Promise<void> {
        const createRomfs = vscode.workspace.getConfiguration('totk-editor').get<boolean>('createRomfsOnImport', true);
        if (!createRomfs) {
            return;
        }

        try {
            const fileUri = rootUri.scheme === 'sarc' ? vscode.Uri.file(rootUri.fsPath) : rootUri;
            const entries = await vscode.workspace.fs.readDirectory(fileUri);
            
            let hasTkproj = false;
            let hasRomfsOrExefs = false;

            for (const [name, type] of entries) {
                const lowerName = name.toLowerCase();
                if (lowerName.endsWith('.tkproj')) {
                    hasTkproj = true;
                }
                if (type === vscode.FileType.Directory && (lowerName === 'romfs' || lowerName === 'exefs')) {
                    hasRomfsOrExefs = true;
                }
            }

            if (hasTkproj && !hasRomfsOrExefs) {
                const romfsUri = vscode.Uri.joinPath(fileUri, 'romfs');
                await vscode.workspace.fs.createDirectory(romfsUri);
            }
        } catch (e) {
            console.error('Failed to ensure romfs folder:', e);
        }
    }

    addRoot(fileUri: vscode.Uri): void {
        const sarcUri = fileUri.scheme === 'sarc' ? fileUri : toSarcUri(fileUri);
        const key = sarcUri.fsPath;
        if (this.roots.some((root) => root.fsPath === key)) {
            return;
        }
        this.roots.push(sarcUri);
        this.sortRoots();
        void this.persistRoots();
        this.onDidChangeTreeDataEmitter.fire(undefined);
        this.onDidChangeRootsEmitter.fire();
        void this.ensureRomfsFolder(fileUri);
    }

    removeRoot(fileUri: vscode.Uri): void {
        const key = (fileUri.scheme === 'sarc' ? fileUri : toSarcUri(fileUri)).fsPath;
        const next = this.roots.filter((root) => root.fsPath !== key);
        if (next.length === this.roots.length) {
            return;
        }
        this.roots = next;
        void this.persistRoots();
        this.onDidChangeTreeDataEmitter.fire(undefined);
        this.onDidChangeRootsEmitter.fire();
    }

    refresh(): void {
        this.onDidChangeTreeDataEmitter.fire(undefined);
    }

    getProjectRoots(): { fsPath: string; label: string }[] {
        return this.roots.map((root) => ({
            fsPath: root.fsPath,
            label: path.basename(root.fsPath),
        }));
    }

    private async persistRoots(): Promise<void> {
        await this.context.globalState.update(
            STORAGE_KEY,
            this.roots.map((root) => root.fsPath),
        );
    }
}

function compareEntriesFoldersFirstKeepingArchivesMixed(
    [nameA, fileTypeA]: [string, vscode.FileType],
    [nameB, fileTypeB]: [string, vscode.FileType],
): number {
    const isNormalDirectoryA = fileTypeA === vscode.FileType.Directory && !isArchiveFile(nameA);
    const isNormalDirectoryB = fileTypeB === vscode.FileType.Directory && !isArchiveFile(nameB);

    if (isNormalDirectoryA !== isNormalDirectoryB) {
        return isNormalDirectoryA ? -1 : 1;
    }

    return nameA.localeCompare(nameB, undefined, { sensitivity: 'base' });
}

export async function focusArchiveSidebar(): Promise<void> {
    await vscode.commands.executeCommand('workbench.view.extension.totk-editor');
    await vscode.commands.executeCommand('totk-editor.archives.focus');
}

export function registerArchiveTree(context: vscode.ExtensionContext): ArchiveTreeProvider {
    extensionUri = context.extensionUri;
    const provider = new ArchiveTreeProvider(context);
    registerArchiveFileCommands(context);

    const treeView = vscode.window.createTreeView('totk-editor.archives', {
        treeDataProvider: provider,
        showCollapseAll: true,
        dragAndDropController: new ArchiveTreeDragDrop(),
        canSelectMany: true,
    });
    setArchiveTreeView(treeView);
    context.subscriptions.push(treeView);

    context.subscriptions.push(
        vscode.commands.registerCommand('totk-editor.refreshArchives', () => {
            provider.refresh();
        }),
    );

    const addWorkspaceToArchives = (): void => {
            const folder = vscode.workspace.workspaceFolders?.[0];
            if (!folder) {
                void vscode.window.showWarningMessage(
                    'TOTK Archives: Open a folder in the workspace first.',
                );
                return;
            }
            if (folder.uri.scheme !== 'file') {
                void vscode.window.showWarningMessage(
                    'TOTK Archives: Workspace is not a normal folder on disk.',
                );
                return;
            }
            provider.addRoot(folder.uri);
            void focusArchiveSidebar();
    };

    const addProjectFolders = async (): Promise<void> => {
        const uris = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: true,
            title: 'Select Projects to Add',
            openLabel: 'Add Projects'
        });
        if (uris && uris.length > 0) {
            for (const uri of uris) {
                provider.addRoot(uri);
            }
            void focusArchiveSidebar();
        }
    };

    context.subscriptions.push(
        vscode.commands.registerCommand('totk-editor.addWorkspaceToArchives', addWorkspaceToArchives),
        // Backwards-compat alias for an older mistyped command id.
        vscode.commands.registerCommand('totk-edit.addWorkspaceToArchives', addWorkspaceToArchives),
        vscode.commands.registerCommand('totk-editor.addProjectFolders', addProjectFolders),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(
            'totk-editor.removeArchiveRoot',
            (item: ArchiveTreeItem | undefined, selectedItems?: ArchiveTreeItem[]) => {
                const itemsToRemove = selectedItems && selectedItems.length > 0 ? selectedItems : (item ? [item] : []);
                for (const i of itemsToRemove) {
                    if (i.resourceUri) {
                        provider.removeRoot(i.resourceUri);
                    }
                }
            },
        ),
    );

    return provider;
}

function archiveContextValue(name: string, isDirectory: boolean, fsPath: string): string {
    if (isArchiveFile(name)) {
        return 'archivePackage';
    }
    if (!isDirectory) {
        return isPathInsideArchive(fsPath) ? 'archiveVirtualFile' : 'archiveFile';
    }
    return isPathInsideArchive(fsPath) ? 'archiveVirtualDir' : 'archiveDir';
}

/** Move legacy `sarc://` workspace folders back to `file://` and add them to the archive tree. */
export async function migrateSarcWorkspaceFolders(
    archiveTree: ArchiveTreeProvider,
): Promise<void> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) {
        return;
    }

    const toConvert: { index: number; uri: vscode.Uri; name: string }[] = [];

    for (let i = 0; i < folders.length; i++) {
        const folder = folders[i]!;
        if (folder.uri.scheme === 'sarc') {
            archiveTree.addRoot(vscode.Uri.file(folder.uri.fsPath));
            toConvert.push({
                index: i,
                uri: vscode.Uri.file(folder.uri.fsPath),
                name: folder.name,
            });
        }
    }

    if (toConvert.length === 0) {
        return;
    }

    for (let i = toConvert.length - 1; i >= 0; i--) {
        const entry = toConvert[i]!;
        await vscode.workspace.updateWorkspaceFolders(entry.index, 1, {
            uri: entry.uri,
            name: entry.name,
        });
    }

    void vscode.window.showInformationMessage(
        'TOTK Editor: Archive browsing moved to the **TOTK Archives** sidebar tab. Your workspace uses normal files again.',
    );
}
