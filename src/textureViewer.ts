import * as vscode from 'vscode';
import type { BntxTextureResult } from './bridge';

const panels = new Map<string, vscode.WebviewPanel>();

export function openTextureViewer(
    textureName: string,
    result: BntxTextureResult,
): void {
    const key = textureName;
    const existing = panels.get(key);
    if (existing) {
        existing.reveal();
        existing.webview.html = buildHtml(result);
        return;
    }

    const panel = vscode.window.createWebviewPanel(
        'totkTextureViewer',
        `Texture: ${textureName}`,
        vscode.ViewColumn.Active,
        { enableScripts: true, retainContextWhenHidden: false },
    );

    panel.webview.html = buildHtml(result);
    panels.set(key, panel);
    panel.onDidDispose(() => panels.delete(key));
}

function buildHtml(result: BntxTextureResult): string {
    const meta = result.metadata;
    const imgSrc = result.pngBase64
        ? `data:image/png;base64,${result.pngBase64}`
        : '';

    const metaRows = meta
        ? [
              row('Name', meta.name),
              row('Width', String(meta.width)),
              row('Height', String(meta.height)),
              row('Format', `${meta.format} (${meta.formatId})`),
              row('Mip Count', String(meta.mipCount)),
              row('Tile Mode', meta.tileMode),
              row('Block Height', `${meta.blockH} (log2=${meta.blockHLog2})`),
              row('Image Size', formatBytes(meta.dataSize)),
          ].join('')
        : '<tr><td colspan="2">No metadata available</td></tr>';

    const errorNote = !result.pngBase64
        ? '<p style="color:#e8a040;margin-top:12px;">Rendering failed — check the developer console for details.</p>'
        : '';

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
        display: flex;
        gap: 24px;
        padding: 20px;
        min-height: 100vh;
    }
    .image-panel {
        flex: 0 0 auto;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 8px;
    }
    .image-panel img {
        image-rendering: pixelated;
        background: repeating-conic-gradient(#333 0% 25%, #222 0% 50%) 0 0 / 16px 16px;
        border: 1px solid var(--vscode-panel-border, #444);
    }
    .image-panel img.scaled {
        width: 256px;
        height: 256px;
    }
    .no-image {
        width: 256px;
        height: 256px;
        display: flex;
        align-items: center;
        justify-content: center;
        background: #222;
        border: 1px solid #444;
        color: #888;
    }
    .size-toggle {
        background: var(--vscode-button-background, #0e639c);
        color: var(--vscode-button-foreground, #fff);
        border: none;
        padding: 4px 12px;
        border-radius: 3px;
        cursor: pointer;
        font-size: 12px;
        font-family: inherit;
    }
    .size-toggle:hover {
        background: var(--vscode-button-hoverBackground, #1177bb);
    }
    .props-panel { flex: 1 1 auto; min-width: 250px; }
    .props-panel h2 {
        font-size: 14px;
        font-weight: 600;
        margin-bottom: 8px;
        color: var(--vscode-foreground, #ddd);
        border-bottom: 1px solid var(--vscode-panel-border, #444);
        padding-bottom: 6px;
    }
    table { width: 100%; border-collapse: collapse; }
    td {
        padding: 4px 8px;
        border-bottom: 1px solid var(--vscode-panel-border, #333);
        vertical-align: top;
    }
    td:first-child {
        color: var(--vscode-descriptionForeground, #999);
        white-space: nowrap;
        width: 110px;
    }
    td:last-child {
        color: var(--vscode-foreground, #ddd);
        font-weight: 500;
    }
</style>
</head>
<body>
    <div class="image-panel">
        ${imgSrc
            ? `<img id="texImg" class="scaled" src="${imgSrc}" alt="${meta?.name ?? 'texture'}" />`
            : '<div class="no-image">No preview</div>'}
        ${imgSrc
            ? `<button class="size-toggle" id="sizeBtn" onclick="toggleSize()">Show Original Size</button>`
            : ''}
    </div>
    <div class="props-panel">
        <h2>Image Info</h2>
        <table>${metaRows}</table>
        ${errorNote}
    </div>
    <script>
        let scaled = true;
        function toggleSize() {
            const img = document.getElementById('texImg');
            const btn = document.getElementById('sizeBtn');
            if (!img || !btn) return;
            scaled = !scaled;
            if (scaled) {
                img.classList.add('scaled');
                btn.textContent = 'Show Original Size';
            } else {
                img.classList.remove('scaled');
                btn.textContent = 'Show 256x256';
            }
        }
    </script>
</body>
</html>`;
}

function row(label: string, value: string): string {
    return `<tr><td>${label}</td><td>${value}</td></tr>`;
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) {
        return `${bytes} B`;
    }
    if (bytes < 1024 * 1024) {
        return `${(bytes / 1024).toFixed(1)} KB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
