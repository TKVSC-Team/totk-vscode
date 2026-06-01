import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { runBridgeJsonAsync } from '../bridge';
import { getCachedPythonExecutable } from '../pythonEnv';
import { logger } from '../logger';
import {
    getDiskArchivePath,
    getLocatorInsideDiskArchive,
    isPathInsideArchive,
} from '../archives';

const panels = new Map<string, vscode.WebviewPanel>();

function getBridgeEnv(): NodeJS.ProcessEnv {
    const config = vscode.workspace.getConfiguration('totk-editor');
    const romfsPath = config.get<string>('romfsPath', '') || '';
    const extraAamp = config.get<string[]>('extraAampExtensions', []);
    return {
        ...process.env,
        TOTK_EDITOR_ROMFS: romfsPath,
        TOTK_TAG_PRODUCT_FORMAT: config.get<string>('tagProductFormat', 'json'),
        TOTK_EXTRA_AAMP_EXTS: extraAamp.map((ext) => ext.replace(/^\./, '')).join(','),
        TOTK_BYML_INLINE_CONTAINER_MAX_COUNT: String(config.get<number>('bymlInlineContainerMaxCount', 1)),
    };
}

function getPython(): string {
    const config = vscode.workspace.getConfiguration('totk-editor');
    const override = config.get<string>('pythonPath', '');
    if (override) {
        return override;
    }
    return getCachedPythonExecutable() ?? '';
}

async function getRawBinaryBytes(uri: vscode.Uri, extensionUri: vscode.Uri): Promise<{ data: Uint8Array; resolvedName: string }> {
    const fsPath = uri.fsPath;
    const python = getPython();
    const bridgePath = path.join(extensionUri.fsPath, 'python', 'totk_bridge.py');
    const env = getBridgeEnv();

    logger.info(`[HexEditor] getRawBinaryBytes: uri=${uri.toString()} scheme=${uri.scheme}`);
    logger.info(`[HexEditor] python executable: "${python || '(none)'}"`);
    logger.info(`[HexEditor] bridgePath: ${bridgePath}`);
    logger.info(`[HexEditor] isPathInsideArchive: ${isPathInsideArchive(fsPath)}`);
    
    let tempRawPath = '';
    let isTempRaw = false;

    // 1. If inside an archive, export it to a temp file
    if (isPathInsideArchive(fsPath)) {
        if (!python) {
            logger.info(`[HexEditor] ERROR: Python not available for archive export`);
            throw new Error('Python environment is not ready. Please configure Python first.');
        }
        const diskArchive = getDiskArchivePath(fsPath);
        const locator = getLocatorInsideDiskArchive(fsPath, diskArchive);
        logger.info(`[HexEditor] Archive export — diskArchive=${diskArchive} locator="${locator}"`);
        if (!locator) {
            logger.info(`[HexEditor] ERROR: locator is empty, cannot read archive root`);
            throw new Error('Cannot read archive root.');
        }

        logger.info(`[HexEditor] Calling bridge export-temp...`);
        const result = await runBridgeJsonAsync<{ path: string }>(
            python,
            bridgePath,
            ['export-temp', diskArchive, locator],
            undefined,
            env,
        );
        logger.info(`[HexEditor] bridge export-temp result path: "${result?.path}"`);
        
        if (!result.path || !fs.existsSync(result.path)) {
            logger.info(`[HexEditor] ERROR: exported temp file missing at "${result?.path}"`);
            throw new Error('Failed to export archived file data.');
        }
        
        tempRawPath = result.path;
        isTempRaw = true;
        logger.info(`[HexEditor] Archive export succeeded, tempRawPath=${tempRawPath}`);
    } else {
        tempRawPath = fsPath;
        logger.info(`[HexEditor] Not an archive path, reading directly from disk: ${tempRawPath}`);
    }

    let finalPath = tempRawPath;
    let isFinalTemp = isTempRaw;

    // 2. If the file is ZSTD compressed (.zs), decompress it
    const isZstd = fsPath.toLowerCase().endsWith('.zs') || path.basename(fsPath).toLowerCase().includes('.zs');
    logger.info(`[HexEditor] isZstd: ${isZstd}`);
    if (isZstd) {
        if (!python) {
            if (isTempRaw) {
                try { fs.unlinkSync(tempRawPath); } catch {}
            }
            logger.info(`[HexEditor] ERROR: Python not available for .zs decompression`);
            throw new Error('Python environment is not ready. Decompression of .zs requires Python.');
        }

        logger.info(`[HexEditor] Calling bridge decompress-file: tempRawPath=${tempRawPath} basename=${path.basename(fsPath)}`);
        const result = await runBridgeJsonAsync<{ path: string }>(
            python,
            bridgePath,
            ['decompress-file', tempRawPath, path.basename(fsPath)],
            undefined,
            env,
        );
        logger.info(`[HexEditor] bridge decompress-file result path: "${result?.path}"`);

        if (!result.path || !fs.existsSync(result.path)) {
            if (isTempRaw) {
                try { fs.unlinkSync(tempRawPath); } catch {}
            }
            logger.info(`[HexEditor] ERROR: decompressed temp file missing at "${result?.path}"`);
            throw new Error('Failed to decompress .zs file data.');
        }

        if (isTempRaw) {
            try { fs.unlinkSync(tempRawPath); } catch {}
        }

        finalPath = result.path;
        isFinalTemp = true;
        logger.info(`[HexEditor] Decompression succeeded, finalPath=${finalPath}`);
    }

    logger.info(`[HexEditor] Reading final file from disk: ${finalPath}`);
    const data = await fs.promises.readFile(finalPath);
    logger.info(`[HexEditor] Read ${data.length} bytes successfully`);

    if (isFinalTemp) {
        try { fs.unlinkSync(finalPath); } catch {}
    }

    let resolvedName = path.basename(fsPath);
    if (isZstd) {
        resolvedName = resolvedName.replace(/\.zs$/i, '');
    }
    logger.info(`[HexEditor] resolvedName: ${resolvedName}`);

    return { data: new Uint8Array(data), resolvedName };
}

export function openHexEditor(uri: vscode.Uri, extensionUri: vscode.Uri, isReadOnly = true): void {
    const key = uri.toString();
    logger.info(`[HexEditor] openHexEditor called: key=${key} isReadOnly=${isReadOnly}`);

    const existing = panels.get(key);
    if (existing) {
        logger.info(`[HexEditor] Panel already open, revealing`);
        existing.reveal();
        return;
    }

    const panel = vscode.window.createWebviewPanel(
        'totkHexEditor',
        `Hex: ${path.basename(uri.fsPath)}`,
        vscode.ViewColumn.Active,
        {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [
                vscode.Uri.joinPath(extensionUri, 'icons')
            ]
        },
    );
    logger.info(`[HexEditor] Webview panel created`);

    panels.set(key, panel);

    panel.onDidDispose(() => {
        logger.info(`[HexEditor] Panel disposed: key=${key}`);
        panels.delete(key);
    });

    let pendingInitData: { base64Data: string; totalSize: number } | null = null;
    let webviewReady = false;

    // Handle messages sent from Webview (e.g. Save action)
    panel.webview.onDidReceiveMessage(async (message) => {
        if (message.type === 'webview-error') {
            logger.info(`[HexEditor Webview ERROR] ${message.message} at ${message.filename}:${message.lineno}:${message.colno}\nStack: ${message.error}`);
        } else if (message.type === 'ready') {
            logger.info(`[HexEditor] Received 'ready' from webview`);
            webviewReady = true;
            if (pendingInitData) {
                logger.info(`[HexEditor] Sending pending 'init' data to webview`);
                panel.webview.postMessage({ type: 'init', ...pendingInitData });
                pendingInitData = null;
            } else {
                logger.info(`[HexEditor] 'ready' received, but pendingInitData is null`);
            }
        } else if (message.type === 'save') {
            if (isReadOnly) {
                logger.info(`[HexEditor] REJECTED save message for read-only document: ${uri.fsPath}`);
                vscode.window.showErrorMessage(`Cannot save changes: File is opened in Read-Only mode.`);
                return;
            }
            logger.info(`[HexEditor] Save message received from webview for ${uri.fsPath}`);
            try {
                let content = Buffer.from(message.base64Data, 'base64');
                logger.info(`[HexEditor] Decoded save payload: ${content.length} bytes`);
                
                // If it is ZSTD compressed, compress it back first!
                const isZstd = uri.fsPath.toLowerCase().endsWith('.zs') || path.basename(uri.fsPath).toLowerCase().includes('.zs');
                if (isZstd) {
                    logger.info(`[HexEditor] File is .zs — recompressing before save`);
                    const python = getPython();
                    if (!python) {
                        throw new Error('Python environment is not ready. Re-compression of .zs requires Python.');
                    }
                    const bridgePath = path.join(extensionUri.fsPath, 'python', 'totk_bridge.py');
                    const env = getBridgeEnv();

                    // Create a temp file with the uncompressed data
                    const tempUncomp = path.join(os.tmpdir(), `totk-uncomp-temp-${Date.now()}`);
                    await fs.promises.writeFile(tempUncomp, content);
                    logger.info(`[HexEditor] Wrote uncompressed temp file: ${tempUncomp}`);

                    try {
                        const result = await runBridgeJsonAsync<{ path: string }>(
                            python,
                            bridgePath,
                            ['compress-file', tempUncomp, path.basename(uri.fsPath)],
                            undefined,
                            env,
                        );
                        logger.info(`[HexEditor] bridge compress-file result path: "${result?.path}"`);

                        if (!result.path || !fs.existsSync(result.path)) {
                            throw new Error('Failed to recompress file data.');
                        }

                        // Read the compressed bytes
                        content = await fs.promises.readFile(result.path);
                        logger.info(`[HexEditor] Recompressed to ${content.length} bytes`);

                        // Clean up temp file
                        try { fs.unlinkSync(result.path); } catch {}
                    } finally {
                        try { fs.unlinkSync(tempUncomp); } catch {}
                    }
                }

                logger.info(`[HexEditor] Writing ${content.length} bytes to ${uri.fsPath}`);
                await vscode.workspace.fs.writeFile(uri, content);
                logger.info(`[HexEditor] Save successful`);
                vscode.window.showInformationMessage(`Successfully saved: ${path.basename(uri.fsPath)}`);
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                logger.info(`[HexEditor] Save failed: ${msg}`);
                vscode.window.showErrorMessage(`Failed to save changes: ${msg}`);
            }
        } else if (message.type === 'evaluate-hexpat') {
            try {
                const python = getPython();
                if (!python) {
                    throw new Error('Python environment is not ready.');
                }
                const bridgePath = path.join(extensionUri.fsPath, 'python', 'totk_bridge.py');
                const env = getBridgeEnv();

                // Create a temp file with the binary data
                const tempBin = path.join(os.tmpdir(), `totk-bin-temp-${Date.now()}`);
                await fs.promises.writeFile(tempBin, Buffer.from(message.base64Data, 'base64'));

                try {
                    const result = await runBridgeJsonAsync<{ ast: any }>(
                        python,
                        bridgePath,
                        ['evaluate-hexpat', tempBin],
                        message.hexpatCode,
                        env,
                    );
                    panel.webview.postMessage({ type: 'evaluate-hexpat-result', ast: result?.ast || [] });
                } finally {
                    try { fs.unlinkSync(tempBin); } catch {}
                }
            } catch (err) {
                logger.info(`[HexEditor] Error evaluating hexpat: ${err}`);
                const errorMessage = err instanceof Error ? err.message : String(err);
                panel.webview.postMessage({ type: 'evaluate-hexpat-error', error: errorMessage });
            }
        }
    });

    // Read file contents using workspace file system (works on sarc, totk-dump, totk-disk, and file)
    vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: `Opening ${path.basename(uri.fsPath)} in Hex Editor...`,
            cancellable: false
        },
        async () => {
            logger.info(`[HexEditor] withProgress started — calling getRawBinaryBytes`);
            try {
                const { data, resolvedName } = await getRawBinaryBytes(uri, extensionUri);
                logger.info(`[HexEditor] getRawBinaryBytes returned ${data.length} bytes, resolvedName=${resolvedName}`);
                
                // Load community hexpat pattern files
                const patterns: { name: string; filename: string; content: string }[] = [];
                try {
                    const configPath = path.join(extensionUri.fsPath, 'config', 'hexpat');
                    logger.info(`[HexEditor] Loading patterns from configPath: ${configPath}`);
                    if (fs.existsSync(configPath)) {
                        const files = fs.readdirSync(configPath);
                        for (const file of files) {
                            if (file.endsWith('.hexpat')) {
                                const filePath = path.join(configPath, file);
                                const content = fs.readFileSync(filePath, 'utf8');
                                const match = content.match(/#pragma\s+pattern_name\s+(.*)/);
                                const name = match ? match[1].trim() : file;
                                patterns.push({ name, filename: file, content });
                            }
                        }
                    }
                    logger.info(`[HexEditor] Loaded ${patterns.length} community patterns.`);
                } catch (e) {
                    logger.info(`[HexEditor] Error loading patterns: ${e}`);
                }

                const base64Data = Buffer.from(data).toString('base64');
                logger.info(`[HexEditor] base64 encoded length: ${base64Data.length} chars — setting webview HTML`);
                pendingInitData = { base64Data, totalSize: data.length };
                const html = buildHtml(resolvedName, data.length, isReadOnly, panel.webview, patterns);
                try {
                    fs.writeFileSync(path.join(extensionUri.fsPath, 'debug_webview.html'), html, 'utf8');
                } catch (e) {
                    logger.info(`[HexEditor] Failed to write debug HTML: ${e}`);
                }
                panel.webview.html = html;
                if (webviewReady) {
                    panel.webview.postMessage({ type: 'init', ...pendingInitData });
                    pendingInitData = null;
                }
                logger.info(`[HexEditor] panel.webview.html set successfully`);
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                logger.info(`[HexEditor] ERROR in withProgress: ${msg}`);
                panel.webview.html = buildErrorHtml(path.basename(uri.fsPath), msg);
            }
        }
    );
}

function buildErrorHtml(filename: string, error: string): string {
    return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <style>
        body {
            font-family: var(--vscode-editor-font-family, monospace);
            color: var(--vscode-errorForeground, #ff6b6b);
            background: var(--vscode-editor-background, #1e1e1e);
            padding: 30px;
        }
        h2 { font-weight: 500; }
        pre { background: rgba(0,0,0,0.2); padding: 15px; border-radius: 4px; color: var(--vscode-foreground, #ccc); }
    </style>
</head>
<body>
    <h2>Failed to load hex view for ${escapeHtml(filename)}</h2>
    <pre>${escapeHtml(error)}</pre>
</body>
</html>`;
}

function buildHtml(
    filename: string,
    totalSize: number,
    isReadOnly: boolean,
    webview: vscode.Webview,
    patterns: { name: string; filename: string; content: string }[]
): string {
    const editBadge = isReadOnly 
        ? '<span class="status-badge readonly">Read-Only</span>' 
        : '<span class="status-badge writable">Project Edit Mode</span>';

    const serializedPatterns = Buffer.from(JSON.stringify(patterns)).toString('base64');

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Hex Viewer</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        :root {
            --glass-bg: rgba(30, 30, 30, 0.7);
            --border-color: var(--vscode-panel-border, #333);
            --header-bg: var(--vscode-editorGroupHeader-tabsBackground, #252526);
            --fg-color: var(--vscode-editor-foreground, #ccc);
            --bg-color: var(--vscode-editor-background, #1e1e1e);
            --selection-bg: var(--vscode-editor-selectionBackground, #264f78);
            --selection-fg: var(--vscode-editor-selectionForeground, #fff);
            --hover-bg: rgba(255, 255, 255, 0.08);
            --active-glow: 0 0 8px rgba(0, 127, 212, 0.6);
            
            /* Byte highlighters matching VS Code style color schemes */
            --color-ascii: var(--vscode-terminal-ansiGreen, #4ec9b0);
            --color-control: var(--vscode-terminal-ansiYellow, #dcdcaa);
            --color-high: var(--vscode-terminal-ansiBlue, #9cdcfe);
            --color-special: var(--vscode-terminal-ansiRed, #f48771);
            
            /* Font integration from VS Code settings */
            --code-font: var(--vscode-editor-font-family, 'Courier New', monospace);
        }

        body {
            font-family: var(--vscode-font-family, sans-serif);
            font-size: 13px;
            color: var(--fg-color);
            background: var(--bg-color);
            height: 100vh;
            display: flex;
            flex-direction: column;
            overflow: hidden;
            user-select: none;
        }

        /* Apply Editor Font Family globally to code components */
        .col-offset, .byte-cell, .ascii-cell, .inspector-value, .code-preview, .ast-item, .grid-header {
            font-family: var(--code-font) !important;
        }

        /* Glassmorphic Top Toolbar */
        .toolbar {
            background: var(--header-bg);
            border-bottom: 1px solid var(--border-color);
            padding: 12px 20px;
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 16px;
            flex-wrap: wrap;
            backdrop-filter: blur(10px);
            z-index: 10;
        }

        .file-info {
            display: flex;
            align-items: center;
            gap: 10px;
        }

        .filename-badge {
            font-weight: bold;
            font-size: 14px;
            color: var(--vscode-textLink-activeForeground, #569cd6);
            background: rgba(86, 156, 214, 0.1);
            padding: 4px 10px;
            border-radius: 6px;
            border: 1px solid rgba(86, 156, 214, 0.2);
        }

        .size-badge {
            font-size: 12px;
            color: var(--vscode-descriptionForeground, #888);
            background: rgba(255, 255, 255, 0.05);
            padding: 4px 8px;
            border-radius: 6px;
        }

        .status-badge {
            font-size: 11px;
            padding: 3px 8px;
            border-radius: 4px;
            font-weight: bold;
        }
        .status-badge.readonly {
            background: rgba(244, 135, 113, 0.15);
            color: var(--vscode-terminal-ansiRed, #f48771);
            border: 1px solid rgba(244, 135, 113, 0.3);
        }
        .status-badge.writable {
            background: rgba(78, 201, 176, 0.15);
            color: var(--vscode-terminal-ansiGreen, #4ec9b0);
            border: 1px solid rgba(78, 201, 176, 0.3);
        }

        .tools-group {
            display: flex;
            align-items: center;
            gap: 12px;
        }

        .input-wrapper {
            position: relative;
            display: flex;
            align-items: center;
        }

        .input-control {
            background: var(--vscode-input-background, #2d2d2d);
            color: var(--vscode-input-foreground, #ccc);
            border: 1px solid var(--vscode-input-border, #444);
            border-radius: 4px;
            padding: 6px 10px;
            font-size: 12px;
            outline: none;
            transition: all 0.2s ease;
            width: 130px;
        }

        .input-control:focus {
            border-color: var(--vscode-focusBorder, #007fd4);
            box-shadow: var(--active-glow);
        }

        .search-control {
            width: 170px;
        }

        .btn {
            background: var(--vscode-button-background, #0e639c);
            color: var(--vscode-button-foreground, #fff);
            border: none;
            padding: 6px 12px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
            font-weight: 500;
            transition: all 0.2s ease;
            display: flex;
            align-items: center;
            justify-content: center;
        }

        .btn:hover {
            background: var(--vscode-button-hoverBackground, #1177bb);
        }

        .btn-secondary {
            background: rgba(255, 255, 255, 0.08);
            color: var(--fg-color);
            border: 1px solid var(--border-color);
        }

        .btn-secondary:hover {
            background: rgba(255, 255, 255, 0.15);
        }

        .btn-success {
            background: var(--vscode-gitDecoration-addedResourceForeground, #4ec9b0);
            color: #1e1e1e;
            font-weight: bold;
        }
        
        .btn-success:hover {
            background: #64dfc4;
            box-shadow: 0 0 10px rgba(78, 201, 176, 0.5);
        }

        .btn:disabled {
            opacity: 0.4;
            cursor: not-allowed;
        }

        .nav-group {
            display: flex;
            align-items: center;
            gap: 6px;
        }

        .page-indicator {
            font-size: 12px;
            min-width: 90px;
            text-align: center;
        }

        /* Split layout container */
        .workspace-split {
            flex: 1;
            display: flex;
            overflow: hidden;
            width: 100%;
        }

        /* Hex Grid Viewport */
        .editor-container {
            flex: 1;
            display: flex;
            flex-direction: column;
            overflow: hidden;
            position: relative;
        }

        .grid-layout {
            display: grid;
            grid-template-columns: 
                85px                             /* Offset */
                12px                             /* Spacer */
                repeat(8, 22px)                  /* Bytes 00-07 */
                10px                             /* Mid Gap */
                repeat(8, 22px)                  /* Bytes 08-0F */
                32px                             /* Shift Decoded Text away from Hex */
                repeat(16, 9.5px);               /* Compact Decoded Text characters */
            align-items: center;
        }

        .grid-header {
            background: rgba(0, 0, 0, 0.15);
            border-bottom: 1px solid var(--border-color);
            padding: 8px 24px;
            font-weight: 600;
            color: var(--vscode-descriptionForeground, #888);
            letter-spacing: 0.5px;
        }

        .grid-viewport {
            flex: 1;
            overflow-y: auto;
            padding: 10px 24px;
            font-size: 14px;
            line-height: 20px;
            outline: none; /* remove default browser border when focused */
        }

        .hex-row {
            transition: background 0.1s ease;
            border-radius: 4px;
            height: 22px;
        }

        .hex-row:hover {
            background: var(--hover-bg);
        }

        .col-offset {
            color: var(--vscode-editorLineNumber-foreground, #5a5a5a);
            user-select: none;
        }

        .byte-cell {
            width: 22px;
            text-align: center;
            cursor: pointer;
            border-radius: 3px;
            transition: all 0.1s ease;
            position: relative;
            color: var(--vscode-editor-foreground, #cccccc);
        }

        .byte-cell.hovered {
            background: var(--hover-bg);
            outline: 1px solid rgba(0, 127, 212, 0.3);
        }

        .byte-cell.selected {
            background: var(--selection-bg) !important;
            color: var(--selection-fg) !important;
            font-weight: bold;
            box-shadow: 0 0 4px rgba(0, 127, 212, 0.4);
        }

        .byte-cell.cursor-active {
            outline: 1.5px solid var(--vscode-editorCursor-foreground, #007fd4) !important;
            box-shadow: var(--active-glow);
        }

        .byte-cell.dirty {
            background: rgba(220, 220, 170, 0.15);
            border-bottom: 2px solid var(--vscode-terminal-ansiYellow, #dcdcaa);
            color: var(--vscode-terminal-ansiYellow, #dcdcaa) !important;
            font-weight: bold;
        }

        /* Hex highlighting styles based on byte classification */
        .byte-null {
            opacity: 0.35;
        }

        .byte-ascii {
            color: var(--color-ascii);
        }

        .byte-control {
            color: var(--color-control);
        }

        .byte-high {
            color: var(--color-high);
        }

        .byte-special {
            color: var(--color-special);
            font-weight: bold;
        }

        .ascii-cell {
            width: 9.5px;
            text-align: center;
            cursor: pointer;
            border-radius: 2px;
            transition: all 0.1s ease;
            font-size: 13px;
            color: var(--vscode-editor-foreground, #cccccc);
        }

        .ascii-printable {
            color: var(--color-ascii, #4ec9b0);
        }

        .ascii-nonprintable {
            opacity: 0.35;
        }

        .ascii-cell.hovered {
            background: var(--hover-bg);
            outline: 1px solid rgba(0, 127, 212, 0.3);
            color: #fff;
        }

        .ascii-cell.selected {
            background: var(--selection-bg) !important;
            color: var(--selection-fg) !important;
            font-weight: bold;
        }

        .ascii-cell.dirty {
            color: var(--vscode-terminal-ansiYellow, #dcdcaa) !important;
            font-weight: bold;
            background: rgba(220, 220, 170, 0.08);
        }

        /* Collateral ImHex Pattern Runner Pane on the Right */
        .hexpat-container {
            width: 380px;
            flex-shrink: 0;
            background: var(--vscode-sideBar-background, #252526);
            border-left: 1px solid var(--border-color);
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }

        .hexpat-header {
            background: rgba(0,0,0,0.15);
            border-bottom: 1px solid var(--border-color);
            padding: 10px 16px;
            display: flex;
            align-items: center;
            justify-content: space-between;
        }

        .hexpat-title {
            font-weight: bold;
            font-size: 12px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            color: var(--vscode-sideBarTitle-foreground, #ccc);
        }

        .hexpat-tabs {
            display: flex;
            background: rgba(0,0,0,0.2);
            border-bottom: 1px solid var(--border-color);
        }

        .hexpat-tab {
            flex: 1;
            padding: 8px 12px;
            text-align: center;
            cursor: pointer;
            font-size: 11px;
            font-weight: bold;
            color: var(--vscode-descriptionForeground, #888);
            border-bottom: 2px solid transparent;
            transition: all 0.2s ease;
        }

        .hexpat-tab:hover {
            color: var(--fg-color);
        }

        .hexpat-tab.active {
            color: var(--vscode-textLink-activeForeground, #569cd6);
            border-bottom-color: var(--vscode-textLink-activeForeground, #569cd6);
            background: rgba(255, 255, 255, 0.02);
        }

        .hexpat-body {
            flex: 1;
            overflow-y: auto;
            padding: 16px;
            position: relative;
        }

        .hexpat-tab-content {
            display: none;
            height: 100%;
        }

        .hexpat-tab-content.active {
            display: block;
        }

        .code-preview {
            background: var(--vscode-editor-background, #1e1e1e);
            border: 1px solid var(--border-color);
            border-radius: 6px;
            padding: 12px;
            font-size: 12px;
            line-height: 18px;
            overflow-x: auto;
            white-space: pre;
            color: #d4d4d4;
        }

        .code-keyword { color: #569cd6; font-weight: bold; }
        .code-type { color: #4ec9b0; }
        .code-comment { color: #6a9955; font-style: italic; }
        .code-string { color: #ce9178; }
        .code-number { color: #b5cea8; }

        /* AST structures view */
        .ast-tree {
            display: flex;
            flex-direction: column;
            gap: 6px;
        }

        .ast-item {
            font-size: 12px;
            display: flex;
            flex-direction: column;
            gap: 3px;
        }

        .ast-row {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 4px 6px;
            border-radius: 4px;
            cursor: pointer;
            transition: background 0.15s ease;
        }

        .ast-row:hover {
            background: rgba(255,255,255,0.05);
        }

        .ast-arrow {
            font-size: 9px;
            color: #888;
            transition: transform 0.2s ease;
            width: 10px;
            display: inline-block;
            text-align: center;
        }
        .ast-arrow.collapsed {
            transform: rotate(-90deg);
        }

        .ast-name {
            font-weight: bold;
            color: #9cdcfe;
        }

        .ast-value {
            color: #ce9178;
        }

        .ast-offset {
            color: var(--vscode-descriptionForeground, #777);
            font-size: 11px;
            margin-left: auto;
        }

        .ast-children {
            padding-left: 16px;
            border-left: 1px dashed rgba(255, 255, 255, 0.1);
            display: flex;
            flex-direction: column;
            gap: 4px;
            margin-top: 2px;
        }

        .ast-children.collapsed {
            display: none;
        }

        /* HSL color highlights for structures (ImHex matching) */
        .hl-sarc-header {
            background-color: rgba(224, 86, 36, 0.25) !important;
            outline: 1.5px solid rgba(224, 86, 36, 0.7);
        }
        .hl-sfat-header {
            background-color: rgba(78, 171, 230, 0.25) !important;
            outline: 1.5px solid rgba(78, 171, 230, 0.7);
        }
        .hl-sfat-node-even {
            background-color: rgba(78, 201, 176, 0.18) !important;
            outline: 1px dashed rgba(78, 201, 176, 0.5);
        }
        .hl-sfat-node-odd {
            background-color: rgba(156, 220, 254, 0.18) !important;
            outline: 1px dashed rgba(156, 220, 254, 0.5);
        }
        .hl-sfnt-header {
            background-color: rgba(220, 220, 170, 0.25) !important;
            outline: 1.5px solid rgba(220, 220, 170, 0.7);
        }
        .hl-file-data {
            background-color: rgba(198, 120, 221, 0.15) !important;
            outline: 1px dotted rgba(198, 120, 221, 0.5);
        }
        .hl-aamp-header {
            background-color: rgba(224, 86, 36, 0.25) !important;
            outline: 1.5px solid rgba(224, 86, 36, 0.7);
        }
        .hl-byml-header {
            background-color: rgba(224, 86, 36, 0.25) !important;
            outline: 1.5px solid rgba(224, 86, 36, 0.7);
        }

        /* Make visual highlights pop on hover */
        .byte-cell[class*="hl-"]:hover, .ascii-cell[class*="hl-"]:hover {
            filter: brightness(1.3);
            box-shadow: 0 0 6px rgba(255, 255, 255, 0.2);
        }

        /* Running animated Overlay */
        .runner-overlay {
            position: absolute;
            top: 0; left: 0; right: 0; bottom: 0;
            background: rgba(30, 30, 30, 0.85);
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            gap: 16px;
            opacity: 0;
            pointer-events: none;
            transition: opacity 0.3s ease;
        }

        .runner-overlay.active {
            opacity: 1;
            pointer-events: all;
        }

        .spinner {
            width: 40px;
            height: 40px;
            border: 4px solid rgba(86, 156, 214, 0.1);
            border-top-color: var(--vscode-textLink-activeForeground, #569cd6);
            border-radius: 50%;
            animation: spin 1s infinite linear;
        }

        @keyframes spin {
            100% { transform: rotate(360deg); }
        }

        /* Sleek Status Bar / Inspector */
        .status-inspector {
            background: var(--header-bg);
            border-top: 1px solid var(--border-color);
            padding: 12px 24px;
            font-size: 12px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            backdrop-filter: blur(10px);
            z-index: 10;
        }

        .inspector-panel {
            display: flex;
            gap: 24px;
            flex-wrap: wrap;
        }

        .inspector-item {
            display: flex;
            align-items: center;
            gap: 6px;
        }

        .inspector-label {
            color: var(--vscode-descriptionForeground, #888);
        }

        .inspector-value {
            color: var(--vscode-textLink-activeForeground, #569cd6);
            font-weight: 600;
        }

        .no-selection {
            color: var(--vscode-descriptionForeground, #666);
            font-style: italic;
        }

        .find-highlight {
            background: rgba(255, 223, 0, 0.3) !important;
            outline: 1px solid rgb(255, 223, 0);
            color: #fff !important;
        }
    </style>
</head>
<body onkeydown="handleGlobalKeyDown(event)">

    <!-- Webview Header -->
    <div class="toolbar">
        <div class="file-info">
            <span class="filename-badge">${escapeHtml(filename)}</span>
            <span class="size-badge" id="sizeBadge">${formatBytes(totalSize)}</span>
            ${editBadge}
        </div>

        <div class="tools-group">
            <!-- Save Changes button (Hidden by default, shown when modified bytes > 0) -->
            <button class="btn btn-success" id="btnSave" onclick="saveChanges()" style="display: none; margin-right: 8px;">Save Changes</button>

            <!-- Search bar -->
            <div class="input-wrapper">
                <input type="text" id="searchInput" class="input-control search-control" placeholder="Search (Hex or ASCII)..." onkeydown="if(event.key === 'Enter') performSearch(1)" />
            </div>
            <button class="btn btn-secondary" onclick="performSearch(1)" title="Find Next">Find</button>

            <!-- Jump to Offset -->
            <div class="input-wrapper">
                <input type="text" id="offsetInput" class="input-control" placeholder="Go to Offset (e.g. 1A0)" onkeydown="if(event.key === 'Enter') jumpToOffset()" />
            </div>
            <button class="btn btn-secondary" onclick="jumpToOffset()">Go</button>
        </div>

        <!-- Pagination Navigation Removed (Virtual Scrolling) -->
    </div>

    <!-- Main Workspace Area -->
    <div class="workspace-split">
        <!-- Left Side: Hex Columns Editor -->
        <div class="editor-container">
            <div class="grid-header grid-layout">
                <div class="col-offset" style="font-weight: 600;">Offset</div>
                <div></div> <!-- Spacer -->
                <span style="text-align: center; font-size: 11px;">00</span>
                <span style="text-align: center; font-size: 11px;">01</span>
                <span style="text-align: center; font-size: 11px;">02</span>
                <span style="text-align: center; font-size: 11px;">03</span>
                <span style="text-align: center; font-size: 11px;">04</span>
                <span style="text-align: center; font-size: 11px;">05</span>
                <span style="text-align: center; font-size: 11px;">06</span>
                <span style="text-align: center; font-size: 11px;">07</span>
                <div></div> <!-- Mid Spacer -->
                <span style="text-align: center; font-size: 11px;">08</span>
                <span style="text-align: center; font-size: 11px;">09</span>
                <span style="text-align: center; font-size: 11px;">0A</span>
                <span style="text-align: center; font-size: 11px;">0B</span>
                <span style="text-align: center; font-size: 11px;">0C</span>
                <span style="text-align: center; font-size: 11px;">0D</span>
                <span style="text-align: center; font-size: 11px;">0E</span>
                <span style="text-align: center; font-size: 11px;">0F</span>
                <div></div> <!-- Spacer -->
                <div style="grid-column: span 16; font-size: 11px; font-weight: 600; text-align: left; padding-left: 2px;">Decoded Text</div>
            </div>

            <!-- Main Scrollable Viewport -->
            <div class="grid-viewport" id="gridViewport" tabindex="0">
                <div id="virtualContainer" style="position: relative;"></div>
            </div>
        </div>

        <!-- Right Side: ImHex .hexpat Sidebar Window -->
        <div class="hexpat-container">
            <div class="hexpat-header">
                <span class="hexpat-title">Pattern Runner (.hexpat)</span>
                <button class="btn btn-secondary" style="font-size: 10px; padding: 4px 8px; font-weight: bold; background: rgba(86, 156, 214, 0.15); border-color: rgba(86,156,214,0.3);" onclick="executePattern()">▶ Run Pattern</button>
            </div>

            <!-- Pattern selection dropdown -->
            <div class="hexpat-selector-bar" style="padding: 8px 16px; border-bottom: 1px solid var(--border-color); display: flex; align-items: center; gap: 8px; background: rgba(0,0,0,0.15);">
                <span style="font-size: 11px; color: var(--vscode-descriptionForeground, #888); font-weight: bold;">Pattern:</span>
                <select id="patternSelect" class="input-control" style="flex: 1; padding: 4px 8px; font-size: 11px; height: 26px;" onchange="loadSelectedPattern()">
                    <!-- Populated dynamically -->
                </select>
            </div>

            <!-- Tabs -->
            <div class="hexpat-tabs">
                <div class="hexpat-tab active" id="tabPattern" onclick="switchHexpatTab('pattern')">Pattern.hexpat</div>
                <div class="hexpat-tab" id="tabAST" onclick="switchHexpatTab('ast')">Parsed AST</div>
            </div>

            <!-- Sidebar Body -->
            <div class="hexpat-body">
                <!-- Tab 1: Pattern Editor/Code -->
                <div class="hexpat-tab-content active" id="contentPattern">
                    <div class="code-preview" id="codePreview">
                        <!-- Loaded dynamically -->
                    </div>
                </div>

                <!-- Tab 2: Parsed Structural Tree View -->
                <div class="hexpat-tab-content" id="contentAST">
                    <div class="ast-tree" id="astTree">
                        <div style="color: var(--vscode-descriptionForeground, #777); font-style: italic; text-align: center; padding-top: 30px;">
                            No structures parsed. Click "Run Pattern" to evaluate the pattern.
                        </div>
                    </div>
                </div>

                <!-- Run Animation Overlay -->
                <div class="runner-overlay" id="runnerOverlay">
                    <div class="spinner"></div>
                    <span style="font-weight: 500; font-size: 11px; color: var(--vscode-textLink-activeForeground, #569cd6); letter-spacing: 1px; text-transform: uppercase;">Compiling Pattern...</span>
                </div>
            </div>
        </div>
    </div>

    <!-- Inspector Bottom Status Bar -->
    <div class="status-inspector">
        <div class="inspector-panel" id="inspectorBody">
            <span class="no-selection">Click a byte or drag selection to inspect values</span>
        </div>
        <div class="inspector-item" style="color: var(--vscode-descriptionForeground, #888);" id="byteInspectorText">
            Offset: -
        </div>
    </div>

    <script>
        // Global error tracking back to extension host
        let vscodeApi;
        try {
            vscodeApi = acquireVsCodeApi();
        } catch (e) {
            console.error("Failed to acquire VS Code API:", e);
        }

        window.addEventListener('error', (event) => {
            if (vscodeApi) {
                vscodeApi.postMessage({
                    type: 'webview-error',
                    message: event.message,
                    filename: event.filename,
                    lineno: event.lineno,
                    colno: event.colno,
                    error: event.error ? (event.error.stack || event.error.message) : String(event.error)
                });
            }
        });

        // Loaded pattern runner data
        const communityPatterns = JSON.parse(atob("${serializedPatterns}"));
        let currentPatternFilename = "";
        const HL_CLASSES = ["", "hl-sarc-header", "hl-sfat-header", "hl-sfat-node-even", "hl-sfat-node-odd", "hl-sfnt-header", "hl-file-data", "hl-aamp-header", "hl-byml-header"];
        let highlightArray = new Uint8Array(0);

        // Parsed parameters from backend
        const totalSizeBytes = ${totalSize};
        const editorIsReadOnly = ${isReadOnly};

        let fileBytes = new Uint8Array(0);

        // Modified values tracker
        const modifiedBytes = new Map();
        
        const BYTES_PER_LINE = 16;
        const ROW_HEIGHT = 22;
        let totalRows = 0;
        let currentPage = 0; // Removed, but keeping variable name out of scope to avoid syntax errors if missed
        
        // Selection variables
        let selectedOffset = null;
        let selectionStart = null;
        let selectionEnd = null;
        
        // Nibble buffer for hex editing (e.g. keying "5" then "A")
        let nibbleBuffer = "";

        let searchResults = [];
        let currentSearchIndex = -1;
        
        // Drag-selection flags
        let isDragging = false;

        window.addEventListener('message', (event) => {
            const msg = event.data;
            if (msg.type === 'init') {
                try {
                    const binaryString = atob(msg.base64Data);
                    fileBytes = new Uint8Array(binaryString.length);
                    for (let i = 0; i < binaryString.length; i++) {
                        fileBytes[i] = binaryString.charCodeAt(i);
                    }
                    totalRows = Math.ceil(fileBytes.length / 16);
                    document.getElementById("virtualContainer").style.height = (totalRows * ROW_HEIGHT) + "px";
                    highlightArray = new Uint8Array(fileBytes.length);
                    
                    // Setup community patterns
                    initPatterns();
                    
                    document.getElementById("gridViewport").addEventListener("scroll", () => {
                        requestAnimationFrame(renderVisibleRows);
                    });
                    
                    renderVisibleRows();
                } catch(e) {
                    console.error("[HexEditor] postMessage decode failed:", e);
                }
            }
        });

        function initPatterns() {
            const select = document.getElementById("patternSelect");
            select.innerHTML = "";

            if (!communityPatterns || communityPatterns.length === 0) {
                const opt = document.createElement("option");
                opt.value = "";
                opt.textContent = "No patterns found";
                select.appendChild(opt);
                document.getElementById("codePreview").textContent = "// No pattern loaded";
                return;
            }

            // Auto-detect matching pattern using magic bytes
            let detectedFilename = "";
            if (fileBytes.length >= 4) {
                const magic = String.fromCharCode(fileBytes[0], fileBytes[1], fileBytes[2], fileBytes[3]);
                const magic2 = String.fromCharCode(fileBytes[0], fileBytes[1]);
                if (magic === "SARC") {
                    detectedFilename = "sarc.hexpat";
                } else if (magic === "AAMP") {
                    detectedFilename = "aamp.hexpat";
                } else if (magic2 === "BY" || magic2 === "YB") {
                    detectedFilename = "byml.hexpat";
                }
            }

            communityPatterns.forEach(p => {
                const opt = document.createElement("option");
                opt.value = p.filename;
                opt.textContent = p.name;
                if (p.filename === detectedFilename) {
                    opt.selected = true;
                }
                select.appendChild(opt);
            });

            const activeFilename = select.value || communityPatterns[0].filename;
            currentPatternFilename = activeFilename;
            const activePattern = communityPatterns.find(p => p.filename === activeFilename);
            if (activePattern) {
                renderPatternCode(activePattern.content);
                
                // If a matching pattern is detected, execute and highlight it automatically!
                if (detectedFilename) {
                    executePattern();
                }
            }
        }

        function loadSelectedPattern() {
            const select = document.getElementById("patternSelect");
            const filename = select.value;
            const pattern = communityPatterns.find(p => p.filename === filename);
            if (pattern) {
                renderPatternCode(pattern.content);
                currentPatternFilename = filename;
                
                // Clear highlights
                highlightArray = new Uint8Array(fileBytes.length);
                const astTree = document.getElementById("astTree");
                astTree.innerHTML = '<div style="color: var(--vscode-descriptionForeground, #777); font-style: italic; text-align: center; padding-top: 30px;">No structures parsed. Click "Run Pattern" to evaluate the pattern.</div>';
                renderVisibleRows();
            }
        }

        function renderPatternCode(code) {
            const preview = document.getElementById("codePreview");
            preview.innerHTML = highlightHexpat(code);
        }

        function highlightHexpat(code) {
            let escaped = code
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;');

            return escaped.replace(/(\\/\\/.*)|(&quot;.*?&quot;)|(&lt;.*?&gt;)|(\\b(struct|pragma|#include|#pragma)\\b)|(\\b(char|u8|u16|u32|s8|s16|s32|float|double)\\b)|(\\b\\d+\\b|0x[0-9a-fA-F]+)/g, 
                (match, comment, dstr, includeStr, keyword, type, number) => {
                    if (comment) return '<span class="code-comment">' + comment + '</span>';
                    if (dstr) return '<span class="code-string">' + dstr + '</span>';
                    if (includeStr) return '<span class="code-string">' + includeStr + '</span>';
                    if (keyword) return '<span class="code-keyword">' + keyword + '</span>';
                    if (type) return '<span class="code-type">' + type + '</span>';
                    if (number) return '<span class="code-number">' + number + '</span>';
                    return match;
                }
            );
        }

        function renderVisibleRows() {
            const viewport = document.getElementById("gridViewport");
            const container = document.getElementById("virtualContainer");
            
            const scrollTop = viewport.scrollTop;
            const viewportHeight = viewport.clientHeight || 800;
            
            let startRow = Math.floor(scrollTop / ROW_HEIGHT);
            let endRow = startRow + Math.ceil(viewportHeight / ROW_HEIGHT);
            
            startRow = Math.max(0, startRow - 5);
            endRow = Math.min(totalRows - 1, endRow + 5);
            
            container.innerHTML = "";
            const fragment = document.createDocumentFragment();

            for (let rowIdx = startRow; rowIdx <= endRow; rowIdx++) {
                const offset = rowIdx * BYTES_PER_LINE;
                
                const rowDiv = document.createElement("div");
                rowDiv.className = "hex-row grid-layout";
                rowDiv.style.position = "absolute";
                rowDiv.style.top = "0";
                rowDiv.style.left = "0";
                rowDiv.style.right = "0";
                rowDiv.style.transform = "translateY(" + (rowIdx * ROW_HEIGHT) + "px)";

                const offsetSpan = document.createElement("div");
                offsetSpan.className = "col-offset";
                offsetSpan.textContent = offset.toString(16).toUpperCase().padStart(8, '0');
                rowDiv.appendChild(offsetSpan);

                rowDiv.appendChild(document.createElement("div"));

                for (let i = 0; i < 16; i++) {
                    if (i === 8) {
                        rowDiv.appendChild(document.createElement("div"));
                    }

                    const currentOffset = offset + i;
                    if (currentOffset >= fileBytes.length) {
                        const cell = document.createElement("span");
                        cell.className = "byte-cell";
                        cell.innerHTML = "&nbsp;&nbsp;";
                        rowDiv.appendChild(cell);
                    } else {
                        const val = fileBytes[currentOffset];
                        const hexStr = val.toString(16).toUpperCase().padStart(2, '0');
                        const isDirty = modifiedBytes.has(currentOffset);

                        const cell = document.createElement("span");
                        cell.className = "byte-cell " + getByteClass(val);
                        
                        const hlIndex = highlightArray[currentOffset];
                        if (hlIndex > 0) {
                            cell.classList.add(HL_CLASSES[hlIndex]);
                        }

                        cell.textContent = hexStr;
                        cell.dataset.offset = currentOffset;
                        cell.id = "hex-" + currentOffset;

                        if (isDirty) {
                            cell.classList.add("dirty");
                        }
                        applyCellSelectionStyle(cell, currentOffset);

                        cell.addEventListener("mouseenter", () => {
                            highlightSync(currentOffset, true);
                            if (isDragging) {
                                extendSelectionTo(currentOffset);
                            }
                        });
                        cell.addEventListener("mouseleave", () => highlightSync(currentOffset, false));
                        cell.addEventListener("mousedown", (e) => {
                            e.preventDefault();
                            isDragging = true;
                            if (e.shiftKey && selectedOffset !== null) {
                                extendSelectionTo(currentOffset);
                            } else {
                                startSelectionAt(currentOffset);
                            }
                        });

                        rowDiv.appendChild(cell);
                    }
                }

                rowDiv.appendChild(document.createElement("div"));

                for (let i = 0; i < 16; i++) {
                    const currentOffset = offset + i;
                    if (currentOffset >= fileBytes.length) {
                        const charCell = document.createElement("span");
                        charCell.className = "ascii-cell";
                        charCell.innerHTML = "&nbsp;";
                        rowDiv.appendChild(charCell);
                    } else {
                        const val = fileBytes[currentOffset];
                        const isDirty = modifiedBytes.has(currentOffset);

                        const charCell = document.createElement("span");
                        charCell.className = "ascii-cell";
                        
                        const hlIndex = highlightArray[currentOffset];
                        if (hlIndex > 0) {
                            charCell.classList.add(HL_CLASSES[hlIndex]);
                        }

                        if (isPrintable(val)) {
                            charCell.textContent = String.fromCharCode(val);
                            charCell.classList.add("ascii-printable");
                        } else {
                            charCell.textContent = ".";
                            charCell.classList.add("ascii-nonprintable");
                        }
                        charCell.dataset.offset = currentOffset;
                        charCell.id = "ascii-" + currentOffset;

                        if (isDirty) {
                            charCell.classList.add("dirty");
                        }
                        applyCellSelectionStyle(charCell, currentOffset);

                        charCell.addEventListener("mouseenter", () => {
                            highlightSync(currentOffset, true);
                            if (isDragging) {
                                extendSelectionTo(currentOffset);
                            }
                        });
                        charCell.addEventListener("mouseleave", () => highlightSync(currentOffset, false));
                        charCell.addEventListener("mousedown", (e) => {
                            e.preventDefault();
                            isDragging = true;
                            if (e.shiftKey && selectedOffset !== null) {
                                extendSelectionTo(currentOffset);
                            } else {
                                startSelectionAt(currentOffset);
                            }
                        });

                        rowDiv.appendChild(charCell);
                    }
                }

                fragment.appendChild(rowDiv);
            }

            container.appendChild(fragment);
            applySearchHighlights();
        }

        // Listen for mouseup globally to terminate drag selection
        window.addEventListener("mouseup", () => {
            isDragging = false;
        });

        // Initialize Selection
        function startSelectionAt(offset) {
            nibbleBuffer = "";
            selectedOffset = offset;
            selectionStart = offset;
            selectionEnd = offset;
            
            updateSelectionsUI();
            updateInspector();
        }

        function extendSelectionTo(offset) {
            selectionEnd = offset;
            updateSelectionsUI();
            updateInspector();
        }

        function updateSelectionsUI() {
            const start = Math.min(selectionStart, selectionEnd);
            const end = Math.max(selectionStart, selectionEnd);

            const renderedCells = document.querySelectorAll(".byte-cell, .ascii-cell");
            renderedCells.forEach(el => {
                const off = parseInt(el.dataset.offset, 10);
                
                el.classList.remove("selected");
                el.classList.remove("cursor-active");

                if (off >= start && off <= end) {
                    el.classList.add("selected");
                }
                
                if (off === selectedOffset && el.classList.contains("byte-cell")) {
                    el.classList.add("cursor-active");
                }
            });
        }

        function applyCellSelectionStyle(el, offset) {
            if (selectionStart !== null && selectionEnd !== null) {
                const start = Math.min(selectionStart, selectionEnd);
                const end = Math.max(selectionStart, selectionEnd);
                if (offset >= start && offset <= end) {
                    el.classList.add("selected");
                }
            }
            if (offset === selectedOffset && el.classList.contains("byte-cell")) {
                el.classList.add("cursor-active");
            }
        }

        function getByteClass(byte) {
            if (byte === 0) return "byte-null";
            if (byte === 0xFF) return "byte-special";
            if (byte >= 32 && byte <= 126) return "byte-ascii";
            if (byte < 32 || byte === 127) return "byte-control";
            return "byte-high";
        }

        function isPrintable(byte) {
            return byte >= 32 && byte <= 126;
        }

        function highlightSync(offset, enable) {
            const hexEl = document.getElementById("hex-" + offset);
            const asciiEl = document.getElementById("ascii-" + offset);
            if (hexEl) {
                if (enable) hexEl.classList.add("hovered");
                else hexEl.classList.remove("hovered");
            }
            if (asciiEl) {
                if (enable) asciiEl.classList.add("hovered");
                else asciiEl.classList.remove("hovered");
            }
        }

        function updateInspector() {
            if (selectionStart === null || selectionEnd === null) {
                document.getElementById("inspectorBody").innerHTML = '<span class="no-selection">Click a byte or drag selection to inspect values</span>';
                document.getElementById("byteInspectorText").textContent = "Offset: -";
                return;
            }

            const start = Math.min(selectionStart, selectionEnd);
            const end = Math.max(selectionStart, selectionEnd);
            const rangeSize = end - start + 1;

            if (rangeSize > 1) {
                document.getElementById("byteInspectorText").textContent = "Selection: 0x" + start.toString(16).toUpperCase() + " - 0x" + end.toString(16).toUpperCase();
                document.getElementById("inspectorBody").innerHTML = 
                    '<div class="inspector-item"><span class="inspector-label">Range Start:</span><span class="inspector-value">0x' + start.toString(16).toUpperCase() + '</span></div>' +
                    '<div class="inspector-item"><span class="inspector-label">Range End:</span><span class="inspector-value">0x' + end.toString(16).toUpperCase() + '</span></div>' +
                    '<div class="inspector-item"><span class="inspector-label">Selection Size:</span><span class="inspector-value">' + rangeSize + ' bytes</span></div>';
                return;
            }

            document.getElementById("byteInspectorText").textContent = "Offset: 0x" + selectedOffset.toString(16).toUpperCase() + " (" + selectedOffset + ")";

            const val = fileBytes[selectedOffset];
            const signed8 = new Int8Array([val])[0];
            const binStr = val.toString(2).padStart(8, '0');
            
            let u16LE = "-", u16BE = "-", u32LE = "-", u32BE = "-";
            if (selectedOffset + 1 < fileBytes.length) {
                const dataView = new DataView(fileBytes.buffer);
                u16LE = dataView.getUint16(selectedOffset, true);
                u16BE = dataView.getUint16(selectedOffset, false);
            }
            if (selectedOffset + 3 < fileBytes.length) {
                const dataView = new DataView(fileBytes.buffer);
                u32LE = dataView.getUint32(selectedOffset, true);
                u32BE = dataView.getUint32(selectedOffset, false);
            }

            const charRepr = isPrintable(val) ? "'" + String.fromCharCode(val) + "'" : "Control / Non-ASCII";

            const inspectorBody = document.getElementById("inspectorBody");
            inspectorBody.innerHTML = 
                '<div class="inspector-item"><span class="inspector-label">Hex:</span><span class="inspector-value">0x' + val.toString(16).toUpperCase().padStart(2, '0') + '</span></div>' +
                '<div class="inspector-item"><span class="inspector-label">Dec (Unsigned):</span><span class="inspector-value">' + val + '</span></div>' +
                '<div class="inspector-item"><span class="inspector-label">Dec (Signed):</span><span class="inspector-value">' + signed8 + '</span></div>' +
                '<div class="inspector-item"><span class="inspector-label">Binary:</span><span class="inspector-value">' + binStr + '</span></div>' +
                '<div class="inspector-item"><span class="inspector-label">Char:</span><span class="inspector-value">' + charRepr + '</span></div>' +
                '<div class="inspector-item"><span class="inspector-label">16-bit (LE):</span><span class="inspector-value">' + u16LE + '</span></div>' +
                '<div class="inspector-item"><span class="inspector-label">32-bit (LE):</span><span class="inspector-value">' + u32LE + '</span></div>';
        }

        function handleGlobalKeyDown(e) {
            if (!editorIsReadOnly && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
                e.preventDefault();
                saveChanges();
                return;
            }

            const activeEl = document.activeElement;
            if (activeEl && (activeEl.id === "searchInput" || activeEl.id === "offsetInput")) {
                return;
            }

            if (!editorIsReadOnly && selectedOffset !== null && selectionStart === selectionEnd) {
                const key = e.key.toLowerCase();
                const isHexChar = /^[0-9a-f]$/.test(key);

                if (isHexChar) {
                    e.preventDefault();
                    if (nibbleBuffer.length === 0) {
                        nibbleBuffer = key;
                        const hexCell = document.getElementById("hex-" + selectedOffset);
                        if (hexCell) {
                            hexCell.textContent = key.toUpperCase() + "_";
                            hexCell.classList.add("dirty");
                        }
                    } else {
                        nibbleBuffer += key;
                        const byteValue = parseInt(nibbleBuffer, 16);
                        
                        fileBytes[selectedOffset] = byteValue;
                        modifiedBytes.set(selectedOffset, byteValue);
                        nibbleBuffer = "";

                        const hexCell = document.getElementById("hex-" + selectedOffset);
                        const asciiCell = document.getElementById("ascii-" + selectedOffset);
                        if (hexCell) {
                            hexCell.textContent = byteValue.toString(16).toUpperCase().padStart(2, '0');
                            hexCell.className = "byte-cell cursor-active dirty " + getByteClass(byteValue);
                        }
                        if (asciiCell) {
                            asciiCell.textContent = isPrintable(byteValue) ? String.fromCharCode(byteValue) : ".";
                            asciiCell.classList.add("dirty");
                        }

                        document.getElementById("btnSave").style.display = "inline-block";

                        if (selectedOffset + 1 < fileBytes.length) {
                            navigateToOffset(selectedOffset + 1, false);
                        } else {
                            updateInspector();
                        }
                    }
                    return;
                }
            }

            if (selectedOffset !== null) {
                const step = BYTES_PER_LINE;
                let targetOffset = null;

                if (e.key === "ArrowLeft") {
                    e.preventDefault();
                    targetOffset = selectedOffset - 1;
                } else if (e.key === "ArrowRight") {
                    e.preventDefault();
                    targetOffset = selectedOffset + 1;
                } else if (e.key === "ArrowUp") {
                    e.preventDefault();
                    targetOffset = selectedOffset - step;
                } else if (e.key === "ArrowDown") {
                    e.preventDefault();
                    targetOffset = selectedOffset + step;
                }

                if (targetOffset !== null) {
                    if (targetOffset >= 0 && targetOffset < fileBytes.length) {
                        navigateToOffset(targetOffset, e.shiftKey);
                    }
                }
            }
        }

        function navigateToOffset(targetOffset, isShiftExtend) {
            nibbleBuffer = "";
            
            if (isShiftExtend) {
                extendSelectionTo(targetOffset);
            } else {
                startSelectionAt(targetOffset);
            }

            const targetRow = Math.floor(targetOffset / 16);
            const targetScrollTop = targetRow * ROW_HEIGHT;
            
            const viewport = document.getElementById("gridViewport");
            
            const scrollTop = viewport.scrollTop;
            const viewportHeight = viewport.clientHeight;
            if (targetScrollTop < scrollTop || targetScrollTop > scrollTop + viewportHeight - ROW_HEIGHT * 2) {
                viewport.scrollTop = Math.max(0, targetScrollTop - viewportHeight / 2);
            }
            
            // Ensure rows are immediately available
            renderVisibleRows();
            
            // Small highlight animation
            setTimeout(() => {
                const hexEl = document.getElementById("hex-" + targetOffset);
                if (hexEl) {
                    hexEl.style.transition = "all 0.2s";
                    hexEl.style.transform = "scale(1.2)";
                    setTimeout(() => hexEl.style.transform = "none", 200);
                }
            }, 50);
        }



        function jumpToOffset() {
            const input = document.getElementById("offsetInput");
            let targetStr = input.value.trim().toLowerCase();
            if (!targetStr) return;

            if (targetStr.startsWith("0x")) {
                targetStr = targetStr.slice(2);
            }

            let offset = parseInt(targetStr, 16);
            if (isNaN(offset)) {
                offset = parseInt(targetStr, 10);
            }

            if (isNaN(offset) || offset < 0 || offset >= fileBytes.length) {
                alert("Invalid address/offset. Range: 0 to 0x" + (fileBytes.length - 1).toString(16).toUpperCase());
                return;
            }

            navigateToOffset(offset, false);
        }

        if (vscodeApi) {
            vscodeApi.postMessage({ type: 'ready' });
        }
        
        function saveChanges() {
            if (editorIsReadOnly) return;
            
            let binary = "";
            const len = fileBytes.byteLength;
            for (let i = 0; i < len; i++) {
                binary += String.fromCharCode(fileBytes[i]);
            }
            const updatedBase64 = btoa(binary);

            vscodeApi.postMessage({
                type: 'save',
                base64Data: updatedBase64
            });

            modifiedBytes.clear();
            document.getElementById("btnSave").style.display = "none";
            
            renderVisibleRows();
        }

        function performSearch(direction) {
            const input = document.getElementById("searchInput");
            const searchVal = input.value.trim();
            if (!searchVal) return;

            if (input.dataset.lastSearch !== searchVal) {
                input.dataset.lastSearch = searchVal;
                searchResults = [];
                currentSearchIndex = -1;
                
                const hexPattern = searchVal.replace(/\\s+/g, '');
                const isHexSearch = /^[0-9a-fA-F]+$/.test(hexPattern) && hexPattern.length % 2 === 0;

                if (isHexSearch) {
                    const queryBytes = [];
                    for (let i = 0; i < hexPattern.length; i += 2) {
                        queryBytes.push(parseInt(hexPattern.slice(i, i + 2), 16));
                    }
                    findByteSequence(queryBytes);
                } else {
                    const queryBytes = Array.from(searchVal).map(char => char.charCodeAt(0));
                    findByteSequence(queryBytes);
                }
            }

            if (searchResults.length === 0) {
                alert("No occurrences found.");
                return;
            }

            currentSearchIndex = (currentSearchIndex + direction + searchResults.length) % searchResults.length;
            const matchOffset = searchResults[currentSearchIndex];

            navigateToOffset(matchOffset, false);


        }

        function findByteSequence(seq) {
            if (seq.length === 0) return;
            for (let i = 0; i <= fileBytes.length - seq.length; i++) {
                let match = true;
                for (let j = 0; j < seq.length; j++) {
                    if (fileBytes[i + j] !== seq[j]) {
                        match = false;
                        break;
                    }
                }
                if (match) {
                    searchResults.push(i);
                }
            }
        }

        function applySearchHighlights() {
            if (searchResults.length === 0) return;
            
            const searchVal = document.getElementById("searchInput").value.trim();
            const hexPattern = searchVal.replace(/\s+/g, '');
            const isHexSearch = /^[0-9a-fA-F]+$/.test(hexPattern) && hexPattern.length % 2 === 0;
            const matchLength = isHexSearch ? hexPattern.length / 2 : searchVal.length;

            searchResults.forEach(offset => {
                for (let k = 0; k < matchLength; k++) {
                    const currentOffset = offset + k;
                    const hexCell = document.getElementById("hex-" + currentOffset);
                    const asciiCell = document.getElementById("ascii-" + currentOffset);
                    if (hexCell) hexCell.classList.add("find-highlight");
                    if (asciiCell) asciiCell.classList.add("find-highlight");
                }
            });
        }

        function switchHexpatTab(tabName) {
            document.querySelectorAll(".hexpat-tab").forEach(tab => tab.classList.remove("active"));
            document.querySelectorAll(".hexpat-tab-content").forEach(content => content.classList.remove("active"));

            if (tabName === 'pattern') {
                document.getElementById("tabPattern").classList.add("active");
                document.getElementById("contentPattern").classList.add("active");
            } else if (tabName === 'ast') {
                document.getElementById("tabAST").classList.add("active");
                document.getElementById("contentAST").classList.add("active");
            }
        }

        // Real high-fidelity .hexpat runner
        function executePattern() {
            if (!currentPatternFilename) return;

            const activePattern = communityPatterns.find(p => p.filename === currentPatternFilename);
            const currentPatternContent = activePattern ? activePattern.content : "";

            const overlay = document.getElementById("runnerOverlay");
            overlay.classList.add("active");

            setTimeout(() => {
                overlay.classList.remove("active");
                
                // Clear highlights
                highlightArray = new Uint8Array(fileBytes.length);
                const astTree = document.getElementById("astTree");
                astTree.innerHTML = "";
                
                try {
                    if (currentPatternFilename === "sarc.hexpat") {
                        parseSarcPattern(astTree);
                        renderVisibleRows();
                        switchHexpatTab('ast');
                    } else if (currentPatternFilename === "aamp.hexpat") {
                        parseAampPattern(astTree);
                        renderVisibleRows();
                        switchHexpatTab('ast');
                    } else if (currentPatternFilename === "byml.hexpat") {
                        parseBymlPattern(astTree);
                        renderVisibleRows();
                        switchHexpatTab('ast');
                    } else {
                        // Dynamically evaluate via hexpyt on backend
                        astTree.innerHTML = '<div style="color: var(--vscode-descriptionForeground, #cccccc); font-weight: bold; text-align: center; padding-top: 30px;">Evaluating pattern via Hexpyt...</div>';
                        const base64Data = uint8ArrayToBase64(fileBytes);
                        vscodeApi.postMessage({ type: 'evaluate-hexpat', base64Data: base64Data, hexpatCode: currentPatternContent });
                    }
                } catch (e) {
                    console.error("[HexEditor] Parsing error:", e);
                    astTree.innerHTML = '<div style="color: var(--vscode-errorForeground, #ff6b6b); font-weight: bold; padding: 10px;">Parsing Error: ' + escapeHtml(e.message) + '</div>';
                }
            }, 550);
        }

        window.addEventListener('message', event => {
            const message = event.data;
            if (message.type === 'init') {
                // ...
            } else if (message.type === 'evaluate-hexpat-result') {
                const overlay = document.getElementById("runnerOverlay");
                if (overlay) overlay.classList.remove("active");
                const astTree = document.getElementById("astTree");
                if (astTree) {
                    astTree.innerHTML = "";
                    highlightArray.fill(0);
                    preHighlightAst(message.ast);
                    renderGenericAst(message.ast, astTree);
                }
                renderVisibleRows();
                switchHexpatTab('ast');
            } else if (message.type === 'evaluate-hexpat-error') {
                const overlay = document.getElementById("runnerOverlay");
                if (overlay) overlay.classList.remove("active");
                const astTree = document.getElementById("astTree");
                if (astTree) {
                    astTree.innerHTML = '<div style="color: var(--vscode-errorForeground, #ff6b6b); font-weight: bold; padding: 10px;">Evaluation Error: ' + escapeHtml(message.error) + '</div>';
                }
            }
        });

        function preHighlightAst(astNodes) {
            if (!astNodes || astNodes.length === 0) return;
            let colorIdx = 1;
            for (const node of astNodes) {
                const start = node.start_offset;
                const size  = node.size;
                if (start == null || size == null || isNaN(start) || isNaN(size)) continue; // guard
                const end = Math.min(start + size, highlightArray.length);
                for (let i = start; i < end; i++) {
                    highlightArray[i] = colorIdx;
                }
                colorIdx = (colorIdx % 8) + 1;
            }
        }

        function renderGenericAst(astNodes, container) {
            if (!astNodes || astNodes.length === 0) {
                container.innerHTML = '<div style="color: var(--vscode-gitDecoration-addedResourceForeground, #4ec9b0); font-weight: bold; text-align: center; padding-top: 30px;">Pattern evaluated successfully. (No structures found)</div>';
                return;
            }

            function processNode(node, parentEl, indent) {
                const isArray = node.type === "Array";
                const safeStart = node.start_offset ?? 0;
                const safeSize  = node.size ?? 1;

                const itemDiv = document.createElement("div");
                itemDiv.className = "ast-item";
                itemDiv.style.marginLeft = indent + "px";
                itemDiv.dataset.offset = String(safeStart);
                itemDiv.dataset.size   = String(safeSize);

                const hasChildren = node.children && node.children.length > 0;
                
                const rowDiv = document.createElement("div");
                rowDiv.className = "ast-row";
                rowDiv.onclick = (e) => {
                    const off = parseInt(itemDiv.dataset.offset, 10);
                    const sz = parseInt(itemDiv.dataset.size, 10);
                    const endOff = off + sz - 1;
                    selectAstRange(off, endOff >= off ? endOff : off, e);
                    if (hasChildren) {
                        toggleAstChildren(rowDiv);
                    }
                };

                let arrowHtml = "";
                if (hasChildren) {
                    // Start collapsed by default for deep items, but maybe expand top-level?
                    // We'll keep them expanded if indent == 0, else collapsed.
                    const isExpanded = indent === 0;
                    arrowHtml = '<span class="ast-arrow' + (isExpanded ? '' : ' collapsed') + '">' + (isExpanded ? '▼' : '▶') + '</span>';
                } else {
                    arrowHtml = '<span style="display:inline-block; width:16px;"></span>';
                }

                let valueHtml = "";
                if (node.value !== undefined) {
                    valueHtml = '<span class="ast-value">: ' + escapeHtml(node.value) + '</span>';
                } else {
                    valueHtml = '<span class="ast-value">: ' + escapeHtml(node.type) + '</span>';
                }

                const endOffset = safeStart + safeSize - 1;
                const offsetHtml = '<span class="ast-offset">0x' + safeStart.toString(16).toUpperCase().padStart(2, '0') +
                    (safeSize > 1 ? ' - 0x' + endOffset.toString(16).toUpperCase().padStart(2, '0') : '') + '</span>';

                rowDiv.innerHTML = arrowHtml +
                    '<span class="ast-name">' + escapeHtml(node.name) + '</span>' +
                    valueHtml + offsetHtml;

                itemDiv.appendChild(rowDiv);

                if (hasChildren) {
                    const childrenDiv = document.createElement("div");
                    const isExpanded = indent === 0;
                    childrenDiv.className = "ast-children" + (isExpanded ? "" : " collapsed");
                    node.children.forEach(child => {
                        processNode(child, childrenDiv, 16);
                    });
                    itemDiv.appendChild(childrenDiv);
                }

                parentEl.appendChild(itemDiv);
            }

            astNodes.forEach(node => {
                processNode(node, container, 0);
            });
        }

        function parseSarcPattern(astTree) {
            if (fileBytes.length < 20) {
                throw new Error("File too small to contain a valid SARC header.");
            }
            
            const view = new DataView(fileBytes.buffer);
            const magic = String.fromCharCode(fileBytes[0], fileBytes[1], fileBytes[2], fileBytes[3]);
            if (magic !== 'SARC') {
                throw new Error("Invalid SARC Magic: expected 'SARC', got '" + magic + "'");
            }
            
            const headerSize = view.getUint16(4, true);
            const byteOrder = view.getUint16(6, true);
            const isLE = (byteOrder === 0xFFFE);
            const fileSize = view.getUint32(8, isLE);
            const dataOffset = view.getUint32(12, isLE);
            const version = view.getUint32(16, isLE);
            
            // Mark header highlight
            for (let i = 0; i < 20; i++) {
                highlightArray[i] = 1;
            }
            
            let headerHtml = 
                '<div class="ast-item">' +
                    '<div class="ast-row" onclick="selectAstRange(0, 19, event); toggleAstChildren(this)">' +
                        '<span class="ast-arrow">▼</span>' +
                        '<span class="ast-name">header</span>' +
                        '<span class="ast-value">SarcHeader</span>' +
                        '<span class="ast-offset">0x00 - 0x13</span>' +
                    '</div>' +
                    '<div class="ast-children">' +
                        '<div class="ast-row" onclick="selectAstRange(0, 3, event)"><span class="ast-name">magic</span>: <span class="ast-value">"SARC"</span><span class="ast-offset">0x00</span></div>' +
                        '<div class="ast-row" onclick="selectAstRange(4, 5, event)"><span class="ast-name">headerSize</span>: <span class="ast-value">' + headerSize + '</span><span class="ast-offset">0x04</span></div>' +
                        '<div class="ast-row" onclick="selectAstRange(6, 7, event)"><span class="ast-name">byteOrder</span>: <span class="ast-value">0x' + byteOrder.toString(16).toUpperCase() + '</span><span class="ast-offset">0x06</span></div>' +
                        '<div class="ast-row" onclick="selectAstRange(8, 11, event)"><span class="ast-name">fileSize</span>: <span class="ast-value">' + fileSize + '</span><span class="ast-offset">0x08</span></div>' +
                        '<div class="ast-row" onclick="selectAstRange(12, 15, event)"><span class="ast-name">dataOffset</span>: <span class="ast-value">' + dataOffset + '</span><span class="ast-offset">0x0C</span></div>' +
                        '<div class="ast-row" onclick="selectAstRange(16, 19, event)"><span class="ast-name">version</span>: <span class="ast-value">0x' + version.toString(16).toUpperCase() + '</span><span class="ast-offset">0x10</span></div>' +
                    '</div>' +
                '</div>';
                
            astTree.innerHTML += headerHtml;

            const sfatOffset = headerSize;
            if (fileBytes.length < sfatOffset + 12) {
                return;
            }
            
            const sfatMagic = String.fromCharCode(fileBytes[sfatOffset], fileBytes[sfatOffset+1], fileBytes[sfatOffset+2], fileBytes[sfatOffset+3]);
            if (sfatMagic !== 'SFAT') {
                throw new Error("Invalid SFAT Header: expected 'SFAT', got '" + sfatMagic + "'");
            }
            
            const sfatHeaderSize = view.getUint16(sfatOffset + 4, isLE);
            const nodeCount = view.getUint16(sfatOffset + 6, isLE);
            const hashMultiplier = view.getUint32(sfatOffset + 8, isLE);
            
            for (let i = sfatOffset; i < sfatOffset + 12; i++) {
                highlightArray[i] = 2;
            }
            
            let sfatHeaderHtml = 
                '<div class="ast-item" style="margin-top: 6px;">' +
                    '<div class="ast-row" onclick="selectAstRange(' + sfatOffset + ', ' + (sfatOffset + 11) + ', event); toggleAstChildren(this)">' +
                        '<span class="ast-arrow">▼</span>' +
                        '<span class="ast-name">sfatHeader</span>' +
                        '<span class="ast-value">SFATHeader</span>' +
                        '<span class="ast-offset">0x' + sfatOffset.toString(16).toUpperCase() + ' - 0x' + (sfatOffset + 11).toString(16).toUpperCase() + '</span>' +
                    '</div>' +
                    '<div class="ast-children">' +
                        '<div class="ast-row" onclick="selectAstRange(' + sfatOffset + ', ' + (sfatOffset + 3) + ', event)"><span class="ast-name">magic</span>: <span class="ast-value">"SFAT"</span><span class="ast-offset">0x' + sfatOffset.toString(16).toUpperCase() + '</span></div>' +
                        '<div class="ast-row" onclick="selectAstRange(' + (sfatOffset + 4) + ', ' + (sfatOffset + 5) + ', event)"><span class="ast-name">headerSize</span>: <span class="ast-value">' + sfatHeaderSize + '</span><span class="ast-offset">0x' + (sfatOffset + 4).toString(16).toUpperCase() + '</span></div>' +
                        '<div class="ast-row" onclick="selectAstRange(' + (sfatOffset + 6) + ', ' + (sfatOffset + 7) + ', event)"><span class="ast-name">nodeCount</span>: <span class="ast-value">' + nodeCount + '</span><span class="ast-offset">0x' + (sfatOffset + 6).toString(16).toUpperCase() + '</span></div>' +
                        '<div class="ast-row" onclick="selectAstRange(' + (sfatOffset + 8) + ', ' + (sfatOffset + 11) + ', event)"><span class="ast-name">hashMultiplier</span>: <span class="ast-value">0x' + hashMultiplier.toString(16).toUpperCase() + '</span><span class="ast-offset">0x' + (sfatOffset + 8).toString(16).toUpperCase() + '</span></div>' +
                    '</div>' +
                '</div>';
                
            astTree.innerHTML += sfatHeaderHtml;

            const nodesStart = sfatOffset + sfatHeaderSize;
            const nodesEnd = nodesStart + nodeCount * 16;
            
            if (fileBytes.length < nodesEnd) {
                throw new Error("File too small to contain all " + nodeCount + " SFAT nodes.");
            }
            
            let sfatNodesHtml = 
                '<div class="ast-item" style="margin-top: 6px;">' +
                    '<div class="ast-row" onclick="selectAstRange(' + nodesStart + ', ' + (nodesEnd - 1) + ', event); toggleAstChildren(this)">' +
                        '<span class="ast-arrow collapsed">▶</span>' +
                        '<span class="ast-name">nodes</span>' +
                        '<span class="ast-value">SFATNode[' + nodeCount + ']</span>' +
                        '<span class="ast-offset">0x' + nodesStart.toString(16).toUpperCase() + ' - 0x' + (nodesEnd - 1).toString(16).toUpperCase() + '</span>' +
                    '</div>' +
                    '<div class="ast-children collapsed">';
            
            for (let i = 0; i < nodeCount; i++) {
                const nodeOff = nodesStart + i * 16;
                const nameHash = view.getUint32(nodeOff, isLE);
                const fileAttrs = view.getUint32(nodeOff + 4, isLE);
                const startOff = view.getUint32(nodeOff + 8, isLE);
                const endOff = view.getUint32(nodeOff + 12, isLE);
                
                const hlIdx = (i % 2 === 0) ? 3 : 4;
                for (let k = 0; k < 16; k++) {
                    highlightArray[nodeOff + k] = hlIdx;
                }
                
                const actualFileStart = dataOffset + startOff;
                const actualFileEnd = dataOffset + endOff;
                if (actualFileStart < fileBytes.length && actualFileEnd <= fileBytes.length && actualFileStart < actualFileEnd) {
                    for (let f = actualFileStart; f < actualFileEnd; f++) {
                        highlightArray[f] = 6;
                    }
                }
                
                sfatNodesHtml += 
                    '<div class="ast-item" style="margin-left: 8px; margin-top: 2px;">' +
                        '<div class="ast-row" onclick="selectAstRange(' + nodeOff + ', ' + (nodeOff + 15) + ', event); toggleAstChildren(this)">' +
                            '<span class="ast-arrow collapsed">▶</span>' +
                            '<span class="ast-name">nodes[' + i + ']</span>' +
                            '<span class="ast-value">SFATNode</span>' +
                            '<span class="ast-offset">0x' + nodeOff.toString(16).toUpperCase() + '</span>' +
                        '</div>' +
                        '<div class="ast-children collapsed">' +
                            '<div class="ast-row" onclick="selectAstRange(nodeOff, nodeOff + 3, event)"><span class="ast-name">nameHash</span>: <span class="ast-value">0x' + nameHash.toString(16).toUpperCase() + '</span></div>' +
                            '<div class="ast-row" onclick="selectAstRange(nodeOff + 4, nodeOff + 7, event)"><span class="ast-name">fileAttrs</span>: <span class="ast-value">0x' + fileAttrs.toString(16).toUpperCase() + '</span></div>' +
                            '<div class="ast-row" onclick="selectAstRange(nodeOff + 8, nodeOff + 11, event)"><span class="ast-name">startOffset</span>: <span class="ast-value">' + startOff + ' (0x' + actualFileStart.toString(16).toUpperCase() + ')</span></div>' +
                            '<div class="ast-row" onclick="selectAstRange(nodeOff + 12, nodeOff + 15, event)"><span class="ast-name">endOffset</span>: <span class="ast-value">' + endOff + ' (0x' + actualFileEnd.toString(16).toUpperCase() + ')</span></div>' +
                        '</div>' +
                    '</div>';
            }
            sfatNodesHtml += '</div></div>';
            astTree.innerHTML += sfatNodesHtml;

            const sfntOffset = nodesEnd;
            if (sfntOffset + 8 <= fileBytes.length) {
                const sfntMagic = String.fromCharCode(fileBytes[sfntOffset], fileBytes[sfntOffset+1], fileBytes[sfntOffset+2], fileBytes[sfntOffset+3]);
                if (sfntMagic === 'SFNT') {
                    const sfntHeaderSize = view.getUint16(sfntOffset + 4, isLE);
                    
                    for (let i = sfntOffset; i < sfntOffset + 8; i++) {
                        highlightArray[i] = 5;
                    }

                    let sfntHtml = 
                        '<div class="ast-item" style="margin-top: 6px;">' +
                            '<div class="ast-row" onclick="selectAstRange(' + sfntOffset + ', ' + (sfntOffset + 7) + ', event); toggleAstChildren(this)">' +
                                '<span class="ast-arrow">▼</span>' +
                                '<span class="ast-name">sfntHeader</span>' +
                                '<span class="ast-value">SFNTHeader</span>' +
                                '<span class="ast-offset">0x' + sfntOffset.toString(16).toUpperCase() + '</span>' +
                            '</div>' +
                            '<div class="ast-children">' +
                                '<div class="ast-row" onclick="selectAstRange(' + sfntOffset + ', ' + (sfntOffset + 3) + ', event)"><span class="ast-name">magic</span>: <span class="ast-value">"SFNT"</span></div>' +
                                '<div class="ast-row" onclick="selectAstRange(' + (sfntOffset + 4) + ', ' + (sfntOffset + 5) + ', event)"><span class="ast-name">headerSize</span>: <span class="ast-value">' + sfntHeaderSize + '</span></div>' +
                            '</div>' +
                        '</div>';
                    astTree.innerHTML += sfntHtml;
                }
            }
        }

        function parseAampPattern(astTree) {
            if (fileBytes.length < 28) {
                throw new Error("File too small to contain a valid AAMP header.");
            }
            
            const view = new DataView(fileBytes.buffer);
            const magic = String.fromCharCode(fileBytes[0], fileBytes[1], fileBytes[2], fileBytes[3]);
            if (magic !== 'AAMP') {
                throw new Error("Invalid AAMP Magic: expected 'AAMP', got '" + magic + "'");
            }
            
            const version = view.getUint32(4, true);
            const flags = view.getUint32(8, true);
            const fileSize = view.getUint32(12, true);
            const pioOffset = view.getUint32(16, true);
            const parameterCount = view.getUint32(20, true);
            const pioCount = view.getUint32(24, true);
            
            for (let i = 0; i < 28; i++) {
                highlightArray[i] = 7;
            }
            
            const pioSectionStart = pioOffset;
            const pioSectionEnd = pioSectionStart + pioCount * 8;
            if (pioSectionStart < fileBytes.length && pioSectionEnd <= fileBytes.length) {
                for (let k = pioSectionStart; k < pioSectionEnd; k++) {
                    highlightArray[k] = 2;
                }
            }
            
            let headerHtml = 
                '<div class="ast-item">' +
                    '<div class="ast-row" onclick="selectAstRange(0, 27, event); toggleAstChildren(this)">' +
                        '<span class="ast-arrow">▼</span>' +
                        '<span class="ast-name">header</span>' +
                        '<span class="ast-value">AampHeader</span>' +
                        '<span class="ast-offset">0x00 - 0x1B</span>' +
                    '</div>' +
                    '<div class="ast-children">' +
                        '<div class="ast-row" onclick="selectAstRange(0, 3, event)"><span class="ast-name">magic</span>: <span class="ast-value">"AAMP"</span><span class="ast-offset">0x00</span></div>' +
                        '<div class="ast-row" onclick="selectAstRange(4, 7, event)"><span class="ast-name">version</span>: <span class="ast-value">' + version + '</span><span class="ast-offset">0x04</span></div>' +
                        '<div class="ast-row" onclick="selectAstRange(8, 11, event)"><span class="ast-name">flags</span>: <span class="ast-value">0x' + flags.toString(16).toUpperCase() + '</span><span class="ast-offset">0x08</span></div>' +
                        '<div class="ast-row" onclick="selectAstRange(12, 15, event)"><span class="ast-name">fileSize</span>: <span class="ast-value">' + fileSize + '</span><span class="ast-offset">0x0C</span></div>' +
                        '<div class="ast-row" onclick="selectAstRange(16, 19, event)"><span class="ast-name">pioOffset</span>: <span class="ast-value">' + pioOffset + '</span><span class="ast-offset">0x10</span></div>' +
                        '<div class="ast-row" onclick="selectAstRange(20, 23, event)"><span class="ast-name">parameterCount</span>: <span class="ast-value">' + parameterCount + '</span><span class="ast-offset">0x14</span></div>' +
                        '<div class="ast-row" onclick="selectAstRange(24, 27, event)"><span class="ast-name">pioCount</span>: <span class="ast-value">' + pioCount + '</span><span class="ast-offset">0x18</span></div>' +
                    '</div>' +
                '</div>';
                
            astTree.innerHTML += headerHtml;
        }

        function parseBymlPattern(astTree) {
            if (fileBytes.length < 20) {
                throw new Error("File too small to contain a valid BYML header.");
            }
            
            const view = new DataView(fileBytes.buffer);
            const magic = String.fromCharCode(fileBytes[0], fileBytes[1]);
            const isLE = (magic === "BY");
            const version = view.getUint16(2, isLE);
            const hashOffset = view.getUint32(4, isLE);
            const stringTableOffset = view.getUint32(8, isLE);
            const pathsOffset = view.getUint32(12, isLE);
            const rootOffset = view.getUint32(16, isLE);
            
            for (let i = 0; i < 20; i++) {
                highlightArray[i] = 8;
            }
            
            if (stringTableOffset > 0 && stringTableOffset < fileBytes.length) {
                const endStringTable = pathsOffset > 0 ? pathsOffset : (rootOffset > 0 ? rootOffset : fileBytes.length);
                for (let k = stringTableOffset; k < Math.min(endStringTable, fileBytes.length); k++) {
                    highlightArray[k] = 2;
                }
            }
            
            let headerHtml = 
                '<div class="ast-item">' +
                    '<div class="ast-row" onclick="selectAstRange(0, 19, event); toggleAstChildren(this)">' +
                        '<span class="ast-arrow">▼</span>' +
                        '<span class="ast-name">header</span>' +
                        '<span class="ast-value">BymlHeader</span>' +
                        '<span class="ast-offset">0x00 - 0x13</span>' +
                    '</div>' +
                    '<div class="ast-children">' +
                        '<div class="ast-row" onclick="selectAstRange(0, 1, event)"><span class="ast-name">magic</span>: <span class="ast-value">"' + magic + '"</span><span class="ast-offset">0x00</span></div>' +
                        '<div class="ast-row" onclick="selectAstRange(2, 3, event)"><span class="ast-name">version</span>: <span class="ast-value">' + version + '</span><span class="ast-offset">0x02</span></div>' +
                        '<div class="ast-row" onclick="selectAstRange(4, 7, event)"><span class="ast-name">hashOffset</span>: <span class="ast-value">' + hashOffset + '</span><span class="ast-offset">0x04</span></div>' +
                        '<div class="ast-row" onclick="selectAstRange(8, 11, event)"><span class="ast-name">stringTableOffset</span>: <span class="ast-value">' + stringTableOffset + '</span><span class="ast-offset">0x08</span></div>' +
                        '<div class="ast-row" onclick="selectAstRange(12, 15, event)"><span class="ast-name">pathsOffset</span>: <span class="ast-value">' + pathsOffset + '</span><span class="ast-offset">0x0C</span></div>' +
                        '<div class="ast-row" onclick="selectAstRange(16, 19, event)"><span class="ast-name">rootOffset</span>: <span class="ast-value">' + rootOffset + '</span><span class="ast-offset">0x10</span></div>' +
                    '</div>' +
                '</div>';
                
            astTree.innerHTML += headerHtml;
        }

        function selectAstRange(start, end, event) {
            event.stopPropagation();
            selectedOffset = start;
            selectionStart = start;
            selectionEnd   = end;
            updateSelectionsUI();
            updateInspector();

            // Scroll to start — inline the scroll logic instead of calling
            // navigateToOffset() which would clobber selectionEnd via startSelectionAt()
            const targetRow       = Math.floor(start / 16);
            const targetScrollTop = targetRow * ROW_HEIGHT;
            const viewport        = document.getElementById("gridViewport");
            const viewportHeight  = viewport.clientHeight;
            if (targetScrollTop < viewport.scrollTop ||
                targetScrollTop > viewport.scrollTop + viewportHeight - ROW_HEIGHT * 2) {
                viewport.scrollTop = Math.max(0, targetScrollTop - viewportHeight / 2);
            }
            renderVisibleRows();

            // Flash animation on the first byte only
            setTimeout(() => {
                const hexEl = document.getElementById("hex-" + start);
                if (hexEl) {
                    hexEl.style.transition = "all 0.2s";
                    hexEl.style.transform = "scale(1.2)";
                    setTimeout(() => hexEl.style.transform = "none", 200);
                }
            }, 50);
        }

        function toggleAstChildren(el) {
            const row = el.closest(".ast-row") || el;
            const item = row.closest(".ast-item");
            const children = item.querySelector(".ast-children");
            const arrow = row.querySelector(".ast-arrow");
            if (!children) return;
            if (children.classList.contains("collapsed")) {
                children.classList.remove("collapsed");
                arrow.classList.remove("collapsed");
                arrow.textContent = "▼";
            } else {
                children.classList.add("collapsed");
                arrow.classList.add("collapsed");
                arrow.textContent = "▶";
            }
        }

        // Format helper functions
        function formatBytes(bytes) {
            if (bytes < 1024) return bytes + " B";
            if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
            return (bytes / (1024 * 1024)).toFixed(2) + " MB";
        }

        function escapeHtml(value) {
            if (value === undefined || value === null) return "";
            return String(value)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;');
        }

        function uint8ArrayToBase64(bytes) {
            let binary = '';
            const len = bytes.byteLength;
            for (let i = 0; i < len; i++) {
                binary += String.fromCharCode(bytes[i]);
            }
            return btoa(binary);
        }
    </script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) {
        return bytes + " B";
    }
    if (bytes < 1024 * 1024) {
        return (bytes / 1024).toFixed(1) + " KB";
    }
    return (bytes / (1024 * 1024)).toFixed(2) + " MB";
}