import * as path from 'path';
import * as vscode from 'vscode';
import * as fs from 'fs';
import { addDumpEntryToProject, pickProjectRoot } from './addToProject';
import { isArchiveFile, isBntxTextureUri, isPathInsideArchive, isTxtgFile } from './archives';
import type { ArchiveTreeProvider } from './archiveTree';
import { resolveRomfsPath } from './romfs';
import { invalidateRomfsIndex, queryRomfsIndex } from './romfsIndex';
import { getActiveTkmmOption, askForTkmmOption } from './tkmmOptions';

export const DUMP_SCHEME = 'totk-dump';
const GAME_DUMP_SEARCH_VIEW_ID = 'totk-editor.gameDumpSearch';
let dumpTreeView: vscode.TreeView<DumpTreeItem> | undefined;
let extensionUri: vscode.Uri | undefined;

export function toDumpUri(fileUri: vscode.Uri): vscode.Uri {
    return fileUri.with({ scheme: DUMP_SCHEME });
}

export function getDumpSelection(): DumpTreeItem[] {
    return [...(dumpTreeView?.selection ?? [])];
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
        this.id = resourceUri.toString();
        this.contextValue = contextValue;

        if (collapsibleState === vscode.TreeItemCollapsibleState.None) {
            this.command = (isBntxTextureUri(resourceUri) || isTxtgFile(resourceUri.fsPath))
                ? { command: 'totk-editor.openBntxTexture', title: 'View Texture', arguments: [resourceUri] }
                : { command: 'vscode.open', title: 'Open', arguments: [resourceUri, { preview: true }] };
        }

        if (isArchiveFile(entryName)) {
            this.iconPath = new vscode.ThemeIcon('package');
        } else if ((isBntxTextureUri(resourceUri) || isTxtgFile(resourceUri.fsPath)) && extensionUri) {
            this.iconPath = vscode.Uri.joinPath(extensionUri, 'icons', 'texture.svg');
        } else if (contextValue === 'dumpDir') {
            this.iconPath = new vscode.ThemeIcon('folder');
        }
    }
}

export class GameDumpTreeProvider implements vscode.TreeDataProvider<DumpTreeItem> {
    private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<DumpTreeItem | undefined>();
    readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;
    private readonly onDidChangeSearchStateEmitter = new vscode.EventEmitter<void>();
    readonly onDidChangeSearchState = this.onDidChangeSearchStateEmitter.event;
    private filterQuery = '';
    private filterNeedle = '';
    private archiveFilterQuery = '';
    private archiveFilterNeedle = '';
    private indexReady = false;
    private externalIndexBuildInProgress = false;
    private externalIndexPath: string | undefined;
    private lastComputedNeedle = '';
    private lastComputedArchiveNeedle = '';
    private visibleFileMatches = new Set<string>();
    private visibleDirectoryMatches = new Set<string>();

    refresh(): void {
        this.onDidChangeTreeDataEmitter.fire(undefined);
    }

    setFilterQuery(query: string): void {
        const nextQuery = query;
        const nextNeedle = query.trim().toLowerCase();
        if (nextQuery === this.filterQuery && nextNeedle === this.filterNeedle) {
            return;
        }
        this.filterQuery = nextQuery;
        this.filterNeedle = nextNeedle;
        this.lastComputedNeedle = '';
        this.applyFilters();
    }

    setArchiveFilterQuery(query: string): void {
        const nextQuery = query;
        const nextNeedle = query.trim().toLowerCase();
        if (nextQuery === this.archiveFilterQuery && nextNeedle === this.archiveFilterNeedle) {
            return;
        }
        this.archiveFilterQuery = nextQuery;
        this.archiveFilterNeedle = nextNeedle;
        this.lastComputedArchiveNeedle = '';
        this.applyFilters();
    }

    private applyFilters(): void {
        if (!this.filterNeedle && !this.archiveFilterNeedle) {
            this.visibleFileMatches.clear();
            this.visibleDirectoryMatches.clear();
            this.onDidChangeSearchStateEmitter.fire();
            this.refresh();
            return;
        }
        this.visibleFileMatches.clear();
        this.visibleDirectoryMatches.clear();
        this.onDidChangeSearchStateEmitter.fire();
        void this.recomputeFilterMatches();
        this.refresh();
    }

    clearFilterQuery(): void {
        this.setFilterQuery('');
    }

    getFilterQuery(): string {
        return this.filterQuery;
    }

    clearArchiveFilterQuery(): void {
        this.setArchiveFilterQuery('');
    }

    getArchiveFilterQuery(): string {
        return this.archiveFilterQuery;
    }

    getSearchStatus(): string {
        if (!this.filterNeedle && !this.archiveFilterNeedle) {
            return '';
        }
        if (this.externalIndexBuildInProgress) {
            return 'Building search index...';
        }
        if (!this.indexReady || this.lastComputedNeedle !== this.filterNeedle || this.lastComputedArchiveNeedle !== this.archiveFilterNeedle) {
            return 'Searching...';
        }
        return `${this.visibleFileMatches.size.toLocaleString()} match(es)`;
    }

    onRomfsPathChanged(): void {
        this.indexReady = false;
        this.externalIndexBuildInProgress = false;
        this.lastComputedNeedle = '';
        this.lastComputedArchiveNeedle = '';
        this.visibleFileMatches.clear();
        this.visibleDirectoryMatches.clear();
        invalidateRomfsIndex();
        if (this.filterNeedle || this.archiveFilterNeedle) {
            void this.recomputeFilterMatches();
        }
        this.onDidChangeSearchStateEmitter.fire();
        this.refresh();
    }

    setExternalIndexPath(indexPath: string): void {
        this.externalIndexPath = indexPath;
    }

    setExternalIndexBuilding(isBuilding: boolean): void {
        this.externalIndexBuildInProgress = isBuilding;
        this.onDidChangeSearchStateEmitter.fire();
    }

    onExternalIndexUpdated(): void {
        this.indexReady = false;
        this.lastComputedNeedle = '';
        this.lastComputedArchiveNeedle = '';
        invalidateRomfsIndex();
        if (this.filterNeedle || this.archiveFilterNeedle) {
            void this.recomputeFilterMatches();
        }
        this.onDidChangeSearchStateEmitter.fire();
        this.refresh();
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
            const visibleEntries = await this.filterVisibleEntries(entries, parentUri);
            return visibleEntries
                .sort(compareEntriesFoldersFirstKeepingArchivesMixed)
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

    private async filterVisibleEntries(
        entries: [string, vscode.FileType][],
        parentUri: vscode.Uri,
    ): Promise<[string, vscode.FileType][]> {
        if (!this.filterNeedle && !this.archiveFilterNeedle) {
            return entries;
        }

        const romfsPath = resolveRomfsPath();

        return entries.filter(([name, fileType]) => {
            const childUri = vscode.Uri.joinPath(parentUri, name);
            const insideArchive = isPathInsideArchive(childUri.fsPath);

            if (insideArchive) {
                if (fileType === vscode.FileType.Directory) {
                    return true;
                }
                if (this.filterNeedle) {
                    return name.toLowerCase().includes(this.filterNeedle);
                }
                return true;
            }

            if (this.indexReady && this.lastComputedNeedle === this.filterNeedle && this.lastComputedArchiveNeedle === this.archiveFilterNeedle && romfsPath) {
                const relativeKey = toRelativeSearchKey(childUri.fsPath, romfsPath);
                if (fileType === vscode.FileType.Directory) {
                    if (isArchiveFile(name)) {
                        return this.visibleFileMatches.has(relativeKey) || this.visibleDirectoryMatches.has(relativeKey);
                    }
                    return this.visibleDirectoryMatches.has(relativeKey);
                }
                return this.visibleFileMatches.has(relativeKey);
            }

            if (fileType === vscode.FileType.Directory) {
                return true;
            }
            const lowerName = name.toLowerCase();
            if (this.filterNeedle && !lowerName.includes(this.filterNeedle)) {
                return false;
            }
            if (this.archiveFilterNeedle) {
                if (!isArchiveFile(name) || !lowerName.includes(this.archiveFilterNeedle)) {
                    return false;
                }
            }
            return true;
        });
    }

    private async recomputeFilterMatches(): Promise<void> {
        const romfsPath = resolveRomfsPath();
        if (!romfsPath || (!this.filterNeedle && !this.archiveFilterNeedle)) {
            return;
        }

        const indexPath = this.externalIndexPath;
        if (!indexPath || !fs.existsSync(indexPath)) {
            return;
        }

        const needle = this.filterNeedle;
        const archiveNeedle = this.archiveFilterNeedle;
        const result = await queryRomfsIndex(indexPath, romfsPath, needle, archiveNeedle);

        if (!result || this.filterNeedle !== needle || this.archiveFilterNeedle !== archiveNeedle) {
            return;
        }

        this.visibleFileMatches = result.matchedFiles;
        this.visibleDirectoryMatches = result.matchedDirs;
        this.lastComputedNeedle = needle;
        this.lastComputedArchiveNeedle = archiveNeedle;
        this.indexReady = true;
        this.onDidChangeSearchStateEmitter.fire();
        this.refresh();
    }
}

class GameDumpSearchViewProvider implements vscode.WebviewViewProvider {
    private view: vscode.WebviewView | undefined;
    private debounceHandle: NodeJS.Timeout | undefined;

    constructor(private readonly treeProvider: GameDumpTreeProvider) {}

    resolveWebviewView(webviewView: vscode.WebviewView): void {
        this.view = webviewView;
        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.html = this.buildHtml(
            this.treeProvider.getFilterQuery(),
            this.treeProvider.getArchiveFilterQuery()
        );

        webviewView.webview.onDidReceiveMessage((message: { type: string; query?: string; archiveQuery?: string }) => {
            if (message.type === 'setQuery' || message.type === 'setArchiveQuery') {
                if (this.debounceHandle) {
                    clearTimeout(this.debounceHandle);
                }
                this.debounceHandle = setTimeout(() => {
                    if (message.query !== undefined) {
                        this.treeProvider.setFilterQuery(message.query);
                    }
                    if (message.archiveQuery !== undefined) {
                        this.treeProvider.setArchiveFilterQuery(message.archiveQuery);
                    }
                }, 120);
            }
            if (message.type === 'clear') {
                this.treeProvider.clearFilterQuery();
                this.postQuery('');
            }
            if (message.type === 'clearArchive') {
                this.treeProvider.clearArchiveFilterQuery();
                this.postArchiveQuery('');
            }
        });
    }

    postQuery(query: string): void {
        if (!this.view) {
            return;
        }
        void this.view.webview.postMessage({ type: 'setQuery', query });
    }

    postArchiveQuery(query: string): void {
        if (!this.view) {
            return;
        }
        void this.view.webview.postMessage({ type: 'setArchiveQuery', query });
    }

    postStatus(status: string): void {
        if (!this.view) {
            return;
        }
        void this.view.webview.postMessage({ type: 'setStatus', status });
    }

    private buildHtml(initialQuery: string, initialArchiveQuery: string): string {
        const escaped = escapeHtml(initialQuery);
        const escapedArchive = escapeHtml(initialArchiveQuery);
        return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
    body {
        margin: 0;
        padding: 8px;
        background: var(--vscode-sideBar-background);
        color: var(--vscode-foreground);
        font-family: var(--vscode-font-family);
        font-size: 12px;
    }
    .row {
        display: flex;
        align-items: center;
        gap: 6px;
        margin-bottom: 6px;
    }
    .status {
        font-size: 11px;
        color: var(--vscode-descriptionForeground);
        min-height: 14px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }
    input {
        flex: 1;
        height: 24px;
        border-radius: 4px;
        border: 1px solid var(--vscode-input-border, transparent);
        background: var(--vscode-input-background);
        color: var(--vscode-input-foreground);
        padding: 0 8px;
        outline: none;
    }
    input:focus {
        border-color: var(--vscode-focusBorder);
    }
    button {
        height: 24px;
        min-width: 24px;
        border-radius: 4px;
        border: 1px solid var(--vscode-button-border, transparent);
        background: var(--vscode-button-secondaryBackground, var(--vscode-button-background));
        color: var(--vscode-button-secondaryForeground, var(--vscode-button-foreground));
        cursor: pointer;
        padding: 0 6px;
    }
    button:hover {
        background: var(--vscode-button-secondaryHoverBackground, var(--vscode-button-hoverBackground));
    }
</style>
</head>
<body>
    <div class="row">
        <input id="q" type="text" value="${escaped}" placeholder="Filter game dump..." />
        <button id="clear" title="Clear">✕</button>
    </div>
    <div class="row">
        <input id="aq" type="text" value="${escapedArchive}" placeholder="Filter archives..." />
        <button id="clearArchive" title="Clear">✕</button>
    </div>
    <div id="status" class="status"></div>
    <script>
        const vscode = acquireVsCodeApi();
        const input = document.getElementById('q');
        const clear = document.getElementById('clear');
        const archiveInput = document.getElementById('aq');
        const clearArchive = document.getElementById('clearArchive');
        const status = document.getElementById('status');

        input.addEventListener('input', () => {
            vscode.postMessage({ type: 'setQuery', query: input.value });
        });
        clear.addEventListener('click', () => {
            input.value = '';
            vscode.postMessage({ type: 'clear' });
            input.focus();
        });

        archiveInput.addEventListener('input', () => {
            vscode.postMessage({ type: 'setArchiveQuery', archiveQuery: archiveInput.value });
        });
        clearArchive.addEventListener('click', () => {
            archiveInput.value = '';
            vscode.postMessage({ type: 'clearArchive' });
            archiveInput.focus();
        });

        window.addEventListener('message', (event) => {
            const msg = event.data;
            if (msg?.type === 'setQuery') {
                input.value = msg.query ?? '';
            }
            if (msg?.type === 'setArchiveQuery') {
                archiveInput.value = msg.query ?? '';
            }
            if (msg?.type === 'setStatus') {
                status.textContent = msg.status ?? '';
            }
        });
    </script>
</body>
</html>`;
    }
}

function toRelativeSearchKey(fsPath: string, rootPath: string): string {
    const normalizedPath = fsPath.replace(/\\/g, '/');
    const normalizedRoot = rootPath.replace(/\\/g, '/').replace(/\/+$/, '');
    if (!normalizedPath.toLowerCase().startsWith(normalizedRoot.toLowerCase())) {
        return normalizedPath.toLowerCase();
    }
    const relative = normalizedPath.slice(normalizedRoot.length).replace(/^\/+/, '');
    return relative.toLowerCase();
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

function contextValueForEntry(
    name: string,
    isDirectory: boolean,
    fsPath: string,
    romfsPath: string,
): string {
    if (!isDirectory) {
        return isPathInsideArchive(fsPath) ? 'dumpVirtualFile' : 'dumpFile';
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
    onProjectCanonicalPathsChanged?: () => void | Promise<void>,
): GameDumpTreeProvider {
    extensionUri = context.extensionUri;
    const provider = new GameDumpTreeProvider();

    const treeView = vscode.window.createTreeView('totk-editor.gameDump', {
        treeDataProvider: provider,
        showCollapseAll: true,
        canSelectMany: true,
    });
    dumpTreeView = treeView;
    context.subscriptions.push(treeView);
    const searchViewProvider = new GameDumpSearchViewProvider(provider);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(GAME_DUMP_SEARCH_VIEW_ID, searchViewProvider),
    );
    const updateFilterUi = (): void => {
        const query = provider.getFilterQuery().trim();
        const archiveQuery = provider.getArchiveFilterQuery().trim();
        const status = provider.getSearchStatus();
        
        let msgParts = [];
        if (query) {msgParts.push(query);}
        if (archiveQuery) {msgParts.push(`Archives: ${archiveQuery}`);}
        
        if (msgParts.length > 0) {
            treeView.message = status ? `Search: ${msgParts.join(', ')} - ${status}` : `Search: ${msgParts.join(', ')}`;
        } else {
            treeView.message = undefined;
        }
        searchViewProvider.postStatus(status);
    };
    context.subscriptions.push(provider.onDidChangeSearchState(updateFilterUi));
    updateFilterUi();

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
            if (event.affectsConfiguration('TKVSC.romfsPath')) {
                provider.onRomfsPathChanged();
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
            'totk-editor.addDumpToActiveProject',
            async (item: DumpTreeItem | undefined) => {
                const entries = selectedItems(item).filter(
                    (entry) =>
                        entry.contextValue === 'dumpFile' ||
                        entry.contextValue === 'dumpVirtualFile' ||
                        entry.contextValue === 'dumpArchive',
                );
                if (entries.length === 0) {
                    void vscode.window.showWarningMessage(
                        'Select one or more files in TOTK Dump first.',
                    );
                    return;
                }

                const activeFsPath = archiveTree.getActiveProject();
                let projectRoot: string | undefined;
                if (activeFsPath) {
                    projectRoot = activeFsPath;
                } else {
                    const projects = archiveTree.getProjectRoots();
                    projectRoot = await pickProjectRoot(projects);
                }

                if (!projectRoot) {
                    return;
                }

                const activeTkmmOption = getActiveTkmmOption(context, projectRoot);

                let copiedCount = 0;
                for (const entry of entries) {
                    const copied = await addDumpEntryToProject(
                        entry.resourceUri.fsPath,
                        projectRoot,
                        undefined,
                        { suppressSuccessMessage: entries.length > 1 },
                        activeTkmmOption
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
                    void onProjectCanonicalPathsChanged?.();
                }
            },
        ),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(
            'totk-editor.addDumpToProject',
            async (item: DumpTreeItem | undefined) => {
                const entries = selectedItems(item).filter(
                    (entry) =>
                        entry.contextValue === 'dumpFile' ||
                        entry.contextValue === 'dumpVirtualFile' ||
                        entry.contextValue === 'dumpArchive',
                );
                if (entries.length === 0) {
                    void vscode.window.showWarningMessage(
                        'Select one or more files in TOTK Dump first.',
                    );
                    return;
                }

                const projects = archiveTree.getProjectRoots();
                const projectRoot = await pickProjectRoot(projects);
                if (!projectRoot) {
                    return;
                }

                const optionResult = await askForTkmmOption(projectRoot);
                if (!optionResult || optionResult === 'BACK') {
                    return;
                }

                const tkmmOption = optionResult === 'BASE_PROJECT' ? undefined : optionResult;

                let copiedCount = 0;
                for (const entry of entries) {
                    const copied = await addDumpEntryToProject(
                        entry.resourceUri.fsPath,
                        projectRoot,
                        undefined,
                        { suppressSuccessMessage: entries.length > 1 },
                        tkmmOption
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
                    void onProjectCanonicalPathsChanged?.();
                }
            },
        ),
    );

    return provider;
}

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
