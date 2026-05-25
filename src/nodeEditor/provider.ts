import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { runBridgeJson } from '../bridge';
import { getCachedPythonExecutable } from '../pythonEnv';
import { resolveRomfsPath } from '../romfs';
import { NodeEditorAdapterRegistry } from './registry';
import type { AdapterParseResult, NodeRoleColor } from './types';

type NodeEditorMessage =
    | { type: 'ready' }
    | { type: 'requestSaveScaffold' };

const VIEW_TYPE = 'totk-editor.ainbNodeEditor';

type AinbDefsBridgePayload = {
    sourcePath: string;
    definitions: Array<{
        name: string;
        tags: string[];
        eventColor?: string;
    }>;
};

type RuntimeAinbDef = {
    tags: string[];
    eventColor?: NodeRoleColor;
};

function normalizeRoleColor(value: string | undefined): NodeRoleColor | undefined {
    switch ((value ?? '').trim().toLowerCase()) {
        case 'blue':
        case 'red':
        case 'green':
        case 'brown':
        case 'purple':
        case 'gray':
        case 'notimplemented':
            return value!.trim().toLowerCase() as NodeRoleColor;
        default:
            return undefined;
    }
}

export class AinbNodeEditorProvider implements vscode.CustomTextEditorProvider {
    private readonly registry: NodeEditorAdapterRegistry;
    private readonly output = vscode.window.createOutputChannel('TOTK Node Editor');
    private runtimeDefsCache:
        | {
            romfsPath: string;
            sourcePath: string;
            defs: Map<string, RuntimeAinbDef>;
        }
        | undefined;

    constructor(private readonly context: vscode.ExtensionContext) {
        this.registry = new NodeEditorAdapterRegistry(
            context.extensionPath,
            () => this.getRuntimeAinbDefs(),
        );
    }

    static register(context: vscode.ExtensionContext): vscode.Disposable {
        const provider = new AinbNodeEditorProvider(context);
        return vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider);
    }

    private getRuntimeAinbDefs(): Map<string, RuntimeAinbDef> | undefined {
        const python = getCachedPythonExecutable();
        if (!python) {
            return undefined;
        }
        const romfsPath = resolveRomfsPath();
        if (!romfsPath) {
            return undefined;
        }

        if (this.runtimeDefsCache?.romfsPath === romfsPath) {
            return this.runtimeDefsCache.defs;
        }

        const bridgePath = path.join(this.context.extensionPath, 'python', 'totk_bridge.py');
        try {
            const payload = runBridgeJson<AinbDefsBridgePayload>(
                python,
                bridgePath,
                ['ainb-defs'],
                undefined,
                {
                    ...process.env,
                    TOTK_EDITOR_ROMFS: romfsPath,
                },
            );
            const defs = new Map<string, RuntimeAinbDef>();
            for (const definition of payload.definitions) {
                const name = definition.name?.trim();
                if (!name) {
                    continue;
                }
                defs.set(name, {
                    tags: Array.isArray(definition.tags)
                        ? definition.tags.map((tag) => String(tag))
                        : [],
                    eventColor: normalizeRoleColor(definition.eventColor),
                });
            }
            this.runtimeDefsCache = {
                romfsPath,
                sourcePath: payload.sourcePath,
                defs,
            };
            this.output.appendLine(
                `[defs] loaded ${defs.size} runtime node definitions from ${payload.sourcePath}`,
            );
            return defs;
        } catch (error) {
            const message =
                error instanceof Error
                    ? `${error.name}: ${error.message || '(no error message)'}`
                    : String(error);
            this.output.appendLine(`[defs] runtime node definitions unavailable: ${message}`);
            return undefined;
        }
    }

    async resolveCustomTextEditor(
        document: vscode.TextDocument,
        webviewPanel: vscode.WebviewPanel,
    ): Promise<void> {
        const adapter = this.registry.getForUri(document.uri);
        if (!adapter) {
            throw new Error(`No node editor adapter for ${document.uri.fsPath}`);
        }
        let adapterResult: AdapterParseResult;
        try {
            adapterResult = adapter.parse(document.uri.fsPath, document.getText());
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.output.appendLine(`[parse-error] ${document.uri.fsPath}: ${message}`);
            webviewPanel.webview.html = `<!DOCTYPE html><html><body><h3>TOTK AINB Node Editor</h3><p>Failed to parse AINB JSON model.</p><pre>${message}</pre><p>Reopen with the text editor to inspect raw content.</p></body></html>`;
            return;
        }

        webviewPanel.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this.context.extensionUri, 'editors', 'node-editor', 'dist'),
            ],
        };
        webviewPanel.webview.html = this.getWebviewHtml(webviewPanel.webview);

        webviewPanel.webview.onDidReceiveMessage(async (message: NodeEditorMessage) => {
            if (message.type === 'ready') {
                await webviewPanel.webview.postMessage({
                    type: 'init',
                    payload: adapterResult.model,
                });
                return;
            }
            if (message.type === 'requestSaveScaffold') {
                // Phase 1: read-only viewer. We keep no-op serializer scaffold to verify
                // adapter output path remains stable for future editable phase.
                const serialized = adapter.serializeNoop(adapterResult);
                this.output.appendLine(
                    `[save-scaffold] ${document.uri.fsPath} serialized bytes=${serialized.length}`,
                );
                await webviewPanel.webview.postMessage({
                    type: 'saveScaffoldResult',
                    payload: {
                        success: true,
                    },
                });
            }
        });
    }

    private getWebviewHtml(webview: vscode.Webview): string {
        const distDir = path.join(this.context.extensionPath, 'editors', 'node-editor', 'dist');
        const indexPath = path.join(distDir, 'index.html');
        if (!fs.existsSync(indexPath)) {
            return `<!DOCTYPE html><html><body><h3>TOTK Node Editor</h3><p>Webview assets missing. Run <code>npm --prefix editors/node-editor install && npm --prefix editors/node-editor run build</code>.</p></body></html>`;
        }

        let html = fs.readFileSync(indexPath, 'utf-8');
        html = html.replace(/(src|href)="([^"]+)"/g, (_match, attr: string, assetPath: string) => {
            if (
                assetPath.startsWith('http://') ||
                assetPath.startsWith('https://') ||
                assetPath.startsWith('data:')
            ) {
                return `${attr}="${assetPath}"`;
            }
            const normalized = assetPath.startsWith('/')
                ? assetPath.slice(1)
                : assetPath.replace(/^\.\//, '');
            const diskAsset = path.join(distDir, normalized);
            const webUri = webview.asWebviewUri(vscode.Uri.file(diskAsset));
            return `${attr}="${webUri.toString()}"`;
        });
        return html;
    }
}

export const AINB_NODE_EDITOR_VIEW_TYPE = VIEW_TYPE;
