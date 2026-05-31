import * as vscode from 'vscode';

let faIconsFullData: Record<string, { path: string; viewBox: string }> | null = null;
let faIconsCache: string[] | null = null;

async function getFaIconsData(context: vscode.ExtensionContext) {
    if (faIconsFullData && faIconsCache) {return { keys: faIconsCache, data: faIconsFullData };}
    try {
        const iconsPath = vscode.Uri.joinPath(context.extensionUri, 'vendor', 'fa-icons.json');
        const content = await vscode.workspace.fs.readFile(iconsPath);
        const text = new TextDecoder().decode(content);
        const parsed = JSON.parse(text) as Record<string, any>;
        
        const keys: string[] = [];
        const data: Record<string, { path: string; viewBox: string }> = {};
        
        for (const [name, iconObj] of Object.entries(parsed)) {
            keys.push(name);
            const svgData = iconObj.svg;
            if (svgData) {
                const styles = Object.keys(svgData);
                if (styles.length > 0) {
                    const style = styles[0]!;
                    const info = svgData[style];
                    if (info && info.path && info.viewBox) {
                        data[name] = { path: info.path, viewBox: info.viewBox.join(' ') };
                    }
                }
            }
        }
        keys.sort();
        faIconsCache = keys;
        faIconsFullData = data;
        return { keys, data };
    } catch (e) {
        console.error('Failed to load fa-icons.json:', e);
        return { keys: [], data: {} };
    }
}

interface InfoJsonData {
    Dependencies: string[];
    Type: number;
    IconName: string | null;
    Priority: number;
    IsEditing: boolean;
    Name: string;
    Description: string;
    Thumbnail: string | null;
    [key: string]: unknown;
}

export class InfoJsonEditorProvider implements vscode.CustomTextEditorProvider {
    public static readonly viewType = 'totk-editor.infoJsonEditor';

    public static register(context: vscode.ExtensionContext): vscode.Disposable {
        return vscode.window.registerCustomEditorProvider(
            InfoJsonEditorProvider.viewType,
            new InfoJsonEditorProvider(context),
            { supportsMultipleEditorsPerDocument: false },
        );
    }

    constructor(private readonly context: vscode.ExtensionContext) {}

    public async resolveCustomTextEditor(
        document: vscode.TextDocument,
        webviewPanel: vscode.WebviewPanel,
    ): Promise<void> {
        webviewPanel.webview.options = { enableScripts: true };

        const { keys: iconsList, data: iconsData } = await getFaIconsData(this.context);

        const update = () => {
            try {
                const data = JSON.parse(document.getText()) as InfoJsonData;
                webviewPanel.webview.html = buildHtml(data, iconsList, iconsData);
            } catch {
                webviewPanel.webview.html = buildErrorHtml(document.getText());
            }
        };

        const changeDocSub = vscode.workspace.onDidChangeTextDocument((e) => {
            if (e.document.uri.toString() === document.uri.toString()) {
                update();
            }
        });
        webviewPanel.onDidDispose(() => changeDocSub.dispose());

        webviewPanel.webview.onDidReceiveMessage(async (msg: {
            type: string;
            field?: string;
            value?: unknown;
        }) => {
            if (msg.type === 'update' && msg.field && msg.value !== undefined) {
                try {
                    const data = JSON.parse(document.getText()) as InfoJsonData;
                    applyField(data, msg.field, msg.value as string);
                    await writeBack(document, data);
                } catch {
                    // Ignore JSON parsing errors while editing
                }
            }
            if (msg.type === 'browseThumbnail') {
                const result = await vscode.window.showOpenDialog({
                    canSelectMany: false,
                    filters: { Images: ['png', 'jpg', 'jpeg', 'webp'] },
                    title: 'Select Thumbnail Image',
                });
                if (result?.[0]) {
                    try {
                        const data = JSON.parse(document.getText()) as InfoJsonData;
                        data.Thumbnail = result[0].fsPath;
                        await writeBack(document, data);
                    } catch {
                        // Ignore JSON parsing errors while editing
                    }
                }
            }
        });

        update();
    }
}

async function writeBack(document: vscode.TextDocument, data: InfoJsonData): Promise<void> {
    const edit = new vscode.WorkspaceEdit();
    edit.replace(
        document.uri,
        new vscode.Range(0, 0, document.lineCount, 0),
        JSON.stringify(data, null, 4),
    );
    await vscode.workspace.applyEdit(edit);
}

function applyField(data: InfoJsonData, field: string, value: string): void {
    switch (field) {
        case 'name': data.Name = value; break;
        case 'description': data.Description = value; break;
        case 'type': data.Type = parseInt(value, 10); break;
        case 'iconName': data.IconName = value || null; break;
        case 'thumbnail': data.Thumbnail = value || null; break;
    }
}

function buildErrorHtml(raw: string): string {
    return `<!DOCTYPE html><html><body style="color:#ccc;background:#1e1e1e;padding:20px;">
<h2>Invalid info.json file</h2>
<pre style="white-space:pre-wrap;color:#e88;">${escHtml(raw.slice(0, 2000))}</pre>
</body></html>`;
}

function escHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildHtml(data: InfoJsonData, iconsList: string[], iconsData: Record<string, { path: string; viewBox: string }>): string {
    const name = data.Name ?? '';
    const desc = data.Description ?? '';
    const type = data.Type ?? 0;
    const icon = data.IconName ?? '';
    const thumbPath = data.Thumbnail ?? '';

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
        font-family: var(--vscode-font-family, 'Segoe UI', sans-serif);
        font-size: 13px;
        color: var(--vscode-foreground, #ccc);
        background: var(--vscode-editor-background, #1e1e1e);
        padding: 24px 32px;
        max-width: 700px;
    }
    h1 {
        font-size: 20px;
        font-weight: 600;
        margin-bottom: 20px;
        color: var(--vscode-foreground, #eee);
        display: flex;
        align-items: center;
        gap: 10px;
    }
    .section {
        margin-bottom: 20px;
        border: 1px solid var(--vscode-panel-border, #333);
        border-radius: 6px;
        overflow: hidden;
    }
    .section-header {
        background: var(--vscode-sideBarSectionHeader-background, #252526);
        padding: 8px 14px;
        font-size: 12px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        color: var(--vscode-sideBarSectionHeader-foreground, #bbb);
    }
    .section-body { padding: 14px; }
    .field { margin-bottom: 14px; }
    .field:last-child { margin-bottom: 0; }
    label {
        display: block;
        font-size: 12px;
        color: var(--vscode-descriptionForeground, #999);
        margin-bottom: 4px;
        font-weight: 500;
    }
    input[type="text"], textarea, select {
        width: 100%;
        background: var(--vscode-input-background, #3c3c3c);
        color: var(--vscode-input-foreground, #ccc);
        border: 1px solid var(--vscode-input-border, #555);
        border-radius: 3px;
        padding: 6px 10px;
        font-family: inherit;
        font-size: 13px;
        outline: none;
    }
    input[type="text"]:focus, textarea:focus, select:focus {
        border-color: var(--vscode-focusBorder, #007fd4);
    }
    textarea {
        min-height: 100px;
        resize: vertical;
    }
    .thumb-row {
        display: flex;
        align-items: center;
        gap: 10px;
    }
    .thumb-row input { flex: 1; }
    .icon-row {
        display: flex;
        align-items: center;
        gap: 10px;
    }
    .icon-row input { flex: 1; }
    .icon-preview {
        width: 24px;
        height: 24px;
        fill: currentColor;
        flex-shrink: 0;
        display: flex;
        justify-content: center;
        align-items: center;
    }
    .icon-preview svg {
        max-width: 100%;
        max-height: 100%;
    }
    .btn {
        background: var(--vscode-button-background, #0e639c);
        color: var(--vscode-button-foreground, #fff);
        border: none;
        padding: 5px 14px;
        border-radius: 3px;
        cursor: pointer;
        font-size: 12px;
        font-family: inherit;
        white-space: nowrap;
    }
    .btn:hover { background: var(--vscode-button-hoverBackground, #1177bb); }
</style>
</head>
<body>
    <h1>TKMM Option Config</h1>

    <div class="section">
        <div class="section-header">Info</div>
        <div class="section-body">
            <div class="field">
                <label>Name</label>
                <input type="text" id="name" value="${escHtml(name)}"
                    onchange="send('name', this.value)" />
            </div>
            <div class="field">
                <label>Description</label>
                <textarea id="description"
                    onchange="send('description', this.value)">${escHtml(desc)}</textarea>
            </div>
            <div class="field">
                <label>Type</label>
                <select id="type" onchange="send('type', this.value)">
                    <option value="0" ${type === 0 ? 'selected' : ''}>Multi (0)</option>
                    <option value="1" ${type === 1 ? 'selected' : ''}>MultiRequired (1)</option>
                    <option value="2" ${type === 2 ? 'selected' : ''}>Single (2)</option>
                    <option value="3" ${type === 3 ? 'selected' : ''}>SingleRequired (3)</option>
                </select>
            </div>
        </div>
    </div>

    <div class="section">
        <div class="section-header">Assets</div>
        <div class="section-body">
            <div class="field">
                <label>Icon (FontAwesome Name)</label>
                <div class="icon-row">
                    <div class="icon-preview">
                        ${icon && iconsData[icon] ? `<svg viewBox="${iconsData[icon].viewBox}"><path d="${iconsData[icon].path}"></path></svg>` : ''}
                    </div>
                    <input type="text" id="iconName" list="icon-list" value="${escHtml(icon)}"
                        onchange="send('iconName', this.value)" />
                    <datalist id="icon-list">
                        ${iconsList.map(i => `<option value="${escHtml(i)}"></option>`).join('\n                        ')}
                    </datalist>
                </div>
            </div>
            <div class="field">
                <label>Thumbnail Path</label>
                <div class="thumb-row">
                    <input type="text" id="thumbnail" value="${escHtml(thumbPath)}"
                        onchange="send('thumbnail', this.value)" />
                    <button class="btn" onclick="browse()">Browse...</button>
                </div>
            </div>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();

        function send(field, value) {
            vscode.postMessage({ type: 'update', field, value });
        }

        function browse() {
            vscode.postMessage({ type: 'browseThumbnail' });
        }
    </script>
</body>
</html>`;
}
