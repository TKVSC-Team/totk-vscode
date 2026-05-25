import * as path from 'path';
import * as vscode from 'vscode';
import { addDumpEntryToProject, pickProjectRoot } from './addToProject';
import { isArchiveFile } from './archives';
import type { ArchiveTreeProvider } from './archiveTree';
import { resolveRomfsPath } from './romfs';

export const DUMP_SCHEME = 'totk-dump';

export function toDumpUri(fileUri: vscode.Uri): vscode.Uri {
    return fileUri.with({ scheme: DUMP_SCHEME });
}

export class DumpTreeItem extends vscode.TreeItem {
    constructor(
        public readonly entryName: string,
        public readonly resourceUri: vscode.Uri,
        collapsibleState: vscode.TreeItemCollapsibleState,
        contextValue: string,
    ) {
        super(entryName, collapsibleState);
        this.resourceUri = resourceUri;
        this.contextValue = contextValue;

        if (collapsibleState === vscode.TreeItemCollapsibleState.None) {
            this.command = {
                command: 'vscode.open',
                title: 'Open',
                arguments: [resourceUri, { preview: true }],
            };
        }

        if (isArchiveFile(entryName)) {
            this.iconPath = new vscode.ThemeIcon('package');
        } else if (contextValue === 'dumpDir') {
            this.iconPath = new vscode.ThemeIcon('folder');
        }
    }
}

export class GameDumpTreeProvider implements vscode.TreeDataProvider<DumpTreeItem> {
    private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<DumpTreeItem | undefined>();
    readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

    refresh(): void {
        this.onDidChangeTreeDataEmitter.fire(undefined);
    }

    getTreeItem(element: DumpTreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: DumpTreeItem): Promise<DumpTreeItem[]> {
        const romfsPath = resolveRomfsPath();
        if (!romfsPath) {
            return [];
        }

        const parentUri = element?.resourceUri ?? toDumpUri(vscode.Uri.file(romfsPath));

        try {
            const entries = await vscode.workspace.fs.readDirectory(parentUri);
            return entries
                .sort(([a], [b]) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
                .map(([name, fileType]) => {
                    const childUri = vscode.Uri.joinPath(parentUri, name);
                    const isDirectory = fileType === vscode.FileType.Directory;
                    const contextValue = contextValueForEntry(
                        name,
                        isDirectory,
                        childUri.fsPath,
                        romfsPath,
                    );
                    return new DumpTreeItem(
                        name,
                        childUri,
                        isDirectory
                            ? vscode.TreeItemCollapsibleState.Collapsed
                            : vscode.TreeItemCollapsibleState.None,
                        contextValue,
                    );
                });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            void vscode.window.showErrorMessage(`Game Dump: ${message}`);
            return [];
        }
    }
}

function contextValueForEntry(
    name: string,
    isDirectory: boolean,
    fsPath: string,
    romfsPath: string,
): string {
    if (!isDirectory) {
        return 'dumpFile';
    }
    if (isArchiveFile(name)) {
        return 'dumpArchive';
    }
    if (path.normalize(fsPath) === path.normalize(romfsPath)) {
        return 'dumpRoot';
    }
    return 'dumpDir';
}

export async function focusGameDumpSidebar(): Promise<void> {
    await vscode.commands.executeCommand('workbench.view.extension.totk-editor-dump');
    await vscode.commands.executeCommand('totk-editor.gameDump.focus');
}

export function registerGameDumpTree(
    context: vscode.ExtensionContext,
    archiveTree: ArchiveTreeProvider,
): GameDumpTreeProvider {
    const provider = new GameDumpTreeProvider();

    const treeView = vscode.window.createTreeView('totk-editor.gameDump', {
        treeDataProvider: provider,
        showCollapseAll: true,
        canSelectMany: true,
    });
    context.subscriptions.push(treeView);

    const selectedItems = (item?: DumpTreeItem): DumpTreeItem[] => {
        if (!item) {
            return [...treeView.selection];
        }
        const selected = treeView.selection;
        const inSelection = selected.some(
            (selectedItem) =>
                selectedItem.resourceUri.toString() === item.resourceUri.toString(),
        );
        return inSelection ? [...selected] : [item];
    };

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration('totk-editor.romfsPath')) {
                provider.refresh();
            }
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('totk-editor.refreshGameDump', () => {
            provider.refresh();
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('totk-editor.openRomfsSettings', async () => {
            await vscode.commands.executeCommand(
                'workbench.action.openSettings',
                'totk-editor.romfsPath',
            );
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(
            'totk-editor.addDumpToProject',
            async (item: DumpTreeItem | undefined) => {
                const entries = selectedItems(item).filter(
                    (entry) =>
                        entry.contextValue === 'dumpFile' || entry.contextValue === 'dumpArchive',
                );
                if (entries.length === 0) {
                    void vscode.window.showWarningMessage(
                        'Select one or more files in TotK Dump first.',
                    );
                    return;
                }

                const projects = archiveTree.getProjectRoots();
                const projectRoot = await pickProjectRoot(projects);
                if (!projectRoot) {
                    return;
                }

                let copiedCount = 0;
                for (const entry of entries) {
                    const copied = await addDumpEntryToProject(
                        entry.resourceUri.fsPath,
                        projectRoot,
                        undefined,
                        { suppressSuccessMessage: entries.length > 1 },
                    );
                    if (copied) {
                        copiedCount++;
                    }
                }

                if (copiedCount > 0) {
                    if (entries.length > 1) {
                        void vscode.window.showInformationMessage(
                            `Added ${copiedCount}/${entries.length} selected items to project.`,
                        );
                    }
                    archiveTree.refresh();
                }
            },
        ),
    );

    return provider;
}
