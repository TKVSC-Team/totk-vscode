import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import * as cp from 'child_process';
import { NodeEditorAdapterRegistry } from './registry';
import { getCachedPythonExecutable } from '../pythonEnv';

function getPython(): string {
    return getCachedPythonExecutable() ?? 'python';
}

/**
 * Spawn Python with the AINB binary piped via stdin.
 * Uses cp.spawn (no shell, no maxBuffer limit, no temp files).
 */
function runBridgeWithStdin(
    extensionPath: string,
    pythonExe: string,
    scriptName: string,
    commandJson: string,
    stdinData: Buffer,
): Promise<any> {
    return new Promise((resolve, reject) => {
        const scriptPath = path.join(extensionPath, 'python', scriptName);
        const proc = cp.spawn(pythonExe, [scriptPath, '--stdin', '--command', commandJson], {
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
        proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

        proc.on('error', reject);
        proc.on('close', (code) => {
            if (code !== 0) {
                reject(new Error(`Python Bridge Error:\n${stderr.trim()}`));
                return;
            }
            try {
                resolve(JSON.parse(stdout.trim()));
            } catch {
                reject(new Error(`Failed to parse Python output: ${stdout.substring(0, 500)}`));
            }
        });

        proc.stdin.write(stdinData);
        proc.stdin.end();
    });
}

class AinbDocument implements vscode.CustomDocument {
    public currentBinary: Buffer;
    /** Last-known node positions sent by the webview after a drag. Persisted into the JSON layer on save. */
    public nodePositions: Record<string, { x: number; y: number }> = {};
    /** Whether unsaved structural edits have been made (via rpc_edit). */
    public isDirty = false;
    /** Guard to block Auto Save; set true only for explicit save requests. */
    public allowDiskWrite = false;

    constructor(public readonly uri: vscode.Uri) {
        this.currentBinary = fs.readFileSync(uri.fsPath);
    }

    dispose(): void { /* nothing to clean up - it's all in memory */ }
}

const VIEW_TYPE = 'totk-editor.ainbNodeEditor';

export interface AinbSaveNotification {
    diskPath: string;
    content: Uint8Array;
}

export class AinbNodeEditorProvider implements vscode.CustomEditorProvider<AinbDocument> {
    private readonly registry: NodeEditorAdapterRegistry;

    private readonly _onDidChangeCustomDocument = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<AinbDocument>>();
    public readonly onDidChangeCustomDocument = this._onDidChangeCustomDocument.event;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly onDidSaveBinary?: (info: AinbSaveNotification) => Promise<void>,
    ) {
        this.registry = new NodeEditorAdapterRegistry(context.extensionPath);
    }

    public static register(
        context: vscode.ExtensionContext,
        onDidSaveBinary?: (info: AinbSaveNotification) => Promise<void>,
    ): vscode.Disposable {
        const provider = new AinbNodeEditorProvider(context, onDidSaveBinary);
        return vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
            webviewOptions: { retainContextWhenHidden: true },
        });
    }

    // ---- CustomDocument lifecycle ------------------------------------------

    public async openCustomDocument(uri: vscode.Uri): Promise<AinbDocument> {
        return new AinbDocument(uri);
    }

    public async saveCustomDocument(document: AinbDocument): Promise<void> {
        // Keep edits in-memory until an explicit save is requested by the user.
        // This blocks VS Code Auto Save from writing on every graph mutation.
        if (!document.allowDiskWrite) {
            return;
        }
        const targetPath = document.uri.fsPath;
        try { fs.accessSync(targetPath, fs.constants.W_OK); }
        catch { fs.chmodSync(targetPath, 0o666); }
        fs.writeFileSync(targetPath, document.currentBinary);
        await this.onDidSaveBinary?.({
            diskPath: targetPath,
            content: new Uint8Array(document.currentBinary),
        });
        document.isDirty = false;
        document.allowDiskWrite = false;
    }

    public async saveCustomDocumentAs(document: AinbDocument, destination: vscode.Uri): Promise<void> {
        fs.writeFileSync(destination.fsPath, document.currentBinary);
    }

    public async revertCustomDocument(document: AinbDocument): Promise<void> {
        document.currentBinary = fs.readFileSync(document.uri.fsPath);
    }

    public async backupCustomDocument(
        document: AinbDocument,
        context: vscode.CustomDocumentBackupContext,
    ): Promise<vscode.CustomDocumentBackup> {
        fs.writeFileSync(context.destination.fsPath, document.currentBinary);
        return { id: context.destination.toString(), delete: () => {} };
    }

    // ---- Editor ------------------------------------------------------------

    public async resolveCustomEditor(
        document: AinbDocument,
        webviewPanel: vscode.WebviewPanel,
        _token: vscode.CancellationToken,
    ): Promise<void> {

        webviewPanel.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.file(path.join(this.context.extensionPath, 'editors/node-editor/dist'))],
        };

        const adapter = this.registry.getForUri(document.uri);
        if (!adapter) {
            webviewPanel.webview.html = `<h3>Error: No format adapter registered</h3>`;
            return;
        }

        webviewPanel.webview.html = this.getWebviewHtml(webviewPanel.webview);

        const sendModelToWebview = (jsonModel: any) => {
            const rawText = typeof jsonModel === 'string' ? jsonModel : JSON.stringify(jsonModel);
            const parsed = adapter.parse(document.uri.fsPath, rawText);

            // Seed + overlay node positions so topology edits do not trigger re-layout sorting.
            // We treat parsed coordinates as initial defaults only, then keep stable positions in-memory.
            for (const node of parsed.model.nodes) {
                const key = String(node.id);
                const saved = document.nodePositions[key];
                if (saved) {
                    node.x = saved.x;
                    node.y = saved.y;
                } else {
                    document.nodePositions[key] = { x: node.x, y: node.y };
                }
            }

            webviewPanel.webview.postMessage({ type: 'init', payload: parsed.model });
        };

        const updateWebview = async () => {
            try {
                webviewPanel.webview.postMessage({ type: 'status', payload: { text: 'Decoding AINB...', progress: 30 } });

                const result = await runBridgeWithStdin(
                    this.context.extensionPath,
                    getPython(),
                    'ainb_rpc.py',
                    JSON.stringify({ action: 'to_json' }),
                    document.currentBinary,
                );

                if (result.status !== 'success') {
                    throw new Error(`Python RPC failed: ${result.message}`);
                }

                webviewPanel.webview.postMessage({ type: 'status', payload: { text: 'Rendering...', progress: 90 } });
                sendModelToWebview(result.data);
            } catch (err: any) {
                webviewPanel.webview.postMessage({ type: 'error', payload: { message: err.message } });
            }
        };

        webviewPanel.webview.onDidReceiveMessage(async (msg: any) => {
            switch (msg.type) {
                case 'ready':
                    await updateWebview();
                    break;

                // The webview pushes updated positions after every drag-stop.
                // We store them so they're injected on the next sendModelToWebview call
                // and written into the JSON on explicit Ctrl+S save.
                case 'node_positions':
                    document.nodePositions = { ...document.nodePositions, ...msg.payload };
                    if (!document.isDirty) {
                        document.isDirty = true;
                        this._onDidChangeCustomDocument.fire({
                            document,
                            undo: () => {},
                            redo: () => {},
                        });
                    }
                    break;

                case 'explicit_save':
                    document.allowDiskWrite = true;
                    await vscode.commands.executeCommand('workbench.action.files.save');
                    break;

                case 'rpc_edit':
                    try {
                        const commandString = JSON.stringify(msg.payload);

                        const result = await runBridgeWithStdin(
                            this.context.extensionPath,
                            getPython(),
                            'ainb_rpc.py',
                            commandString,
                            document.currentBinary,
                        );

                        if (result.status === 'success') {
                            document.currentBinary = Buffer.from(result.data, 'base64');

                            // Fire the dirty event only the first time after a clean save,
                            // so VS Code shows the "●" indicator and enables Ctrl+S —
                            // but does NOT auto-save on every single edit.
                            if (!document.isDirty) {
                                document.isDirty = true;
                                this._onDidChangeCustomDocument.fire({
                                    document,
                                    undo: () => {},
                                    redo: () => {},
                                });
                            }

                            sendModelToWebview(result.model);
                        } else {
                            vscode.window.showErrorMessage(`Python Error: ${result.message}`);
                        }
                    } catch (err) {
                        vscode.window.showErrorMessage(`Failed to run Python API: ${err}`);
                    }
                    break;
            }
        });
    }

    // ---- Webview HTML ------------------------------------------------------

    private getWebviewHtml(webview: vscode.Webview): string {
        const distDir = path.join(this.context.extensionPath, 'editors', 'node-editor', 'dist');
        const indexPath = path.join(distDir, 'index.html');

        if (!fs.existsSync(indexPath)) {
            return `<!DOCTYPE html><html><body><h3>TOTK Node Editor</h3><p>Webview assets missing.</p></body></html>`;
        }

        let html = fs.readFileSync(indexPath, 'utf-8');
        html = html.replace(/(src|href)="([^"]+)"/g, (_match, attr: string, assetPath: string) => {
            if (assetPath.startsWith('http') || assetPath.startsWith('data:')) {
                return `${attr}="${assetPath}"`;
            }
            const normalized = assetPath.replace(/^\.?\//, '');
            const diskAsset = path.join(distDir, normalized);
            const webUri = webview.asWebviewUri(vscode.Uri.file(diskAsset));
            return `${attr}="${webUri.toString()}"`;
        });

        return html;
    }
}