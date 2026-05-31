import * as vscode from 'vscode';

interface TkprojContributor {
    Author: string;
    Contribution: string;
}

interface TkprojData {
    Mod: {
        Name: string;
        Author: string;
        Version: string;
        Description: string;
        Id: string;
        Contributors: TkprojContributor[];
        Dependencies: string[];
        Thumbnail?: { ThumbnailPath?: string };
    };
    Flags?: Record<string, unknown>;
    [key: string]: unknown;
}

export class TkprojEditorProvider implements vscode.CustomTextEditorProvider {
    public static readonly viewType = 'totk-editor.tkprojEditor';

    public static register(context: vscode.ExtensionContext): vscode.Disposable {
        return vscode.window.registerCustomEditorProvider(
            TkprojEditorProvider.viewType,
            new TkprojEditorProvider(context),
            { supportsMultipleEditorsPerDocument: false },
        );
    }

    constructor(_context: vscode.ExtensionContext) {}

    public async resolveCustomTextEditor(
        document: vscode.TextDocument,
        webviewPanel: vscode.WebviewPanel,
    ): Promise<void> {
        webviewPanel.webview.options = { enableScripts: true };

        if (document.getText().trim() === '') {
            const defaultData: TkprojData = {
                Mod: {
                    Name: "New Project",
                    Author: "Unknown",
                    Version: "1.0.0",
                    Description: "",
                    Id: generateUlidNumber(),
                    Contributors: [],
                    Dependencies: []
                },
                Flags: {
                    TrackRemovedRsDbEntries: false
                }
            };
            const edit = new vscode.WorkspaceEdit();
            edit.insert(document.uri, new vscode.Position(0, 0), JSON.stringify(defaultData, null, 2));
            await vscode.workspace.applyEdit(edit);
            await document.save();
        }

        let isUpdatingFromWebview = false;

        const update = () => {
            if (isUpdatingFromWebview) {
                return;
            }
            try {
                const data = JSON.parse(document.getText()) as TkprojData;
                webviewPanel.webview.html = buildHtml(data);
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
            contributors?: TkprojContributor[];
        }) => {
            if (msg.type === 'update' && msg.field && msg.value !== undefined) {
                const data = JSON.parse(document.getText()) as TkprojData;
                applyField(data, msg.field, msg.value as string);
                isUpdatingFromWebview = true;
                try {
                    await writeBack(document, data);
                } finally {
                    isUpdatingFromWebview = false;
                }
            } else if (msg.type === 'updateContributors' && msg.contributors) {
                const data = JSON.parse(document.getText()) as TkprojData;
                data.Mod.Contributors = msg.contributors;
                isUpdatingFromWebview = true;
                try {
                    await writeBack(document, data);
                } finally {
                    isUpdatingFromWebview = false;
                }
            } else if (msg.type === 'browseThumbnail') {
                const result = await vscode.window.showOpenDialog({
                    canSelectMany: false,
                    filters: { Images: ['png', 'jpg', 'jpeg', 'webp'] },
                    title: 'Select Thumbnail Image',
                });
                if (result?.[0]) {
                    const data = JSON.parse(document.getText()) as TkprojData;
                    if (!data.Mod.Thumbnail) {
                        data.Mod.Thumbnail = {};
                    }
                    data.Mod.Thumbnail.ThumbnailPath = result[0].fsPath;
                    await writeBack(document, data);
                }
            }
        });

        update();
    }
}

async function writeBack(document: vscode.TextDocument, data: TkprojData): Promise<void> {
    const edit = new vscode.WorkspaceEdit();
    edit.replace(
        document.uri,
        new vscode.Range(0, 0, document.lineCount, 0),
        JSON.stringify(data, null, 2),
    );
    await vscode.workspace.applyEdit(edit);
}

function applyField(data: TkprojData, field: string, value: string): void {
    switch (field) {
        case 'name': data.Mod.Name = value; break;
        case 'author': data.Mod.Author = value; break;
        case 'version': data.Mod.Version = value; break;
        case 'description': data.Mod.Description = value; break;
        case 'thumbnailPath':
            if (!data.Mod.Thumbnail) {
                data.Mod.Thumbnail = {};
            }
            data.Mod.Thumbnail.ThumbnailPath = value;
            break;
    }
}

function buildErrorHtml(raw: string): string {
    return `<!DOCTYPE html><html><body style="color:#ccc;background:#1e1e1e;padding:20px;">
<h2>Invalid .tkproj file</h2>
<pre style="white-space:pre-wrap;color:#e88;">${escHtml(raw.slice(0, 2000))}</pre>
</body></html>`;
}

function escHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function generateUlidNumber(): string {
    let id = '';
    for (let i = 0; i < 26; i++) {
        id += Math.floor(Math.random() * 10).toString();
    }
    if (id === '00000000000000000000000001') {
        return generateUlidNumber();
    }
    return id;
}

function buildContributorRows(contributors: TkprojContributor[]): string {
    if (!contributors.length) {
        return '';
    }
    return contributors.map((c, i) => /* html */`
        <div class="contrib-row" data-idx="${i}">
            <input type="text" class="contrib-name" placeholder="Name" value="${escHtml(c.Author ?? '')}"
                oninput="updateContrib()" />
            <input type="text" class="contrib-work" placeholder="Contribution (e.g. Models; Textures)"
                value="${escHtml(c.Contribution ?? '')}" oninput="updateContrib()" />
            <button class="btn btn-sm btn-danger" onclick="removeContrib(${i})">-</button>
        </div>`).join('');
}

function buildHtml(data: TkprojData): string {
    const mod = data.Mod;
    const thumbPath = mod.Thumbnail?.ThumbnailPath ?? '';
    const contribs = mod.Contributors ?? [];

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
    h1 .icon { font-size: 24px; }
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
    input[type="text"], textarea {
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
    input[type="text"]:focus, textarea:focus {
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
    .btn-sm { padding: 4px 10px; }
    .btn-danger { background: #a1260d; }
    .btn-danger:hover { background: #c4321d; }
    .contrib-row {
        display: flex;
        gap: 8px;
        margin-bottom: 8px;
        align-items: center;
    }
    .contrib-name { flex: 1; }
    .contrib-work { flex: 2; }
    .add-row { margin-top: 8px; }
</style>
</head>
<body>
    <h1>TKMM Project</h1>

    <div class="section">
        <div class="section-header">Mod Info</div>
        <div class="section-body">
            <div class="field">
                <label>Name</label>
                <input type="text" id="name" value="${escHtml(mod.Name ?? '')}"
                    oninput="send('name', this.value)" />
            </div>
            <div class="field">
                <label>Author</label>
                <input type="text" id="author" value="${escHtml(mod.Author ?? '')}"
                    oninput="send('author', this.value)" />
            </div>
            <div class="field">
                <label>Version</label>
                <input type="text" id="version" value="${escHtml(mod.Version ?? '')}"
                    oninput="send('version', this.value)" />
            </div>
            <div class="field">
                <label>Description (Markdown supported)</label>
                <textarea id="description"
                    oninput="send('description', this.value)">${escHtml(mod.Description ?? '')}</textarea>
            </div>
        </div>
    </div>

    <div class="section">
        <div class="section-header">Contributors</div>
        <div class="section-body">
            <div id="contribList">
                ${buildContributorRows(contribs)}
            </div>
            <div class="add-row">
                <button class="btn btn-sm" onclick="addContrib()">+ Add Contributor</button>
            </div>
        </div>
    </div>

    <div class="section">
        <div class="section-header">Thumbnail</div>
        <div class="section-body">
            <div class="field">
                <label>Thumbnail Path</label>
                <div class="thumb-row">
                    <input type="text" id="thumbnailPath" value="${escHtml(thumbPath)}"
                        oninput="send('thumbnailPath', this.value)" />
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

        function gatherContribs() {
            const rows = document.querySelectorAll('.contrib-row');
            const result = [];
            rows.forEach(row => {
                const name = row.querySelector('.contrib-name').value.trim();
                const work = row.querySelector('.contrib-work').value.trim();
                if (name) {
                    result.push({ Author: name, Contribution: work });
                }
            });
            return result;
        }

        function updateContrib() {
            vscode.postMessage({ type: 'updateContributors', contributors: gatherContribs() });
        }

        function addContrib() {
            const list = document.getElementById('contribList');
            const idx = list.children.length;
            const div = document.createElement('div');
            div.className = 'contrib-row';
            div.dataset.idx = idx;
            div.innerHTML =
                '<input type="text" class="contrib-name" placeholder="Name" oninput="updateContrib()" />' +
                '<input type="text" class="contrib-work" placeholder="Contribution (e.g. Models; Textures)" oninput="updateContrib()" />' +
                '<button class="btn btn-sm btn-danger" onclick="removeContrib(' + idx + ')">-</button>';
            list.appendChild(div);
        }

        function removeContrib(idx) {
            const rows = document.querySelectorAll('.contrib-row');
            if (rows[idx]) {
                rows[idx].remove();
            }
            updateContrib();
        }
    </script>
</body>
</html>`;
}
