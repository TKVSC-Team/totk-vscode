import * as vscode from 'vscode';
import type { BntxTextureResult, BntxChannelInfo, BntxImageInfo, BntxMiscInfo } from './bridge';
import * as fs from 'fs';
import * as path from 'path';

const panels = new Map<string, vscode.WebviewPanel>();
const panelTempFiles = new Map<string, string>();
let extensionUri: vscode.Uri | undefined;

export function initTextureViewer(extUri: vscode.Uri): void {
    extensionUri = extUri;
}

export function openTextureViewer(
    textureName: string,
    result: BntxTextureResult,
    diskArchive?: string,
    filePath?: string,
    onSave?: (data: any) => Promise<void>
): void {
    const key = textureName;
    const existing = panels.get(key);
    
    if (existing) {
        // We are replacing the content of an existing panel.
        // Clean up the previous temp file so it doesn't leak.
        const oldTempFile = panelTempFiles.get(key);
        if (oldTempFile && oldTempFile !== result.pngPath) {
            try {
                fs.unlinkSync(oldTempFile);
            } catch { }
        }
        
        if (result.pngPath) {
            panelTempFiles.set(key, result.pngPath);
        } else {
            panelTempFiles.delete(key);
        }

        existing.reveal();
        existing.webview.html = buildHtml(result, existing.webview);
        return;
    }

    if (result.pngPath) {
        panelTempFiles.set(key, result.pngPath);
    }

    const localRoots = extensionUri
        ? [vscode.Uri.joinPath(extensionUri, 'icons')]
        : [];
    if (result.pngPath) {
        localRoots.push(vscode.Uri.file(path.dirname(result.pngPath)));
    }

    const panel = vscode.window.createWebviewPanel(
        'totkTextureViewer',
        `Texture: ${textureName}`,
        vscode.ViewColumn.Active,
        { enableScripts: true, retainContextWhenHidden: false, localResourceRoots: localRoots },
    );

    panel.webview.html = buildHtml(result, panel.webview);
    panels.set(key, panel);
    panel.onDidDispose(() => {
        panels.delete(key);
        const currentTempFile = panelTempFiles.get(key);
        if (currentTempFile) {
            try {
                fs.unlinkSync(currentTempFile);
            } catch { }
            panelTempFiles.delete(key);
        }
    });

    panel.webview.onDidReceiveMessage(async (message) => {
        if (message.type === 'save-metadata' && onSave) {
            try {
                await onSave(message.data);
                vscode.window.showInformationMessage('Texture metadata saved successfully!');
            } catch (e) {
                const err = e instanceof Error ? e.message : String(e);
                vscode.window.showErrorMessage(`Failed to save metadata: ${err}`);
            }
        }
    });
}

function buildHtml(result: BntxTextureResult, webview: vscode.Webview): string {
    const meta = result.metadata;
    let imgSrc = '';
    if (result.pngPath) {
        imgSrc = webview.asWebviewUri(vscode.Uri.file(result.pngPath)).toString();
    } else if (result.pngBase64) {
        imgSrc = `data:image/png;base64,${result.pngBase64}`;
    }

    const resizeIconUri = extensionUri
        ? webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'icons', 'resize.svg'))
        : '';

    const texW = meta?.imageInfo?.width ?? 256;
    const texH = meta?.imageInfo?.height ?? 256;
    const maxDim = 256;
    const scale = maxDim / Math.max(texW, texH);
    const scaledW = Math.round(texW * scale);
    const scaledH = Math.round(texH * scale);

    const channelsSection = meta?.channels
        ? buildSection('Channels', buildChannelRows(meta.channels))
        : '';
    const imageInfoSection = meta?.imageInfo
        ? buildSection('Image Info', buildImageInfoRows(meta.imageInfo))
        : '';
    const miscSection = meta?.misc
        ? buildSection('Misc', buildMiscRows(meta.misc))
        : '';
    const metaSections = meta
        ? `${channelsSection}${imageInfoSection}${miscSection}`
        : '<p style="color:#888;">No metadata available</p>';

    const errorText = result.error ?? 'Rendering failed for this texture variant.';
    const errorNote = !imgSrc
        ? `<p style="color:#e8a040;margin-top:12px;">${escapeHtml(errorText)}</p>`
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
        align-items: flex-start;
        gap: 0;
    }
    .image-toolbar {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 0 0 6px 0;
    }
    .size-toggle {
        width: 28px;
        height: 28px;
        display: flex;
        align-items: center;
        justify-content: center;
        background: var(--vscode-toolbar-hoverBackground, rgba(90,93,94,.31));
        color: var(--vscode-foreground, #ccc);
        border: 1px solid transparent;
        border-radius: 4px;
        cursor: pointer;
        padding: 0;
    }
    .size-toggle:hover {
        background: var(--vscode-toolbar-activeBackground, rgba(99,102,103,.31));
        border-color: var(--vscode-panel-border, #444);
    }
    .size-toggle img { width: 16px; height: 16px; }
    .size-label {
        font-size: 11px;
        color: var(--vscode-descriptionForeground, #999);
        user-select: none;
    }
    .checker-bg {
        background: repeating-conic-gradient(#333 0% 25%, #222 0% 50%) 0 0 / 16px 16px;
        border: 1px solid var(--vscode-panel-border, #444);
        display: inline-flex;
    }
    .checker-bg.bg-dark { background: #111; }
    .checker-bg.bg-light { background: #eee; }
    .image-panel img {
        image-rendering: pixelated;
    }
    .image-panel img#texImg.scaled {
        width: var(--scaled-w);
        height: var(--scaled-h);
    }
    .channel-previews {
        display: flex;
        gap: 8px;
        margin-top: 12px;
        flex-wrap: wrap;
    }
    .channel-preview {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 4px;
        cursor: pointer;
    }
    .channel-preview span {
        font-size: 11px;
        color: var(--vscode-descriptionForeground, #999);
        user-select: none;
    }
    .channel-preview .checker-bg {
        background: repeating-conic-gradient(#333 0% 25%, #222 0% 50%) 0 0 / 8px 8px;
        border: 2px solid transparent;
        border-radius: 4px;
        width: 48px;
        height: 48px;
        display: flex;
        justify-content: center;
        align-items: center;
        overflow: hidden;
    }
    .channel-preview.active .checker-bg {
        border-color: var(--vscode-focusBorder, #007acc);
    }
    .channel-preview img {
        width: 100%;
        height: 100%;
        object-fit: contain;
        image-rendering: pixelated;
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
    .props-panel {
        flex: 1 1 auto;
        min-width: 280px;
        max-width: 400px;
        max-height: 100vh;
        overflow-y: auto;
    }
    .prop-section { margin-bottom: 16px; }
    .prop-section-header {
        font-size: 13px;
        font-weight: 600;
        color: var(--vscode-foreground, #ddd);
        background: var(--vscode-sideBarSectionHeader-background, #252526);
        padding: 5px 8px;
        border: 1px solid var(--vscode-panel-border, #444);
        border-bottom: none;
        cursor: pointer;
        user-select: none;
    }
    .prop-section-header::before {
        content: '▾ ';
        font-size: 10px;
    }
    table { width: 100%; border-collapse: collapse; border: 1px solid var(--vscode-panel-border, #333); }
    td {
        padding: 3px 8px;
        border-bottom: 1px solid var(--vscode-panel-border, #2a2a2a);
        vertical-align: top;
    }
    td:first-child {
        color: var(--vscode-descriptionForeground, #999);
        white-space: nowrap;
        width: 120px;
        background: var(--vscode-editor-background, #1e1e1e);
    }
    td:last-child {
        color: var(--vscode-foreground, #ddd);
        font-weight: 500;
    }
    tr.highlight td:first-child {
        background: var(--vscode-list-activeSelectionBackground, #094771);
        color: var(--vscode-list-activeSelectionForeground, #fff);
    }
    .meta-input {
        width: 100%;
        background: var(--vscode-input-background, #3c3c3c);
        color: var(--vscode-input-foreground, #ccc);
        border: 1px solid var(--vscode-input-border, transparent);
        padding: 4px;
        border-radius: 2px;
        box-sizing: border-box;
    }
    .meta-input:focus {
        outline: 1px solid var(--vscode-focusBorder, #007acc);
        outline-offset: -1px;
    }
    .save-btn {
        background: var(--vscode-button-background, #0e639c);
        color: var(--vscode-button-foreground, #fff);
        border: none;
        padding: 6px 12px;
        cursor: pointer;
        border-radius: 2px;
        font-weight: 500;
    }
    .save-btn:hover {
        background: var(--vscode-button-hoverBackground, #1177bb);
    }
</style>
</head>
<body>
    <svg width="0" height="0" style="position:absolute;">
      <defs>
        <filter id="ch-r" color-interpolation-filters="sRGB">
          <feColorMatrix type="matrix" values="1 0 0 0 0  1 0 0 0 0  1 0 0 0 0  0 0 0 1 0" />
        </filter>
        <filter id="ch-g" color-interpolation-filters="sRGB">
          <feColorMatrix type="matrix" values="0 1 0 0 0  0 1 0 0 0  0 1 0 0 0  0 0 0 1 0" />
        </filter>
        <filter id="ch-b" color-interpolation-filters="sRGB">
          <feColorMatrix type="matrix" values="0 0 1 0 0  0 0 1 0 0  0 0 1 0 0  0 0 0 1 0" />
        </filter>
        <filter id="ch-a" color-interpolation-filters="sRGB">
          <feColorMatrix type="matrix" values="0 0 0 1 0  0 0 0 1 0  0 0 0 1 0  0 0 0 1 0" />
        </filter>
      </defs>
    </svg>
    <div class="image-panel">
        ${imgSrc ? `<div class="image-toolbar">
            <button class="size-toggle" id="sizeBtn" onclick="toggleSize()" title="Toggle size">
                <img src="${resizeIconUri}" alt="resize" width="16" height="16" />
            </button>
            <button class="size-toggle" onclick="toggleBg()" title="Toggle background" style="font-size:14px; font-weight:bold;">
                B
            </button>
            <span class="size-label" id="sizeLabel">${scaledW}\u00d7${scaledH}</span>
        </div>` : ''}
        ${imgSrc
            ? `<div class="checker-bg"><img id="texImg" class="scaled" style="--scaled-w:${scaledW}px;--scaled-h:${scaledH}px" src="${imgSrc}" alt="${meta?.name ?? 'texture'}" /></div>
               <div class="channel-previews">
                   <div class="channel-preview active" onclick="setChannel('all', this)">
                       <div class="checker-bg"><img src="${imgSrc}" alt="All Channels" /></div>
                       <span>RGB(A)</span>
                   </div>
                   <div class="channel-preview" onclick="setChannel('r', this)">
                       <div class="checker-bg"><img src="${imgSrc}" style="filter: url(#ch-r)" alt="Red Channel" /></div>
                       <span>R</span>
                   </div>
                   <div class="channel-preview" onclick="setChannel('g', this)">
                       <div class="checker-bg"><img src="${imgSrc}" style="filter: url(#ch-g)" alt="Green Channel" /></div>
                       <span>G</span>
                   </div>
                   <div class="channel-preview" onclick="setChannel('b', this)">
                       <div class="checker-bg"><img src="${imgSrc}" style="filter: url(#ch-b)" alt="Blue Channel" /></div>
                       <span>B</span>
                   </div>
                   <div class="channel-preview" onclick="setChannel('a', this)">
                       <div class="checker-bg"><img src="${imgSrc}" style="filter: url(#ch-a)" alt="Alpha Channel" /></div>
                       <span>A</span>
                   </div>
               </div>`
            : '<div class="no-image">No preview</div>'}
    </div>
    <div class="props-panel">
        <div style="margin-bottom: 12px; display: flex; justify-content: flex-end;">
            <button class="save-btn" onclick="saveMetadata()">Save Changes</button>
        </div>
        ${metaSections}
        ${errorNote}
    </div>
    <script>
        const vscode = acquireVsCodeApi();
        let scaled = true;
        function setChannel(ch, el) {
            const img = document.getElementById('texImg');
            if (!img) return;
            
            if (ch === 'all') {
                img.style.filter = 'none';
            } else {
                img.style.filter = 'url(#ch-' + ch + ')';
            }

            document.querySelectorAll('.channel-preview').forEach(p => p.classList.remove('active'));
            if (el) el.classList.add('active');
        }
        function toggleSize() {
            const img = document.getElementById('texImg');
            const label = document.getElementById('sizeLabel');
            if (!img || !label) return;
            scaled = !scaled;
            if (scaled) {
                img.classList.add('scaled');
                label.textContent = '${scaledW}\u00d7${scaledH}';
            } else {
                img.classList.remove('scaled');
                label.textContent = 'Original (${texW}\u00d7${texH})';
            }
        }
        let bgState = 0; // 0=checker, 1=dark, 2=light
        function toggleBg() {
            bgState = (bgState + 1) % 3;
            document.querySelectorAll('.checker-bg').forEach(el => {
                el.classList.remove('bg-dark', 'bg-light');
                if (bgState === 1) el.classList.add('bg-dark');
                else if (bgState === 2) el.classList.add('bg-light');
            });
        }
        function saveMetadata() {
            const data = {
                red: document.getElementById('chRed')?.value,
                green: document.getElementById('chGreen')?.value,
                blue: document.getElementById('chBlue')?.value,
                alpha: document.getElementById('chAlpha')?.value,
                useSRGB: document.getElementById('useSRGB')?.checked,
                name: document.getElementById('metaName')?.value,
                path: document.getElementById('metaPath')?.value,
                swizzle: parseInt(document.getElementById('metaSwizzle')?.value || "0", 10)
            };
            vscode.postMessage({ type: 'save-metadata', data });
        }
    </script>
</body>
</html>`;
}

function row(label: string, value: string): string {
    return `<tr><td>${label}</td><td>${value}</td></tr>`;
}

function buildSection(title: string, rows: string): string {
    return `<div class="prop-section">
        <div class="prop-section-header">${title}</div>
        <table>${rows}</table>
    </div>`;
}

function buildChannelRows(ch: BntxChannelInfo): string {
    const opts = ['Red', 'Green', 'Blue', 'Alpha', 'Zero', 'One'];
    const select = (id: string, current: string) => {
        const options = opts.map(o => `<option value="${o}" ${current === o ? 'selected' : ''}>${o}</option>`).join('');
        return `<select id="${id}" class="meta-input">${options}</select>`;
    };
    return [
        row('Red Channel', select('chRed', ch.red)),
        row('Green Channel', select('chGreen', ch.green)),
        row('Blue Channel', select('chBlue', ch.blue)),
        row('Alpha Channel', select('chAlpha', ch.alpha)),
    ].join('');
}

function buildImageInfoRows(info: BntxImageInfo): string {
    const srgbChecked = info.useSRGB === 'True' ? 'checked' : '';
    
    return [
        row('Width', String(info.width)),
        row('Height', String(info.height)),
        row('Mip Count', String(info.mipCount)),
        row('Format', info.format),
        row('Use SRGB', `<input type="checkbox" id="useSRGB" ${srgbChecked} />`),
        row('Name', `<input type="text" id="metaName" class="meta-input" value="${escapeHtml(info.name)}" />`),
        row('Path', `<input type="text" id="metaPath" class="meta-input" value="${escapeHtml(info.path ?? '')}" />`),
    ].join('');
}

function buildMiscRows(misc: BntxMiscInfo): string {
    return [
        row('Depth', String(misc.depth)),
        row('Tile Mode', misc.tileMode),
        row('Swizzle', `<input type="number" id="metaSwizzle" class="meta-input" value="${misc.swizzle}" />`),
        row('Alignment', String(misc.alignment)),
        row('Pitch', String(misc.pitch)),
        row('Dims', misc.dims),
        row('Surface Shape', misc.surfaceShape),
        row('Flags', String(misc.flags)),
        row('Image Size', formatBytes(misc.imageSize)),
        row('Sample Count', String(misc.sampleCount)),
    ].join('');
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

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
