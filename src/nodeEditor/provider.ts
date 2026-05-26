import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as util from 'util';
import { NodeEditorAdapterRegistry } from './registry';

const execPromise = util.promisify(cp.exec);

// --- Python RPC Helpers ---
// Grabs the workspace's configured Python, or defaults to system 'python'
function getCachedPythonExecutable(): string {
    return vscode.workspace.getConfiguration('python').get<string>('defaultInterpreterPath') || 'python';
}

async function runBridgeJson(extensionPath: string, pythonExe: string, args: string[]): Promise<any> {
    const scriptPath = path.join(extensionPath, 'python', args[0]);   
    const commandArgs = [scriptPath, ...args.slice(1)].map(arg => `"${arg.replace(/"/g, '\\"')}"`).join(' ');
    
    try {
        const { stdout, stderr } = await execPromise(`"${pythonExe}" ${commandArgs}`);
        if (stderr && stderr.trim()) {
            console.warn("Python warning:", stderr);
        }
        return JSON.parse(stdout.trim());
    } catch (execError: any) {
        // --- NEW: Extract the actual Python traceback/stderr stream ---
        const pythonError = execError.stderr ? execError.stderr.trim() : execError.message;
        throw new Error(`Python Bridge Error:\n${pythonError}`);
    }
}

type NodeEditorMessage =
    | { type: 'ready' }
    | { type: 'requestSaveScaffold' };

const VIEW_TYPE = 'totk-editor.ainbNodeEditor';

export class AinbNodeEditorProvider implements vscode.CustomTextEditorProvider {
    private readonly registry: NodeEditorAdapterRegistry;

    constructor(private readonly context: vscode.ExtensionContext) {
        // Pass the extension path so registry adapters can load internal assets if needed
        this.registry = new NodeEditorAdapterRegistry(context.extensionPath);
    }

    public static register(context: vscode.ExtensionContext): vscode.Disposable {
        const provider = new AinbNodeEditorProvider(context);
        return vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
            webviewOptions: {
                retainContextWhenHidden: true,
            },
        });
    }

public async resolveCustomTextEditor(
        document: vscode.TextDocument,
        webviewPanel: vscode.WebviewPanel,
        _token: vscode.CancellationToken
    ): Promise<void> {
        
        let isSaving = false; // <-- ADD THIS FLAG

        webviewPanel.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.file(path.join(this.context.extensionPath, 'editors/node-editor/dist'))],
        };

        const adapter = this.registry.getForUri(document.uri);
        if (!adapter) {
            webviewPanel.webview.html = `<h3>Error: No format adapter registered for ${path.basename(document.uri.fsPath)}</h3>`;
            return;
        }

        webviewPanel.webview.html = this.getWebviewHtml(webviewPanel.webview);

        // Change updateWebview to be async
        const updateWebview = async () => {
            try {
                // START: 10%
                webviewPanel.webview.postMessage({ type: 'status', payload: { text: 'Reading document...', progress: 10 } });
                const filePath = document.uri.fsPath;
                let rawText = document.getText();

                // 1. Intercept binary files
                if (filePath.toLowerCase().endsWith('.ainb')) {
                    // PYTHON RPC: 30%
                    webviewPanel.webview.postMessage({ type: 'status', payload: { text: 'Decoding binary AINB via Python...', progress: 30 } });
                    
                    const commandString = JSON.stringify({ action: "to_json" });
                    const result = await runBridgeJson(
                        this.context.extensionPath,
                        getCachedPythonExecutable(), [
                        'ainb_rpc.py',
                        '--file', filePath, 
                        '--command', commandString
                    ]);
                    
                    if (result.status !== 'success') {
                        throw new Error(`Python RPC failed: ${result.message}`);
                    }
                    
                    // JSON LOADED: 60%
                    webviewPanel.webview.postMessage({ type: 'status', payload: { text: 'Parsing AINB JSON data...', progress: 60 } });
                    rawText = typeof result.data === 'string' ? result.data : JSON.stringify(result.data);
                }

                // 2. Run your adapter
                // LAYOUT CALCULATION: 80%
                webviewPanel.webview.postMessage({ type: 'status', payload: { text: 'Calculating node layout...', progress: 80 } });
                const result = adapter.parse(filePath, rawText);
                
                // 3. Send to React
                // RENDERING: 95%
                webviewPanel.webview.postMessage({ type: 'status', payload: { text: 'Rendering graph...', progress: 95 } });
                webviewPanel.webview.postMessage({ type: 'init', payload: result.model });

            } catch (err: any) {
                webviewPanel.webview.postMessage({ type: 'error', payload: { message: err.message } });
            }
        };

        // Message receiver from React App
        webviewPanel.webview.onDidReceiveMessage(async (msg: any) => {
            switch (msg.type) {
                case 'ready':
                    await updateWebview();
                    break;
                
                // NEW: Intercept RPC commands from the React UI
                case 'rpc_edit':
                    try {
                        isSaving = true; // <-- Mute the file watcher
                        const commandString = JSON.stringify(msg.payload);
                        
                        const result = await runBridgeJson(
                            this.context.extensionPath,
                            getCachedPythonExecutable(), 
                            ['ainb_rpc.py', '--file', document.uri.fsPath, '--command', commandString]
                        );

                        if (result.status === 'success') {
                            vscode.window.showInformationMessage(`Successfully executed: ${msg.payload.action}`);
                            
                            // THE NATIVE DISK FIX: Use Node 'fs' to bypass VS Code's VFS locks.
                            const buffer = Buffer.from(result.data, 'base64');
                            const targetPath = document.uri.fsPath;
                            
                            try {
                                // Attempt to write directly to the disk
                                fs.writeFileSync(targetPath, buffer);
                            } catch (writeErr: any) {
                                // If the ROMFS file is locked as Read-Only, force it to be writable and try again
                                if (writeErr.code === 'EPERM' || writeErr.code === 'EACCES') {
                                    fs.chmodSync(targetPath, 0o666); 
                                    fs.writeFileSync(targetPath, buffer);
                                } else {
                                    throw writeErr; // Rethrow if it's a different hard drive error
                                }
                            }

                            await updateWebview(); // Manually refresh the graph
                        } else {
                            vscode.window.showErrorMessage(`Python Error: ${result.message}`);
                        }
                    } catch (err) {
                        vscode.window.showErrorMessage(`Failed to run Python API: ${err}`);
                    } finally {
                        // Unmute the watcher after the VS Code file events pass by
                        setTimeout(() => { isSaving = false; }, 1000);
                    }
                    break;
            }
        });

        // Watch for raw JSON updates to live-refresh the webview graph
        const changeDocumentSubscription = vscode.workspace.onDidChangeTextDocument(async (e) => {
            if (isSaving) return; // <-- IGNORE EXTERNAL CHANGES TRIGGERED BY PYTHON

            if (e.document.uri.toString() === document.uri.toString()) {
                await updateWebview();
            }
        });

        webviewPanel.onDidDispose(() => {
            changeDocumentSubscription.dispose();
        });
    }

    private getWebviewHtml(webview: vscode.Webview): string {
        const distDir = path.join(this.context.extensionPath, 'editors', 'node-editor', 'dist');
        const indexPath = path.join(distDir, 'index.html');
        
        if (!fs.existsSync(indexPath)) {
            return `<!DOCTYPE html><html><body><h3>TOTK Node Editor</h3><p>Webview assets missing. Run <code>npm install && npm run build</code> in your React folder.</p></body></html>`;
        }

        let html = fs.readFileSync(indexPath, 'utf-8');
        html = html.replace(/(src|href)="([^"]+)"/g, (_match, attr: string, assetPath: string) => {
            if (assetPath.startsWith('http') || assetPath.startsWith('data:')) {
                return `${attr}="${assetPath}"`;
            }
            const normalized = assetPath.replace(/^\.?\//, ''); // removes leading / or ./
            const diskAsset = path.join(distDir, normalized);
            const webUri = webview.asWebviewUri(vscode.Uri.file(diskAsset));
            return `${attr}="${webUri.toString()}"`;
        });
        
        return html;
    }
}