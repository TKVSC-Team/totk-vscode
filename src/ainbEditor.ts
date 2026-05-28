import * as vscode from 'vscode';
import * as path from 'path';
import { runBridgeJsonAsync } from './bridge';
import { getCachedPythonExecutable } from './pythonEnv';

class AinbDocument implements vscode.CustomDocument {
    constructor(
        public readonly uri: vscode.Uri,
        public graphData: unknown,
        public readonly onDispose: () => void
    ) {}

    dispose(): void {
        this.onDispose();
    }
}

export class AinbEditorProvider implements vscode.CustomEditorProvider<AinbDocument> {
    public static readonly viewType = 'totk-editor.ainbEditor';

    private readonly _onDidChangeCustomDocument = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<AinbDocument>>();
    public readonly onDidChangeCustomDocument = this._onDidChangeCustomDocument.event;

    public static register(context: vscode.ExtensionContext): vscode.Disposable {
        return vscode.window.registerCustomEditorProvider(
            AinbEditorProvider.viewType,
            new AinbEditorProvider(context),
            {
                supportsMultipleEditorsPerDocument: false,
                webviewOptions: {
                    retainContextWhenHidden: true,
                }
            }
        );
    }

    constructor(private readonly context: vscode.ExtensionContext) {}

    public async openCustomDocument(
        uri: vscode.Uri,
        openContext: vscode.CustomDocumentOpenContext,
        token: vscode.CancellationToken
    ): Promise<AinbDocument> {
        const pythonExe = getCachedPythonExecutable();
        if (!pythonExe) {
            throw new Error('Python environment not set. Please set it in settings.');
        }

        const bridgePath = path.join(this.context.extensionPath, 'python', 'ainb_bridge.py');
        let graphData: unknown = null;
        try {
            const result = await runBridgeJsonAsync<{success: boolean, data?: unknown, error?: string}>(
                pythonExe,
                bridgePath,
                ['read', uri.fsPath]
            );
            if (!result.success) {
                throw new Error(result.error ?? 'Unknown error parsing AINB');
            }
            graphData = result.data;
        } catch (e: any) {
            vscode.window.showErrorMessage(`Failed to read AINB file: ${e.message}`);
            // Provide an empty structure so it still opens
            graphData = { version: 0, nodes: [], error: e.message };
        }

        const document = new AinbDocument(uri, graphData, () => {});
        return document;
    }

    public async resolveCustomEditor(
        document: AinbDocument,
        webviewPanel: vscode.WebviewPanel,
        token: vscode.CancellationToken
    ): Promise<void> {
        webviewPanel.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this.context.extensionUri, 'editors', 'ainb-node', 'dist')
            ]
        };

        webviewPanel.webview.html = this.getHtmlForWebview(webviewPanel.webview);

        webviewPanel.webview.onDidReceiveMessage(async (msg) => {
            if (msg.type === 'ready') {
                webviewPanel.webview.postMessage({
                    type: 'load',
                    data: document.graphData
                });
            } else if (msg.type === 'get-palette') {
                const pythonExe = getCachedPythonExecutable();
                if (pythonExe) {
                    const bridgePath = path.join(this.context.extensionPath, 'python', 'ainb_bridge.py');
                    try {
                        const result = await runBridgeJsonAsync<{success: boolean, data?: any}>(
                            pythonExe,
                            bridgePath,
                            ['get-palette']
                        );
                        if (result.success) {
                            webviewPanel.webview.postMessage({
                                type: 'palette',
                                data: result.data
                            });
                        }
                    } catch (e) {
                        console.error('Failed to get palette', e);
                    }
                }
            } else if (msg.type === 'save') {
                // TODO: Save logic
                vscode.window.showInformationMessage('AINB Save not fully implemented yet.');
            }
        });
    }

    public async saveCustomDocument(document: AinbDocument, cancellation: vscode.CancellationToken): Promise<void> {
        // Implement save logic via ainb_bridge.py
    }

    public async saveCustomDocumentAs(document: AinbDocument, destination: vscode.Uri, cancellation: vscode.CancellationToken): Promise<void> {
        // Implement saveAs logic
    }

    public async revertCustomDocument(document: AinbDocument, cancellation: vscode.CancellationToken): Promise<void> {
        // Implement revert logic
    }

    public backupCustomDocument(document: AinbDocument, context: vscode.CustomDocumentBackupContext, cancellation: vscode.CancellationToken): Promise<vscode.CustomDocumentBackup> {
        return Promise.resolve({ id: document.uri.toString(), delete: () => {} });
    }

    private getHtmlForWebview(webview: vscode.Webview): string {
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'editors', 'ainb-node', 'dist', 'assets', 'index.js'));
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'editors', 'ainb-node', 'dist', 'assets', 'index.css'));

        // Normally Vite outputs hashed filenames, but we'll configure Vite to output fixed names `index.js` and `index.css`.
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>AINB Editor</title>
    <link rel="stylesheet" href="${styleUri}">
</head>
<body>
    <div id="root"></div>
    <script type="module" src="${scriptUri}"></script>
</body>
</html>`;
    }
}
