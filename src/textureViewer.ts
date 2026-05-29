import * as vscode from 'vscode';
import type { BntxTextureResult, BntxChannelInfo, BntxImageInfo, BntxMiscInfo } from './bridge';
import * as fs from 'fs';
import * as path from 'path';

const panels = new Map<string, vscode.WebviewPanel>();
let extensionUri: vscode.Uri | undefined;

export function initTextureViewer(extUri: vscode.Uri): void {
    extensionUri = extUri;
}

export function openTextureViewer(
    textureName: string,
    result: BntxTextureResult,
): void {
    const key = textureName;
    const existing = panels.get(key);
    if (existing) {
        existing.reveal();
        existing.webview.html = buildHtml(result, existing.webview);
        return;
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
        if (result.pngPath) {
            try {
                fs.unlinkSync(result.pngPath);
            } catch { }
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
    .image-panel img {
        image-rendering: pixelated;
        background: repeating-conic-gradient(#333 0% 25%, #222 0% 50%) 0 0 / 16px 16px;
        border: 1px solid var(--vscode-panel-border, #444);
    }
    .image-panel img#texImg.scaled {
        width: var(--scaled-w);
        height: var(--scaled-h);
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
</style>
</head>
<body>
    <div class="image-panel">
        ${imgSrc ? `<div class="image-toolbar">
            <button class="size-toggle" id="sizeBtn" onclick="toggleSize()" title="Toggle size">
                <img src="${resizeIconUri}" alt="resize" width="16" height="16" />
            </button>
            <span class="size-label" id="sizeLabel">${scaledW}\u00d7${scaledH}</span>
        </div>` : ''}
        ${imgSrc
            ? `<img id="texImg" class="scaled" style="--scaled-w:${scaledW}px;--scaled-h:${scaledH}px" src="${imgSrc}" alt="${meta?.name ?? 'texture'}" />`
            : '<div class="no-image">No preview</div>'}
    </div>
    <div class="props-panel">
        ${metaSections}
        ${errorNote}
    </div>
    <script>
        let scaled = true;
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
    return [
        row('Red Channel', ch.red),
        row('Green Channel', ch.green),
        row('Blue Channel', ch.blue),
        row('Alpha Channel', ch.alpha),
    ].join('');
}

function buildImageInfoRows(info: BntxImageInfo): string {
    return [
        row('Width', String(info.width)),
        row('Height', String(info.height)),
        row('Mip Count', String(info.mipCount)),
        row('Format', info.format),
        row('Use SRGB', info.useSRGB),
        row('Name', info.name),
        row('Access Flags', info.accessFlags),
    ].join('');
}

function buildMiscRows(misc: BntxMiscInfo): string {
    return [
        row('Depth', String(misc.depth)),
        row('Tile Mode', misc.tileMode),
        row('Swizzle', String(misc.swizzle)),
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
