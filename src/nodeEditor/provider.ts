import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os'; // <-- WE NEED THIS NOW
import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as util from 'util';
import { NodeEditorAdapterRegistry } from './registry';
import { getCachedPythonExecutable } from '../pythonEnv';

const execPromise = util.promisify(cp.exec);

function getPython(): string {
    return getCachedPythonExecutable() ?? 'python';
}

async function runBridgeJson(extensionPath: string, pythonExe: string, args: string[]): Promise<any> {
    const scriptPath = path.join(extensionPath, 'python', args[0]);   
    const commandArgs = [scriptPath, ...args.slice(1)].map(arg => `"${arg.replace(/"/g, '\\"')}"`).join(' ');
    
    try {
        const { stdout, stderr } = await execPromise(`"${pythonExe}" ${commandArgs}`);
        if (stderr && stderr.trim()) console.warn("Python warning:", stderr);
        return JSON.parse(stdout.trim());
    } catch (execError: any) {
        const pythonError = execError.stderr ? execError.stderr.trim() : execError.message;
        throw new Error(`Python Bridge Error:\n${pythonError}`);
    }
}

// 1. THE ARCHITECTURE SHIFT: Working OS-Level Temp Files
class AinbDocument implements vscode.CustomDocument {
    public readonly tmpPath: string;
    
    constructor(public readonly uri: vscode.Uri) {
        // Give every open document a unique, hidden working file
        const fileName = path.basename(uri.fsPath);
        this.tmpPath = path.join(os.tmpdir(), `totk_${Date.now()}_${fileName}`);
        
        // Initialize the working copy with the original ROMFS data
        fs.copyFileSync(uri.fsPath, this.tmpPath);
    }
    
    dispose(): void {
        // Clean up the temp file when you actually close the tab
        if (fs.existsSync(this.tmpPath)) {
            fs.unlinkSync(this.tmpPath);
        }
    }
}

const VIEW_TYPE = 'totk-editor.ainbNodeEditor';

export class AinbNodeEditorProvider implements vscode.CustomEditorProvider<AinbDocument> {
    private readonly registry: NodeEditorAdapterRegistry;

    private readonly _onDidChangeCustomDocument = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<AinbDocument>>();
    public readonly onDidChangeCustomDocument = this._onDidChangeCustomDocument.event;

    constructor(private readonly context: vscode.ExtensionContext) {
        this.registry = new NodeEditorAdapterRegistry(context.extensionPath);
    }

    public static register(context: vscode.ExtensionContext): vscode.Disposable {
        const provider = new AinbNodeEditorProvider(context);
        return vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
            webviewOptions: { retainContextWhenHidden: true },
        });
    }

    public async openCustomDocument(uri: vscode.Uri): Promise<AinbDocument> {
        return new AinbDocument(uri);
    }
    
    // 2. NATIVE SAVE LOGIC
    public async saveCustomDocument(document: AinbDocument): Promise<void> {
        const targetPath = document.uri.fsPath;
        
        // Break the ROMFS Read-Only Lock
        try { fs.accessSync(targetPath, fs.constants.W_OK); } 
        catch (e) { fs.chmodSync(targetPath, 0o666); }
        
        // Push from the Temp file back to the actual Hard Drive
        fs.copyFileSync(document.tmpPath, targetPath);
    }
    
    public async saveCustomDocumentAs(document: AinbDocument, destination: vscode.Uri): Promise<void> {
        fs.copyFileSync(document.tmpPath, destination.fsPath);
    }
    
    public async revertCustomDocument(document: AinbDocument): Promise<void> {
        // If the user discards changes, overwrite the Temp file with original file
        fs.copyFileSync(document.uri.fsPath, document.tmpPath);
    }
    
    public async backupCustomDocument(document: AinbDocument, context: vscode.CustomDocumentBackupContext): Promise<vscode.CustomDocumentBackup> {
        fs.copyFileSync(document.tmpPath, context.destination.fsPath);
        return { id: context.destination.toString(), delete: () => {} };
    }

    public async resolveCustomEditor(
        document: AinbDocument,
        webviewPanel: vscode.WebviewPanel,
        _token: vscode.CancellationToken
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

        const updateWebview = async () => {
            try {
                webviewPanel.webview.postMessage({ type: 'status', payload: { text: 'Reading document...', progress: 10 } });
                
                // 3. READ FROM THE TEMP FILE, NEVER THE REAL DISK!
                const isBinary = document.uri.fsPath.toLowerCase().endsWith('.ainb');
                let rawText = "";

                if (isBinary) {
                    webviewPanel.webview.postMessage({ type: 'status', payload: { text: 'Decoding working data...', progress: 30 } });
                    const commandString = JSON.stringify({ action: "to_json" });
                    const result = await runBridgeJson(
                        this.context.extensionPath,
                        getPython(),
                        ['ainb_rpc.py', '--file', document.tmpPath, '--command', commandString]
                    );
                    
                    if (result.status !== 'success') throw new Error(`Python RPC failed: ${result.message}`);
                    rawText = typeof result.data === 'string' ? result.data : JSON.stringify(result.data);
                } else {
                    rawText = fs.readFileSync(document.tmpPath, 'utf8');
                }

                webviewPanel.webview.postMessage({ type: 'status', payload: { text: 'Calculating layout...', progress: 80 } });
                
                const parsed = adapter.parse(document.uri.fsPath, rawText);
                
                webviewPanel.webview.postMessage({ type: 'status', payload: { text: 'Rendering...', progress: 95 } });
                webviewPanel.webview.postMessage({ type: 'init', payload: parsed.model });

            } catch (err: any) {
                webviewPanel.webview.postMessage({ type: 'error', payload: { message: err.message } });
            }
        };

        webviewPanel.webview.onDidReceiveMessage(async (msg: any) => {
            switch (msg.type) {
                case 'ready':
                    await updateWebview();
                    break;
                
                case 'rpc_edit':
                    try {
                        const commandString = JSON.stringify(msg.payload);
                        
                        // 4. PYTHON EDITS THE TEMP FILE
                        const result = await runBridgeJson(
                            this.context.extensionPath,
                            getPython(),
                            ['ainb_rpc.py', '--file', document.uri.fsPath, '--command', commandString]
                        );

                        if (result.status === 'success') {
                            // 5. WRITE PYTHON'S NEW BINARY BACK TO THE TEMP FILE
                            // This ensures edits "stack" and Python doesn't overwrite your previous clicks!
                            const buffer = Buffer.from(result.data, 'base64');
                            fs.writeFileSync(document.tmpPath, buffer);
                            
                            // Tell VS Code we have unsaved changes (creates the white dot)
                            this._onDidChangeCustomDocument.fire({
                                document,
                                undo: () => {},
                                redo: () => {}
                            });

                            // 6. UPDATE REACT. Because it reads tmpPath now, the UI will 
                            // perfectly match the edits instead of resetting!
                            await updateWebview();
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

    private getWebviewHtml(webview: vscode.Webview): string {
        const distDir = path.join(this.context.extensionPath, 'editors', 'node-editor', 'dist');
        const indexPath = path.join(distDir, 'index.html');
        
        if (!fs.existsSync(indexPath)) return `<!DOCTYPE html><html><body><h3>TOTK Node Editor</h3><p>Webview assets missing.</p></body></html>`;

        let html = fs.readFileSync(indexPath, 'utf-8');
        html = html.replace(/(src|href)="([^"]+)"/g, (_match, attr: string, assetPath: string) => {
            if (assetPath.startsWith('http') || assetPath.startsWith('data:')) return `${attr}="${assetPath}"`;
            const normalized = assetPath.replace(/^\.?\//, '');
            const diskAsset = path.join(distDir, normalized);
            const webUri = webview.asWebviewUri(vscode.Uri.file(diskAsset));
            return `${attr}="${webUri.toString()}"`;
        });
        
        return html;
    }
}