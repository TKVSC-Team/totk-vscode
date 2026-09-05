import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { getDiskArchivePath, getLocatorInsideDiskArchive, isPathInsideArchive } from './archives';
import { getBridgeEnv } from './api/bridgeEnv';
import { runBridgeJsonAsync, runBridgeReadContentAsync } from './bridge';
import { getAinbGraphViewHtml } from './ainbGraphView';
import { ensureAinbNodeDefs, loadAinbNodeDefs } from './ainbNodeDefs';
import { getCachedPythonExecutable } from './pythonEnv';

/** A single set/delete of a value at a path inside the AINB document. */
interface AinbOp {
    path: (string | number)[];
    before: unknown;
    after: unknown;
}

interface AinbEdit {
    label: string;
    ops: AinbOp[];
}

interface NodePosition {
    x: number;
    y: number;
}

interface ViewState {
    x: number;
    y: number;
    z: number;
}

interface StoredLayout {
    layout: Record<string, NodePosition>;
    view?: ViewState;
}

type AinbDocumentModel = Record<string, unknown>;

function applyOp(doc: AinbDocumentModel, opPath: (string | number)[], value: unknown): void {
    if (opPath.length === 0) {
        return;
    }
    let cursor: Record<string | number, unknown> = doc as Record<string | number, unknown>;
    for (let i = 0; i < opPath.length - 1; i++) {
        const next = cursor[opPath[i]];
        if (next === undefined || next === null || typeof next !== 'object') {
            return;
        }
        cursor = next as Record<string | number, unknown>;
    }
    const last = opPath[opPath.length - 1];
    if (value === undefined) {
        delete cursor[last];
    } else {
        cursor[last] = value;
    }
}

/** Schemes the extension exposes purely for browsing the untouched game dump. */
const READ_ONLY_SCHEMES = new Set(['totk-dump', 'sarc-dump']);

/**
 * Game dump files must stay untouched. The dump scheme is backed by a read-only
 * FileSystemProvider, but this editor saves through the Python bridge and writes the
 * real romfs path directly, so it has to enforce that itself rather than relying on
 * the provider to refuse the write.
 */
export function isReadOnlyAinbUri(uri: vscode.Uri): boolean {
    if (READ_ONLY_SCHEMES.has(uri.scheme)) {
        return true;
    }
    try {
        return vscode.workspace.fs.isWritableFileSystem(uri.scheme) === false;
    } catch {
        return false;
    }
}

export class AinbDocument implements vscode.CustomDocument {
    private readonly _onDidChange = new vscode.EventEmitter<{
        readonly label: string;
        undo(): void;
        redo(): void;
    }>();
    /** Fires when content changes so VS Code can drive its undo stack and dirty state. */
    public readonly onDidChange = this._onDidChange.event;

    private readonly _onDidChangeContent = new vscode.EventEmitter<void>();
    /** Fires whenever the model changed and the webview should be resynced. */
    public readonly onDidChangeContent = this._onDidChangeContent.event;

    private _model: AinbDocumentModel;
    private _savedText: string;
    // VS Code owns the undo stack but does not expose its depth, so mirror it here
    // to keep the webview's Undo/Redo buttons in the right state.
    private _undoDepth = 0;
    private _redoDepth = 0;

    private constructor(
        public readonly uri: vscode.Uri,
        model: AinbDocumentModel,
        savedText: string,
    ) {
        this._model = model;
        this._savedText = savedText;
    }

    static async create(uri: vscode.Uri, backupId: string | undefined): Promise<AinbDocument> {
        const source = backupId ? vscode.Uri.parse(backupId) : uri;
        const text = backupId
            ? await fs.promises.readFile(source.fsPath, 'utf-8')
            : await readAinbAsJson(uri);
        const model = JSON.parse(text) as AinbDocumentModel;
        // A restored backup is by definition unsaved, so its baseline must be the
        // on-disk file, not the backup itself.
        const savedText = backupId ? await readAinbAsJson(uri) : text;
        return new AinbDocument(uri, model, savedText);
    }

    get model(): AinbDocumentModel {
        return this._model;
    }

    get isDirty(): boolean {
        return JSON.stringify(this._model) !== this._savedText;
    }

    get isReadOnly(): boolean {
        return isReadOnlyAinbUri(this.uri);
    }

    get canUndo(): boolean {
        return this._undoDepth > 0;
    }

    get canRedo(): boolean {
        return this._redoDepth > 0;
    }

    /** Apply an edit from the webview and register it on VS Code's undo stack. */
    applyEdit(edit: AinbEdit): void {
        if (this.isReadOnly) {
            // The webview blocks edits too; this is the backstop.
            return;
        }
        const doIt = () => {
            for (const op of edit.ops) {
                applyOp(this._model, op.path, op.after);
            }
        };
        const undoIt = () => {
            for (let i = edit.ops.length - 1; i >= 0; i--) {
                applyOp(this._model, edit.ops[i].path, edit.ops[i].before);
            }
        };

        // The webview already applied this optimistically; only the host copy needs it.
        doIt();
        this._undoDepth++;
        this._redoDepth = 0;

        this._onDidChange.fire({
            label: edit.label,
            undo: () => {
                undoIt();
                this._undoDepth = Math.max(0, this._undoDepth - 1);
                this._redoDepth++;
                this._onDidChangeContent.fire();
            },
            redo: () => {
                doIt();
                this._undoDepth++;
                this._redoDepth = Math.max(0, this._redoDepth - 1);
                this._onDidChangeContent.fire();
            },
        });
    }

    async save(cancellation: vscode.CancellationToken): Promise<void> {
        await this.saveAs(this.uri, cancellation);
        this._savedText = JSON.stringify(this._model);
    }

    async saveAs(target: vscode.Uri, _cancellation: vscode.CancellationToken): Promise<void> {
        if (isReadOnlyAinbUri(target)) {
            throw new Error(
                'This file is part of the read-only game dump. Add it to a project folder before editing it.',
            );
        }
        await writeAinbFromJson(target, JSON.stringify(this._model));
    }

    async revert(): Promise<void> {
        const text = await readAinbAsJson(this.uri);
        this._model = JSON.parse(text) as AinbDocumentModel;
        this._savedText = text;
        this._undoDepth = 0;
        this._redoDepth = 0;
        this._onDidChangeContent.fire();
    }

    async backup(destination: vscode.Uri): Promise<vscode.CustomDocumentBackup> {
        await fs.promises.mkdir(path.dirname(destination.fsPath), { recursive: true });
        await fs.promises.writeFile(destination.fsPath, JSON.stringify(this._model), 'utf-8');
        return {
            id: destination.toString(),
            delete: async () => {
                try {
                    await fs.promises.unlink(destination.fsPath);
                } catch {
                    /* best-effort cleanup */
                }
            },
        };
    }

    dispose(): void {
        this._onDidChange.dispose();
        this._onDidChangeContent.dispose();
    }
}

/** Extension install path, captured when the provider is registered. */
let extensionRootPath = '';

function requirePython(): { python: string; bridge: string; env: NodeJS.ProcessEnv } {
    const python = getCachedPythonExecutable();
    if (!python) {
        throw new Error(
            'Python executable not found. Configure TKVSC.pythonPath or run the TKVSC Python setup.',
        );
    }
    return {
        python,
        bridge: path.join(extensionRootPath, 'python', 'totk_bridge.py'),
        env: getBridgeEnv(),
    };
}

/** Decode an .ainb (on disk or inside an archive) into the library's JSON form. */
async function readAinbAsJson(uri: vscode.Uri): Promise<string> {
    const { python, bridge, env } = requirePython();
    const filePath = uri.fsPath;

    if (isPathInsideArchive(filePath)) {
        const archive = getDiskArchivePath(filePath);
        const internal = getLocatorInsideDiskArchive(filePath, archive);
        return runBridgeReadContentAsync(python, bridge, ['read', archive, internal], env);
    }
    return runBridgeReadContentAsync(python, bridge, ['read-disk', filePath], env);
}

/** Re-encode JSON back into binary AINB, writing through the archive when needed. */
async function writeAinbFromJson(uri: vscode.Uri, json: string): Promise<void> {
    const { python, bridge, env } = requirePython();
    const filePath = uri.fsPath;

    if (isPathInsideArchive(filePath)) {
        const archive = getDiskArchivePath(filePath);
        const internal = getLocatorInsideDiskArchive(filePath, archive);
        await runBridgeJsonAsync(python, bridge, ['write', archive, internal], json, env);
        return;
    }
    await runBridgeJsonAsync(python, bridge, ['write-disk', filePath], json, env);
}

export class AinbEditorProvider implements vscode.CustomEditorProvider<AinbDocument> {
    public static readonly viewType = 'totk-editor.ainbEditor';

    private readonly _onDidChangeCustomDocument =
        new vscode.EventEmitter<vscode.CustomDocumentEditEvent<AinbDocument>>();
    public readonly onDidChangeCustomDocument = this._onDidChangeCustomDocument.event;

    private readonly webviews = new Map<string, vscode.WebviewPanel>();

    constructor(private readonly context: vscode.ExtensionContext) {
        extensionRootPath = context.extensionPath;
    }

    public static register(context: vscode.ExtensionContext): vscode.Disposable {
        const provider = new AinbEditorProvider(context);
        return vscode.window.registerCustomEditorProvider(AinbEditorProvider.viewType, provider, {
            webviewOptions: { retainContextWhenHidden: true },
            supportsMultipleEditorsPerDocument: false,
        });
    }

    async openCustomDocument(
        uri: vscode.Uri,
        openContext: vscode.CustomDocumentOpenContext,
        _token: vscode.CancellationToken,
    ): Promise<AinbDocument> {
        const document = await AinbDocument.create(uri, openContext.backupId);

        document.onDidChange((event) => {
            this._onDidChangeCustomDocument.fire({
                document,
                label: event.label,
                undo: event.undo,
                redo: event.redo,
            });
            this.postState(document);
        });

        document.onDidChangeContent(() => {
            this.postDoc(document, 'setDoc');
        });

        return document;
    }

    async resolveCustomEditor(
        document: AinbDocument,
        webviewPanel: vscode.WebviewPanel,
        _token: vscode.CancellationToken,
    ): Promise<void> {
        this.webviews.set(document.uri.toString(), webviewPanel);
        webviewPanel.onDidDispose(() => this.webviews.delete(document.uri.toString()));

        webviewPanel.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.context.extensionUri],
        };
        webviewPanel.webview.html = getAinbGraphViewHtml(
            webviewPanel.webview,
            path.basename(document.uri.fsPath),
        );

        webviewPanel.webview.onDidReceiveMessage(async (message) => {
            try {
                await this.handleMessage(document, webviewPanel, message);
            } catch (error) {
                const text = error instanceof Error ? error.message : String(error);
                void vscode.window.showErrorMessage(`AINB editor: ${text}`);
            }
        });
    }

    private async handleMessage(
        document: AinbDocument,
        panel: vscode.WebviewPanel,
        message: { type: string; [key: string]: unknown },
    ): Promise<void> {
        switch (message.type) {
            case 'ready':
                this.postDoc(document, 'init');
                // First AINB opened for this game harvests the catalog from the dump. The
                // editor is already usable on the shipped one, so this stays off the
                // opening path and pushes the result in when it is ready.
                void this.refreshNodeDefs(document);
                break;

            case 'edit':
                document.applyEdit({
                    label: (message.label as string) || 'Edit',
                    ops: (message.ops as AinbOp[]) || [],
                });
                break;

            case 'save':
                if (document.isReadOnly) {
                    void vscode.window.showWarningMessage(
                        'This AINB file is part of the read-only game dump. Right-click it in the Game Dump view to add it to a project folder first.',
                    );
                    break;
                }
                await vscode.commands.executeCommand('workbench.action.files.save');
                break;

            case 'undo':
                await vscode.commands.executeCommand('undo');
                break;

            case 'redo':
                await vscode.commands.executeCommand('redo');
                break;

            case 'saveLayout':
                await this.storeLayout(document.uri, {
                    layout: message.layout as Record<string, NodePosition>,
                    view: message.view as ViewState | undefined,
                });
                break;

            case 'exportLayout': {
                const target = await vscode.window.showSaveDialog({
                    filters: { 'Node layout': ['json'] },
                    defaultUri: vscode.Uri.file(document.uri.fsPath + '.layout.json'),
                });
                if (target) {
                    await fs.promises.writeFile(
                        target.fsPath,
                        JSON.stringify(message.layout, null, 2),
                        'utf-8',
                    );
                    panel.webview.postMessage({ type: 'status', message: 'Layout exported' });
                }
                break;
            }

            case 'importLayout': {
                const picked = await vscode.window.showOpenDialog({
                    canSelectMany: false,
                    filters: { 'Node layout': ['json'] },
                });
                if (picked && picked.length) {
                    const raw = await fs.promises.readFile(picked[0].fsPath, 'utf-8');
                    panel.webview.postMessage({ type: 'layout', layout: JSON.parse(raw) });
                }
                break;
            }
        }
    }

    private layoutKey(uri: vscode.Uri): string {
        return `ainbLayout:${uri.toString()}`;
    }

    private async storeLayout(uri: vscode.Uri, stored: StoredLayout): Promise<void> {
        await this.context.workspaceState.update(this.layoutKey(uri), stored);
    }

    private loadLayout(uri: vscode.Uri): StoredLayout {
        return (
            this.context.workspaceState.get<StoredLayout>(this.layoutKey(uri)) ?? {
                layout: {},
            }
        );
    }

    private postDoc(document: AinbDocument, type: 'init' | 'setDoc'): void {
        const panel = this.webviews.get(document.uri.toString());
        if (!panel) {
            return;
        }
        const stored = this.loadLayout(document.uri);
        void panel.webview.postMessage({
            type,
            doc: document.model,
            layout: stored.layout,
            view: stored.view,
            isDirty: document.isDirty,
            canUndo: document.canUndo,
            canRedo: document.canRedo,
            readOnly: document.isReadOnly,
            // Only needed on the first push; resends would just re-parse ~1.8 MB.
            nodeDefs: type === 'init' ? loadAinbNodeDefs(this.context.extensionPath) : undefined,
        });
    }

    /** Build the dump's own node definitions if needed, then push them to the webview. */
    private async refreshNodeDefs(document: AinbDocument): Promise<void> {
        let built = false;
        try {
            built = await ensureAinbNodeDefs();
        } catch {
            // Reported by the builder; the shipped catalog stays in place.
            return;
        }
        if (!built) {
            return;
        }
        const panel = this.webviews.get(document.uri.toString());
        if (!panel) {
            return;
        }
        void panel.webview.postMessage({
            type: 'nodeDefs',
            nodeDefs: loadAinbNodeDefs(this.context.extensionPath),
        });
    }

    private postState(document: AinbDocument): void {
        const panel = this.webviews.get(document.uri.toString());
        if (!panel) {
            return;
        }
        void panel.webview.postMessage({
            type: 'state',
            isDirty: document.isDirty,
            canUndo: document.canUndo,
            canRedo: document.canRedo,
            readOnly: document.isReadOnly,
        });
    }

    saveCustomDocument(
        document: AinbDocument,
        cancellation: vscode.CancellationToken,
    ): Thenable<void> {
        return document.save(cancellation).then(() => this.postState(document));
    }

    saveCustomDocumentAs(
        document: AinbDocument,
        destination: vscode.Uri,
        cancellation: vscode.CancellationToken,
    ): Thenable<void> {
        return document.saveAs(destination, cancellation);
    }

    revertCustomDocument(document: AinbDocument): Thenable<void> {
        return document.revert();
    }

    backupCustomDocument(
        document: AinbDocument,
        context: vscode.CustomDocumentBackupContext,
        _cancellation: vscode.CancellationToken,
    ): Thenable<vscode.CustomDocumentBackup> {
        return document.backup(context.destination);
    }
}
