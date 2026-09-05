import * as vscode from 'vscode';

/**
 * Webview markup for the AINB node graph editor.
 *
 * The visual language (type colours, node header colours, body ordering, the
 * auto-layout algorithm) is ported from Starlight's ImGui AINB editor so files
 * laid out in one tool read the same way in the other.
 *
 * The webview script deliberately avoids template literals: this whole document
 * is itself a template literal, and nesting them invites escaping mistakes.
 */
export function getAinbGraphViewHtml(_webview: vscode.Webview, fileName: string): string {
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(fileName)}</title>
<style>
    :root {
        --bg: var(--vscode-editor-background);
        --fg: var(--vscode-editor-foreground);
        --panel-bg: var(--vscode-sideBar-background, var(--vscode-editorWidget-background));
        --panel-fg: var(--vscode-sideBar-foreground, var(--vscode-editor-foreground));
        --border: var(--vscode-widget-border, rgba(128,128,128,0.35));
        --hover: var(--vscode-list-hoverBackground);
        --active: var(--vscode-list-activeSelectionBackground);
        --active-fg: var(--vscode-list-activeSelectionForeground);
        --input-bg: var(--vscode-input-background);
        --input-fg: var(--vscode-input-foreground);
        --input-border: var(--vscode-input-border, rgba(128,128,128,0.35));
        --btn-bg: var(--vscode-button-background);
        --btn-fg: var(--vscode-button-foreground);
        --btn-hover: var(--vscode-button-hoverBackground);
        --node-bg: #232733;
        --node-border: #14161d;
        --node-fg: #e8ecf5;
        --grid: rgba(255,255,255,0.045);
        --grid-strong: rgba(255,255,255,0.09);
    }
    * { box-sizing: border-box; }
    html, body { height: 100%; margin: 0; padding: 0; overflow: hidden; }
    body {
        font-family: var(--vscode-font-family);
        font-size: var(--vscode-font-size, 13px);
        background: var(--bg);
        color: var(--fg);
    }
    #app { display: flex; flex-direction: column; height: 100vh; }

    /* ---------------- toolbar ---------------- */
    #toolbar {
        display: flex; align-items: center; gap: 6px;
        padding: 5px 8px; border-bottom: 1px solid var(--border);
        background: var(--panel-bg); flex: 0 0 auto; flex-wrap: wrap;
    }
    #toolbar .sep { width: 1px; height: 18px; background: var(--border); margin: 0 3px; }
    #toolbar .spacer { flex: 1 1 auto; }
    button {
        font-family: inherit; font-size: 12px;
        background: var(--btn-bg); color: var(--btn-fg);
        border: none; border-radius: 3px; padding: 4px 9px; cursor: pointer;
    }
    button:hover:not(:disabled) { background: var(--btn-hover); }
    button:disabled { opacity: 0.4; cursor: default; }
    button.flat {
        background: transparent; color: var(--fg);
        border: 1px solid var(--border);
    }
    button.flat:hover:not(:disabled) { background: var(--hover); }
    input[type="text"], input[type="number"], select, textarea {
        font-family: inherit; font-size: 12px;
        background: var(--input-bg); color: var(--input-fg);
        border: 1px solid var(--input-border); border-radius: 3px; padding: 3px 5px;
    }
    input:focus, select:focus, textarea:focus { outline: 1px solid var(--vscode-focusBorder); }
    #zoomLabel { font-variant-numeric: tabular-nums; opacity: 0.75; min-width: 44px; text-align: right; }
    #fileLabel { opacity: 0.65; font-size: 12px; }
    .dirty-dot { color: var(--vscode-gitDecoration-modifiedResourceForeground, #e2c08d); }
    .ro-badge {
        background: var(--vscode-editorWarning-foreground, #cca700);
        color: #1b1b1b; border-radius: 3px; padding: 1px 6px;
        font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.4px;
    }

    /* ---------------- body / panels ---------------- */
    #bodyRow { display: flex; flex: 1 1 auto; min-height: 0; }
    .side {
        background: var(--panel-bg); color: var(--panel-fg);
        display: flex; flex-direction: column; min-height: 0; flex: 0 0 auto;
    }
    #left { width: 260px; border-right: 1px solid var(--border); }
    #right { width: 300px; border-left: 1px solid var(--border); }
    .side.collapsed { display: none; }
    .tabs { display: flex; border-bottom: 1px solid var(--border); flex: 0 0 auto; }
    .tab {
        flex: 1 1 0; text-align: center; padding: 6px 4px; cursor: pointer;
        font-size: 11px; text-transform: uppercase; letter-spacing: 0.4px; opacity: 0.7;
        border-bottom: 2px solid transparent; user-select: none;
    }
    .tab:hover { background: var(--hover); }
    .tab.active { opacity: 1; border-bottom-color: var(--vscode-focusBorder); }
    .panel { display: none; flex-direction: column; min-height: 0; flex: 1 1 auto; }
    .panel.active { display: flex; }
    .panel-scroll { overflow: auto; flex: 1 1 auto; padding: 6px; }
    .filter-row { padding: 6px; border-bottom: 1px solid var(--border); flex: 0 0 auto; display: flex; gap: 4px; }
    .filter-row input { flex: 1 1 auto; min-width: 0; }

    .list-item {
        padding: 4px 6px; border-radius: 3px; cursor: pointer;
        display: flex; align-items: baseline; gap: 6px; white-space: nowrap;
    }
    .list-item:hover { background: var(--hover); }
    .list-item.selected { background: var(--active); color: var(--active-fg); }
    .list-item .idx { opacity: 0.55; font-variant-numeric: tabular-nums; font-size: 11px; flex: 0 0 auto; }
    .list-item .nm { overflow: hidden; text-overflow: ellipsis; }
    .list-item .swatch { width: 8px; height: 8px; border-radius: 2px; flex: 0 0 auto; }
    .empty { opacity: 0.5; font-style: italic; padding: 10px 6px; font-size: 12px; }

    .group { margin-bottom: 10px; }
    .group > .group-title {
        font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px;
        opacity: 0.6; margin: 4px 2px 3px; display: flex; align-items: center; gap: 6px;
    }
    .group > .group-title .line { flex: 1 1 auto; height: 1px; background: var(--border); }

    .field { display: flex; flex-direction: column; gap: 3px; margin-bottom: 8px; }
    .field > label { font-size: 11px; opacity: 0.7; }
    .field input, .field select, .field textarea { width: 100%; }
    .row { display: flex; gap: 4px; align-items: center; }
    .row > * { min-width: 0; }
    .muted { opacity: 0.6; }
    .mono { font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; }
    .chip {
        display: inline-block; padding: 1px 6px; border-radius: 9px;
        background: rgba(128,128,128,0.22); font-size: 11px; margin: 0 3px 3px 0;
    }
    .danger { background: var(--vscode-inputValidation-errorBackground, #5a1d1d); color: var(--fg); }

    /* ---------------- graph ---------------- */
    #graphWrap {
        flex: 1 1 auto; position: relative; overflow: hidden; min-width: 0;
        background-color: #1b1e27;
        background-image:
            linear-gradient(var(--grid) 1px, transparent 1px),
            linear-gradient(90deg, var(--grid) 1px, transparent 1px),
            linear-gradient(var(--grid-strong) 1px, transparent 1px),
            linear-gradient(90deg, var(--grid-strong) 1px, transparent 1px);
        background-size: 24px 24px, 24px 24px, 120px 120px, 120px 120px;
        cursor: default;
    }
    #graphWrap.panning { cursor: grabbing; }
    #graphWrap.linking { cursor: crosshair; }
    #canvas { position: absolute; left: 0; top: 0; transform-origin: 0 0; }
    /* Promoting the canvas to its own compositor layer makes panning cheap, but a
       promoted layer keeps its texture rasterized at the scale it was created at and
       just stretches it - which turns node text to mush once you zoom in. So the
       promotion is only held while the view is actually moving; dropping it at rest
       makes the browser re-rasterize at the current zoom, crisply. */
    #canvas.interacting { will-change: transform; }
    #linkLayer { position: absolute; left: 0; top: 0; overflow: visible; pointer-events: none; }
    #linkLayer path.hit { pointer-events: stroke; cursor: pointer; }
    #nodeLayer { position: absolute; left: 0; top: 0; }

    .node {
        position: absolute;
        background: var(--node-bg); color: var(--node-fg);
        border: 1px solid var(--node-border);
        border-radius: 7px;
        min-width: 180px;
        box-shadow: 0 3px 10px rgba(0,0,0,0.42);
        font-size: 12px;
        user-select: none;
    }
    .node.selected { outline: 2px solid #ffb300; outline-offset: 1px; }
    .node.dimmed { opacity: 0.32; }
    .node-header {
        border-radius: 6px 6px 0 0; padding: 5px 9px;
        font-weight: 600; color: #12141a;
        display: flex; align-items: center; gap: 6px;
        cursor: move; position: relative;
    }
    .node-header .title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .node-index {
        position: absolute; top: -9px; right: 4px;
        background: rgba(100,80,80,0.86); border: 1px solid rgba(200,160,160,0.75);
        color: #fff; border-radius: 3px; padding: 0 3px;
        font-size: 10px; font-weight: 400; font-variant-numeric: tabular-nums;
    }
    .entry-badge {
        font-size: 10px; font-weight: 500; background: rgba(0,0,0,0.28);
        border-radius: 3px; padding: 0 4px;
    }
    .node-body { padding: 4px 0 6px; }
    .prow {
        display: flex; align-items: center; gap: 5px;
        padding: 1px 8px; min-height: 20px; white-space: nowrap;
    }
    .prow.out { justify-content: flex-end; }
    .prow .pname { overflow: hidden; text-overflow: ellipsis; }
    .prow .ptype { opacity: 0.5; font-size: 11px; }
    .prow .pval { margin-left: auto; display: flex; gap: 3px; align-items: center; }
    .prow.out .pval { margin-left: 0; }
    .prow input[type="text"], .prow input[type="number"] {
        background: rgba(0,0,0,0.3); border-color: rgba(255,255,255,0.14);
        color: var(--node-fg); padding: 1px 4px; font-size: 11px; height: 18px;
    }
    .prow input.num { width: 62px; }
    .prow input.str { width: 110px; }
    .prow input.vec { width: 46px; }
    .prow select.bbsel {
        background: rgba(247,195,33,0.16); color: #f7c321;
        border: 1px solid rgba(247,195,33,0.4); border-radius: 3px;
        font-size: 11px; padding: 0 2px; height: 18px; max-width: 150px;
    }
    .prow .srcbtn {
        background: rgba(255,255,255,0.09); color: var(--node-fg);
        border: 1px solid rgba(255,255,255,0.16); border-radius: 3px;
        font-size: 10px; line-height: 1; padding: 3px 4px; cursor: pointer;
    }
    .prow .srcbtn:hover { background: rgba(255,255,255,0.2); }
    .prow input[type="checkbox"] { margin: 0; }
    .prow .bbref, .prow .exprref {
        font-size: 10px; padding: 0 4px; border-radius: 3px;
        background: rgba(247,195,33,0.2); color: #f7c321;
    }
    .prow .exprref { background: rgba(195,124,243,0.2); color: #c37cf3; }

    .pin {
        width: 11px; height: 11px; border-radius: 50%;
        border: 2px solid; flex: 0 0 auto; cursor: crosshair;
        background: #202020;
    }
    .pin.connected { background: currentColor; }
    .pin:hover { transform: scale(1.35); }
    .pin.flow {
        border-radius: 2px; width: 0; height: 0; background: transparent;
        border-style: solid; border-width: 6px 0 6px 9px;
        border-color: transparent transparent transparent currentColor;
    }
    .pin.flow.hollow { border-left-color: rgba(255,255,255,0.32); }
    .pin.flow-wrap { position: relative; }
    .flowpin-box {
        width: 11px; height: 12px; display: flex; align-items: center;
        justify-content: center; flex: 0 0 auto; cursor: crosshair;
    }
    .internal-sep {
        margin: 5px 8px 3px; border-top: 1px solid rgba(255,255,255,0.28);
        padding-top: 4px; font-size: 11px; opacity: 0.65;
    }

    /* ---------------- context menu ---------------- */
    #ctxMenu {
        position: fixed; z-index: 60; min-width: 190px; padding: 4px;
        background: var(--vscode-menu-background, var(--panel-bg));
        color: var(--vscode-menu-foreground, var(--fg));
        border: 1px solid var(--border); border-radius: 5px;
        box-shadow: 0 6px 20px rgba(0,0,0,0.5); display: none;
    }
    #ctxMenu .mi { padding: 5px 10px; border-radius: 3px; cursor: pointer; font-size: 12px; white-space: nowrap; }
    #ctxMenu .mi:hover { background: var(--vscode-menu-selectionBackground, var(--hover)); }
    #ctxMenu .mi.disabled { opacity: 0.4; cursor: default; }
    #ctxMenu .mi.disabled:hover { background: transparent; }
    #ctxMenu .msep { height: 1px; background: var(--border); margin: 4px 2px; }
    #ctxMenu .mhead { padding: 4px 10px; font-size: 10px; text-transform: uppercase; opacity: 0.55; }

    /* ---------------- node picker ---------------- */
    #picker {
        position: fixed; inset: 0; z-index: 70; display: none;
        align-items: flex-start; justify-content: center;
        background: rgba(0,0,0,0.45); padding-top: 12vh;
    }
    #picker.show { display: flex; }
    #picker .box {
        width: min(680px, 90vw); max-height: 70vh; display: flex; flex-direction: column;
        background: var(--panel-bg); border: 1px solid var(--border);
        border-radius: 7px; box-shadow: 0 12px 40px rgba(0,0,0,0.55); overflow: hidden;
    }
    #picker .head { padding: 10px; border-bottom: 1px solid var(--border); display: flex; gap: 8px; align-items: center; }
    #picker .head input { flex: 1 1 auto; font-size: 13px; padding: 6px 8px; }
    #pickerCount { font-size: 11px; opacity: 0.6; white-space: nowrap; }
    #pickerResults { overflow: auto; }
    .pick {
        display: flex; align-items: center; gap: 8px; padding: 5px 10px;
        cursor: pointer; font-size: 12px; white-space: nowrap;
    }
    .pick:hover, .pick.active { background: var(--active); color: var(--active-fg); }
    .pick .pnm { overflow: hidden; text-overflow: ellipsis; flex: 1 1 auto; }
    .pick .pmeta { font-size: 11px; opacity: 0.6; flex: 0 0 auto; }

    /* ---------------- dialog ---------------- */
    #dialog {
        position: fixed; inset: 0; z-index: 80; display: none;
        align-items: flex-start; justify-content: center;
        background: rgba(0,0,0,0.45); padding-top: 18vh;
    }
    #dialog.show { display: flex; }
    #dialog .box {
        width: min(400px, 90vw); background: var(--panel-bg);
        border: 1px solid var(--border); border-radius: 7px;
        box-shadow: 0 12px 40px rgba(0,0,0,0.55); overflow: hidden;
    }
    #dialog .head { padding: 10px 12px; border-bottom: 1px solid var(--border); font-weight: 600; }
    #dialogBody { padding: 12px; display: flex; flex-direction: column; gap: 10px; }
    #dialogBody label { font-size: 11px; opacity: 0.7; display: block; margin-bottom: 3px; }
    #dialogBody input, #dialogBody select { width: 100%; }
    #dialog .foot {
        padding: 10px 12px; border-top: 1px solid var(--border);
        display: flex; justify-content: flex-end; gap: 6px;
    }

    /* ---------------- overlays ---------------- */
    #status {
        position: absolute; left: 10px; bottom: 10px; z-index: 20;
        background: rgba(0,0,0,0.62); color: #fff; border-radius: 4px;
        padding: 4px 9px; font-size: 11px; pointer-events: none; display: none;
    }
    #loading {
        position: absolute; inset: 0; z-index: 30; display: flex;
        align-items: center; justify-content: center; flex-direction: column; gap: 10px;
        background: var(--bg); color: var(--fg);
    }
    #loading.hidden { display: none; }
    #errorBox {
        position: absolute; inset: 0; z-index: 40; display: none;
        align-items: center; justify-content: center; padding: 30px;
        background: var(--bg);
    }
    #errorBox.show { display: flex; }
    #errorBox .inner { max-width: 620px; }
    #errorBox pre {
        white-space: pre-wrap; word-break: break-word; font-size: 12px;
        background: var(--panel-bg); border: 1px solid var(--border);
        border-radius: 4px; padding: 10px; max-height: 320px; overflow: auto;
    }
    .legend {
        position: absolute; right: 10px; bottom: 10px; z-index: 20;
        background: rgba(0,0,0,0.55); border-radius: 4px; padding: 6px 8px;
        font-size: 10px; display: flex; flex-direction: column; gap: 3px; pointer-events: none;
    }
    .legend .li { display: flex; align-items: center; gap: 5px; color: #ddd; }
    .legend .sw { width: 10px; height: 3px; border-radius: 2px; }
</style>
</head>
<body>
<div id="app">
    <div id="toolbar">
        <button id="btnSave" title="Save (Ctrl+S)">Save</button>
        <div class="sep"></div>
        <button class="flat" id="btnUndo" title="Undo (Ctrl+Z)">Undo</button>
        <button class="flat" id="btnRedo" title="Redo (Ctrl+Y)">Redo</button>
        <div class="sep"></div>
        <button class="flat" id="btnAddNode" title="Add a node from the type catalog (A)">+ Node</button>
        <div class="sep"></div>
        <button class="flat" id="btnAutoLayout" title="Arrange all nodes automatically">Auto Layout</button>
        <button class="flat" id="btnFit" title="Fit graph to view (F)">Fit</button>
        <div class="sep"></div>
        <button class="flat" id="btnZoomOut">&minus;</button>
        <span id="zoomLabel">100%</span>
        <button class="flat" id="btnZoomIn">+</button>
        <div class="sep"></div>
        <button class="flat" id="btnExportLayout" title="Save node positions to a .json file">Export Layout</button>
        <button class="flat" id="btnImportLayout" title="Load node positions from a .json file">Import Layout</button>
        <div class="spacer"></div>
        <span id="fileLabel"></span>
        <div class="sep"></div>
        <button class="flat" id="btnToggleLeft" title="Toggle left panel">&#9776;</button>
        <button class="flat" id="btnToggleRight" title="Toggle details panel">&#8942;</button>
    </div>

    <div id="bodyRow">
        <div class="side" id="left">
            <div class="tabs">
                <div class="tab active" data-tab="nodes">Nodes</div>
                <div class="tab" data-tab="commands">Commands</div>
                <div class="tab" data-tab="blackboard">Blackboard</div>
            </div>
            <div class="panel active" data-panel="nodes">
                <div class="filter-row"><input type="text" id="nodeFilter" placeholder="Filter nodes..."></div>
                <div class="panel-scroll" id="nodeList"></div>
            </div>
            <div class="panel" data-panel="commands">
                <div class="filter-row"><button class="flat" id="btnAddCommand" style="flex:1 1 auto">+ Add Command</button></div>
                <div class="panel-scroll" id="commandList"></div>
            </div>
            <div class="panel" data-panel="blackboard">
                <div class="filter-row"><button class="flat" id="btnAddBB" style="flex:1 1 auto">+ Add Parameter</button></div>
                <div class="panel-scroll" id="bbList"></div>
            </div>
        </div>

        <div id="graphWrap">
            <div id="canvas">
                <svg id="linkLayer"><g id="linkGroup"></g><path id="tempLink" fill="none" stroke="#ffb300" stroke-width="2" stroke-dasharray="5 4" style="display:none"></path></svg>
                <div id="nodeLayer"></div>
            </div>
            <div id="status"></div>
            <div class="legend">
                <div class="li"><span class="sw" style="background:#ffffff"></span>Flow</div>
                <div class="li"><span class="sw" style="background:#22d7a8"></span>Int</div>
                <div class="li"><span class="sw" style="background:#00a3ea"></span>Bool</div>
                <div class="li"><span class="sw" style="background:#a2fa54"></span>Float</div>
                <div class="li"><span class="sw" style="background:#f700ce"></span>String</div>
                <div class="li"><span class="sw" style="background:#f7c321"></span>Vec3f</div>
                <div class="li"><span class="sw" style="background:#c37cf3"></span>UserDefined</div>
                <div class="li"><span class="sw" style="background:#ebc828"></span>Cross-category</div>
            </div>
            <div id="loading"><div>Decoding AINB&hellip;</div></div>
            <div id="errorBox"><div class="inner"><h3>Could not open this AINB file</h3><pre id="errorText"></pre></div></div>
        </div>

        <div class="side" id="right">
            <div class="tabs"><div class="tab active">Details</div></div>
            <div class="panel active"><div class="panel-scroll" id="details"></div></div>
        </div>
    </div>
</div>
<div id="ctxMenu"></div>
<div id="picker">
    <div class="box">
        <div class="head">
            <input type="text" id="pickerSearch" placeholder="Search node types..." autocomplete="off">
            <span id="pickerCount"></span>
        </div>
        <div id="pickerResults"></div>
    </div>
</div>
<div id="dialog">
    <div class="box">
        <div class="head"><span id="dialogTitle"></span></div>
        <div id="dialogBody"></div>
        <div class="foot">
            <button class="flat" id="dialogCancel">Cancel</button>
            <button id="dialogOk">OK</button>
        </div>
    </div>
</div>

<script>
(function () {
    'use strict';
    var vscode = acquireVsCodeApi();

    // ---------------------------------------------------------------- constants
    // Value-type ordering and colours are Starlight's, so graphs read identically
    // in both editors. The AINB library's dict keys differ in name only.
    var PARAM_TYPES = ['Int', 'Bool', 'Float', 'String', 'Vector3F', 'Pointer'];
    var TYPE_LABEL = { Int: 'Int', Bool: 'Bool', Float: 'Float', String: 'String', Vector3F: 'Vec3f', Pointer: 'UserDefined' };
    var TYPE_COLOR = {
        Int: '#22d7a8', Bool: '#00a3ea', Float: '#a2fa54',
        String: '#f700ce', Vector3F: '#f7c321', Pointer: '#c37cf3', Flow: '#ffffff'
    };
    var CROSS_COLOR = '#ebc828';
    var QUERY_COLOR = '#8a97b0';
    // Plug arrays that carry control flow. Generic/Int/String plugs mirror data
    // links that are already drawn from the consuming input parameter, so drawing
    // them again would double every selector edge.
    var FLOW_PLUGS = ['Child', 'Transition'];
    var BB_TYPES = ['S32', 'F32', 'Bool', 'String', 'Vec3f', 'Pointer'];
    var BB_TYPE_COLOR = {
        S32: '#22d7a8', F32: '#a2fa54', Bool: '#00a3ea',
        String: '#f700ce', Vec3f: '#f7c321', Pointer: '#c37cf3'
    };
    var ELEMENT_NODE_TYPES = [
        'UserDefined', 'Element_S32Selector', 'Element_Sequential', 'Element_Simultaneous',
        'Element_F32Selector', 'Element_StringSelector', 'Element_RandomSelector',
        'Element_BoolSelector', 'Element_Fork', 'Element_Join', 'Element_Alert',
        'Element_Expression', 'Element_ModuleIF_Input_S32', 'Element_ModuleIF_Input_F32',
        'Element_ModuleIF_Input_Vec3f', 'Element_ModuleIF_Input_String',
        'Element_ModuleIF_Input_Bool', 'Element_ModuleIF_Input_Ptr',
        'Element_ModuleIF_Output_S32', 'Element_ModuleIF_Output_F32',
        'Element_ModuleIF_Output_Vec3f', 'Element_ModuleIF_Output_String',
        'Element_ModuleIF_Output_Bool', 'Element_ModuleIF_Output_Ptr',
        'Element_ModuleIF_Child', 'Element_StateEnd', 'Element_SplitTiming'
    ];
    var NODE_FLAGS = ['Is Query', 'Is Module', 'Is Root Node'];

    // ---------------------------------------------------------------- state
    var doc = null;            // authoritative AINB dict (mirrored from the extension)
    var layout = {};           // node index -> { x, y }
    var geom = {};             // node index -> measured size + pin offsets
    var nodeEls = {};          // node index -> DOM element
    var selectedNodes = [];    // node indices
    var selectedLink = null;
    var clipboard = null;
    var view = { x: 60, y: 60, z: 1 };
    var canUndo = false, canRedo = false, isDirty = false, readOnly = false;
    var activeTab = 'nodes';
    var nodeFilterText = '';
    var pendingLink = null;
    var nodeDefs = [];         // catalog from Starlight's definition database
    var nodeDefByName = {};    // name -> definition
    var consumedOutputs = {};  // "node:outputIndex" -> true, for pin fill state

    var graphWrap = document.getElementById('graphWrap');
    var canvasEl = document.getElementById('canvas');
    var nodeLayer = document.getElementById('nodeLayer');
    var linkGroup = document.getElementById('linkGroup');
    var linkLayer = document.getElementById('linkLayer');
    var tempLink = document.getElementById('tempLink');
    var ctxMenu = document.getElementById('ctxMenu');
    var statusEl = document.getElementById('status');

    // ---------------------------------------------------------------- helpers
    function esc(s) {
        return String(s === undefined || s === null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }
    function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }
    function nodes() { return (doc && doc.Nodes) || []; }
    function nodeAt(i) { var n = nodes(); return (i >= 0 && i < n.length) ? n[i] : null; }
    function inputsOf(n) { return (n.Parameters && n.Parameters.Inputs) || {}; }
    function outputsOf(n) { return (n.Parameters && n.Parameters.Outputs) || {}; }
    function propsOf(n) { return n.Properties || {}; }
    function plugsOf(n) { return n.Plugs || {}; }

    /**
     * "<node>:<outputIndex>" for every output something reads. An input's declared
     * type is only a hint at which category holds the source, so consumption is
     * tracked by index alone - the same way the link resolver falls back.
     */
    function computeConsumedOutputs(list) {
        var all = list || nodes();
        var consumed = {};
        function mark(ni, oi) {
            if (ni !== undefined && ni >= 0) { consumed[ni + ':' + (oi || 0)] = true; }
        }
        for (var i = 0; i < all.length; i++) {
            var ins = (all[i].Parameters && all[i].Parameters.Inputs) || {};
            for (var t = 0; t < PARAM_TYPES.length; t++) {
                var params = ins[PARAM_TYPES[t]] || [];
                for (var p = 0; p < params.length; p++) {
                    mark(params[p]['Node Index'], params[p]['Output Index']);
                    var sources = params[p].Sources || [];
                    for (var s = 0; s < sources.length; s++) {
                        mark(sources[s]['Node Index'], sources[s]['Output Index']);
                    }
                }
            }
        }
        return consumed;
    }

    /**
     * Recompute the flags the format derives from graph structure. Retail files never
     * mark an unused output, and always flag a node that something queries - breaking
     * either makes the writer fail.
     */
    function normalizeDerivedFlags(list) {
        var consumed = computeConsumedOutputs(list);
        for (var i = 0; i < list.length; i++) {
            var n = list[i];
            var outs = (n.Parameters && n.Parameters.Outputs) || {};
            for (var t = 0; t < PARAM_TYPES.length; t++) {
                var params = outs[PARAM_TYPES[t]] || [];
                for (var o = 0; o < params.length; o++) {
                    if (!consumed[i + ':' + o]) { params[o]['Is Output'] = false; }
                }
            }
        }
        for (var c = 0; c < list.length; c++) {
            var qs = list[c].Queries || [];
            for (var q = 0; q < qs.length; q++) {
                var target = list[qs[q]];
                if (!target) { continue; }
                if (!target.Flags) { target.Flags = []; }
                if (target.Flags.indexOf('Is Query') === -1) { target.Flags.push('Is Query'); }
            }
        }
        return list;
    }
    function nodeTitle(n) {
        if (n.Name) { return n.Name; }
        return n['Node Type'] || 'Node';
    }
    function nodeHeaderColor(n) {
        var t = n['Node Type'];
        if (t && t !== 'UserDefined') { return '#ff8080'; }
        if ((n.Name || '').indexOf('.module') !== -1) { return '#80ff80'; }
        return '#80c3f8';
    }
    function showStatus(msg, ms) {
        statusEl.textContent = msg;
        statusEl.style.display = 'block';
        if (showStatus._t) { clearTimeout(showStatus._t); }
        showStatus._t = setTimeout(function () { statusEl.style.display = 'none'; }, ms || 2200);
    }

    /** Value at a path like ['Nodes', 3, 'Name']. */
    function getPath(root, path) {
        var cur = root;
        for (var i = 0; i < path.length; i++) {
            if (cur === undefined || cur === null) { return undefined; }
            cur = cur[path[i]];
        }
        return cur;
    }
    function setPath(root, path, value) {
        var cur = root;
        for (var i = 0; i < path.length - 1; i++) { cur = cur[path[i]]; }
        if (value === undefined) { delete cur[path[path.length - 1]]; }
        else { cur[path[path.length - 1]] = value; }
    }

    /**
     * Apply edits locally and forward them to the extension, which owns the undo
     * stack and the dirty state. Ops are {path, value}; value === undefined deletes.
     */
    function mutate(ops, label) {
        if (readOnly) {
            // Single choke point for every document change, so nothing can slip
            // through from a menu item or shortcut that forgot to check.
            showStatus('Read-only: this file comes from the game dump');
            return;
        }
        var payload = [];
        for (var i = 0; i < ops.length; i++) {
            payload.push({ path: ops[i].path, before: clone(getPath(doc, ops[i].path)), after: clone(ops[i].value) });
            setPath(doc, ops[i].path, ops[i].value);
        }
        vscode.postMessage({ type: 'edit', ops: payload, label: label || 'Edit' });
    }

    // ---------------------------------------------------------------- link model
    /**
     * Resolve which output pin a data link actually lands on. AINB groups outputs
     * into value-type categories, but a node's output for a given index is not
     * always stored under the category the consuming input declares (real game
     * files do this), so fall back to searching the other categories.
     */
    function resolveOutputPin(nodeIndex, type, outIndex) {
        var n = nodeAt(nodeIndex);
        if (!n || outIndex < 0) { return null; }
        var outs = outputsOf(n);
        if ((outs[type] || []).length > outIndex) {
            return { type: type, index: outIndex, cross: false };
        }
        for (var i = 0; i < PARAM_TYPES.length; i++) {
            var t = PARAM_TYPES[i];
            if (t === type) { continue; }
            if ((outs[t] || []).length > outIndex) {
                return { type: t, index: outIndex, cross: true };
            }
        }
        return null;
    }

    /**
     * Flow output pins to show on a node: every existing Child/Transition plug, plus
     * any flow output its definition declares that is not wired up yet. Without the
     * latter there would be nothing to drag from when giving a fresh node its first
     * child.
     */
    function flowOutSlots(n) {
        var slots = [];
        var plugs = plugsOf(n);
        var used = {};
        for (var f = 0; f < FLOW_PLUGS.length; f++) {
            var kind = FLOW_PLUGS[f];
            var arr = plugs[kind] || [];
            for (var i = 0; i < arr.length; i++) {
                slots.push({ kind: kind, index: i, plug: arr[i], label: plugLabel(kind, arr[i], i), bound: true });
                if (arr[i].Name) { used[arr[i].Name] = true; }
            }
        }
        var def = nodeDefByName[n.Name];
        if (def && def.flow) {
            for (var d = 0; d < def.flow.length; d++) {
                if (!used[def.flow[d]]) {
                    slots.push({ kind: 'Child', index: -1, plug: null, label: def.flow[d], bound: false, name: def.flow[d] });
                }
            }
        }
        return slots;
    }

    function plugLabel(kind, plug, i) {
        if (kind === 'Transition') {
            return 'Transition ' + (plug['Transition Type'] !== undefined ? plug['Transition Type'] : i);
        }
        if (plug.Name) { return plug.Name; }
        if (plug['Is Default']) { return 'Default'; }
        if (plug.Condition !== undefined) {
            var c = plug.Condition;
            if (c && typeof c === 'object') {
                if (c.Min !== undefined || c.Max !== undefined) {
                    return '[' + (c.Min !== undefined ? c.Min : '-inf') + ' .. ' + (c.Max !== undefined ? c.Max : 'inf') + ']';
                }
                return JSON.stringify(c);
            }
            return String(c);
        }
        return 'Child ' + i;
    }

    /** Every edge in the graph, as pin-to-pin references. */
    function collectLinks() {
        var out = [];
        var all = nodes();
        for (var ni = 0; ni < all.length; ni++) {
            var n = all[ni];

            // Data links: consumer input <- producer output
            var ins = inputsOf(n);
            for (var ti = 0; ti < PARAM_TYPES.length; ti++) {
                var type = PARAM_TYPES[ti];
                var list = ins[type] || [];
                for (var pi = 0; pi < list.length; pi++) {
                    var p = list[pi];
                    var srcs = [];
                    if (p['Node Index'] !== undefined && p['Node Index'] >= 0) {
                        srcs.push({ n: p['Node Index'], o: p['Output Index'] || 0, multi: -1 });
                    }
                    if (p.Sources) {
                        for (var si = 0; si < p.Sources.length; si++) {
                            var s = p.Sources[si];
                            if (s['Node Index'] !== undefined && s['Node Index'] >= 0) {
                                srcs.push({ n: s['Node Index'], o: s['Output Index'] || 0, multi: si });
                            }
                        }
                    }
                    for (var k = 0; k < srcs.length; k++) {
                        var r = resolveOutputPin(srcs[k].n, type, srcs[k].o);
                        if (!r) { continue; }
                        out.push({
                            kind: 'data',
                            from: { node: srcs[k].n, pin: 'out:' + r.type + ':' + r.index },
                            to: { node: ni, pin: 'in:' + type + ':' + pi },
                            color: r.cross ? CROSS_COLOR : TYPE_COLOR[type],
                            cross: r.cross,
                            ref: { node: ni, type: type, index: pi, multi: srcs[k].multi },
                            title: (nodeAt(srcs[k].n) ? nodeTitle(nodeAt(srcs[k].n)) : '?') + ' → ' + p.Name +
                                (r.cross ? '  (source output lives under ' + TYPE_LABEL[r.type] + ', not ' + TYPE_LABEL[type] + ')' : '')
                        });
                    }
                }
            }

            // Flow links: parent child-plug -> child node header
            var plugs = plugsOf(n);
            for (var fi = 0; fi < FLOW_PLUGS.length; fi++) {
                var kind = FLOW_PLUGS[fi];
                var arr = plugs[kind] || [];
                for (var qi = 0; qi < arr.length; qi++) {
                    var pl = arr[qi];
                    if (pl['Node Index'] === undefined || pl['Node Index'] < 0) { continue; }
                    if (!nodeAt(pl['Node Index'])) { continue; }
                    out.push({
                        kind: 'flow',
                        from: { node: ni, pin: 'flowout:' + kind + ':' + qi },
                        to: { node: pl['Node Index'], pin: 'flowin' },
                        color: TYPE_COLOR.Flow,
                        ref: { node: ni, plug: kind, index: qi },
                        title: nodeTitle(n) + ' → ' + plugLabel(kind, pl, qi)
                    });
                }
            }
        }
        return out;
    }

    // ---------------------------------------------------------------- rendering
    function render() {
        nodeLayer.innerHTML = '';
        nodeEls = {};
        geom = {};

        var all = nodes();
        consumedOutputs = computeConsumedOutputs(all);
        var entryPoints = {};
        var cmds = (doc && doc.Commands) || [];
        for (var ci = 0; ci < cmds.length; ci++) {
            var ri = cmds[ci]['Root Node Index'];
            if (ri !== undefined && ri >= 0) { entryPoints[ri] = cmds[ci].Name || 'Command'; }
        }

        for (var i = 0; i < all.length; i++) {
            var el = buildNode(all[i], i, entryPoints[i]);
            nodeLayer.appendChild(el);
            nodeEls[i] = el;
        }
        measureAll();
        ensureLayout();
        positionAll();
        drawLinks();
        renderSidePanels();
        renderDetails();
        applyTransform();
        applyReadOnlyUi();
    }

    /**
     * Grey out every control that would change the document. mutate() already
     * refuses the edit; this just stops the UI from inviting one. Panning, zooming,
     * selection, auto-layout and layout export stay live - none of them touch file
     * content, so browsing a dump file is still useful.
     */
    function applyReadOnlyUi() {
        if (!readOnly) { return; }
        var editable = document.querySelectorAll(
            '.node input, .node select, .node textarea, ' +
            '#commandList input, #commandList button, ' +
            '#bbList input, #bbList button, #btnAddBB, #btnAddCommand, ' +
            '#details input, #details select, #details button, #btnAddNode');
        for (var i = 0; i < editable.length; i++) {
            editable[i].disabled = true;
            editable[i].title = 'Read-only: this file comes from the game dump';
        }
        var pins = document.querySelectorAll('.pin');
        for (var p = 0; p < pins.length; p++) { pins[p].style.cursor = 'default'; }
    }

    function buildNode(n, index, entryName) {
        var el = document.createElement('div');
        el.className = 'node';
        el.dataset.index = String(index);

        var color = nodeHeaderColor(n);

        var head = document.createElement('div');
        head.className = 'node-header';
        head.style.background = color;

        var flowBox = document.createElement('div');
        flowBox.className = 'flowpin-box';
        flowBox.dataset.pin = 'flowin';
        flowBox.dataset.node = String(index);
        var flowPin = document.createElement('div');
        flowPin.className = 'pin flow';
        flowPin.style.color = '#12141a';
        flowBox.appendChild(flowPin);
        head.appendChild(flowBox);

        var title = document.createElement('span');
        title.className = 'title';
        title.textContent = nodeTitle(n);
        title.title = nodeTitle(n);
        head.appendChild(title);

        if (entryName !== undefined) {
            var badge = document.createElement('span');
            badge.className = 'entry-badge';
            badge.textContent = entryName;
            badge.title = 'Entry point: ' + entryName;
            head.appendChild(badge);
        }

        var idx = document.createElement('span');
        idx.className = 'node-index';
        idx.textContent = '#' + index;
        head.appendChild(idx);

        el.appendChild(head);

        var body = document.createElement('div');
        body.className = 'node-body';

        // Order mirrors Starlight: inputs, flow outputs, outputs, then properties.
        var ins = inputsOf(n);
        for (var ti = 0; ti < PARAM_TYPES.length; ti++) {
            var type = PARAM_TYPES[ti];
            var list = ins[type] || [];
            for (var pi = 0; pi < list.length; pi++) {
                body.appendChild(buildInputRow(n, index, type, pi, list[pi]));
            }
        }

        var slots = flowOutSlots(n);
        for (var fi = 0; fi < slots.length; fi++) {
            body.appendChild(buildFlowOutRow(index, slots[fi]));
        }

        var outs = outputsOf(n);
        for (var oi = 0; oi < PARAM_TYPES.length; oi++) {
            var otype = PARAM_TYPES[oi];
            var olist = outs[otype] || [];
            for (var ki = 0; ki < olist.length; ki++) {
                body.appendChild(buildOutputRow(index, otype, ki, olist[ki]));
            }
        }

        var props = propsOf(n);
        var hasProps = false;
        for (var pt = 0; pt < PARAM_TYPES.length; pt++) {
            if ((props[PARAM_TYPES[pt]] || []).length) { hasProps = true; break; }
        }
        if (hasProps) {
            var sep = document.createElement('div');
            sep.className = 'internal-sep';
            sep.textContent = 'Internal parameters';
            body.appendChild(sep);
            for (var qt = 0; qt < PARAM_TYPES.length; qt++) {
                var ptype = PARAM_TYPES[qt];
                var plist = props[ptype] || [];
                for (var vi = 0; vi < plist.length; vi++) {
                    body.appendChild(buildPropRow(index, ptype, vi, plist[vi]));
                }
            }
        }

        el.appendChild(body);
        return el;
    }

    function makePin(type, connected, kindClass) {
        var pin = document.createElement('div');
        pin.className = 'pin' + (connected ? ' connected' : '') + (kindClass ? ' ' + kindClass : '');
        pin.style.color = TYPE_COLOR[type] || '#fff';
        pin.style.borderColor = TYPE_COLOR[type] || '#fff';
        return pin;
    }

    function buildInputRow(n, index, type, pi, p) {
        var row = document.createElement('div');
        row.className = 'prow';
        var linked = (p['Node Index'] !== undefined && p['Node Index'] >= 0) ||
                     (p.Sources && p.Sources.length > 0);

        var box = document.createElement('div');
        box.className = 'flowpin-box';
        box.dataset.pin = 'in:' + type + ':' + pi;
        box.dataset.node = String(index);
        box.appendChild(makePin(type, linked));
        row.appendChild(box);

        var nm = document.createElement('span');
        nm.className = 'pname';
        nm.textContent = p.Name || '';
        row.appendChild(nm);

        var ty = document.createElement('span');
        ty.className = 'ptype';
        ty.textContent = '(' + (type === 'Pointer' && p.Classname ? p.Classname : TYPE_LABEL[type]) + ')';
        row.appendChild(ty);

        var paramPath = ['Nodes', index, 'Parameters', 'Inputs', type, pi];
        var val = document.createElement('span');
        val.className = 'pval';
        if (!linked && p['Blackboard Index'] === undefined && p['Expression Index'] === undefined) {
            buildValueEditor(val, type, p['Default Value'], function (v) {
                mutate([{ path: paramPath.concat(['Default Value']), value: v }],
                       'Set ' + (p.Name || 'value'));
            }, index);
        }
        buildSourceControl(val, index, paramPath, p, type, linked);
        row.appendChild(val);
        return row;
    }

    function buildOutputRow(index, type, oi, p) {
        var row = document.createElement('div');
        row.className = 'prow out';

        var ty = document.createElement('span');
        ty.className = 'ptype';
        ty.textContent = '(' + (type === 'Pointer' && p.Classname ? p.Classname : TYPE_LABEL[type]) + ')';

        var nm = document.createElement('span');
        nm.className = 'pname';
        nm.textContent = p.Name || '';

        row.appendChild(nm);
        row.appendChild(ty);

        var box = document.createElement('div');
        box.className = 'flowpin-box';
        box.dataset.pin = 'out:' + type + ':' + oi;
        box.dataset.node = String(index);
        // Filled only when something actually reads this output, matching Starlight.
        box.appendChild(makePin(type, !!consumedOutputs[index + ':' + oi]));
        row.appendChild(box);
        return row;
    }

    function buildFlowOutRow(index, slot) {
        var row = document.createElement('div');
        row.className = 'prow out';

        var nm = document.createElement('span');
        nm.className = 'pname';
        nm.textContent = slot.label;
        if (!slot.bound) {
            nm.classList.add('muted');
            nm.title = 'Declared by this node type but not connected yet';
        }
        row.appendChild(nm);

        var box = document.createElement('div');
        box.className = 'flowpin-box';
        // Unbound slots carry the plug name instead of an index; connecting one
        // appends a real Child plug.
        box.dataset.pin = slot.bound
            ? 'flowout:' + slot.kind + ':' + slot.index
            : 'flownew:' + slot.name;
        box.dataset.node = String(index);
        var pin = document.createElement('div');
        pin.className = 'pin flow' + (slot.bound ? '' : ' hollow');
        pin.style.color = '#ffffff';
        box.appendChild(pin);
        row.appendChild(box);
        return row;
    }

    function buildPropRow(index, type, vi, p) {
        var row = document.createElement('div');
        row.className = 'prow';

        var nm = document.createElement('span');
        nm.className = 'pname';
        nm.textContent = p.Name || '';
        row.appendChild(nm);

        var paramPath = ['Nodes', index, 'Properties', type, vi];
        var val = document.createElement('span');
        val.className = 'pval';
        if (p['Blackboard Index'] === undefined && p['Expression Index'] === undefined) {
            buildValueEditor(val, type, p['Default Value'], function (v) {
                mutate([{ path: paramPath.concat(['Default Value']), value: v }],
                       'Set ' + (p.Name || 'property'));
            }, index);
        }
        buildSourceControl(val, index, paramPath, p, type, false);
        row.appendChild(val);
        return row;
    }

    /** Param value type -> the blackboard section that can supply it. */
    var BB_TYPE_FOR_PARAM = {
        Int: 'S32', Bool: 'Bool', Float: 'F32',
        String: 'String', Vector3F: 'Vec3f', Pointer: 'Pointer',
    };

    function bbEntriesFor(paramType) {
        var section = BB_TYPE_FOR_PARAM[paramType];
        var bb = (doc && doc.Blackboard) || {};
        return (section && bb[section]) || [];
    }

    /**
     * Source switcher for a parameter: a literal value, or a reference to a
     * blackboard entry. The two are mutually exclusive - a blackboard reference is
     * encoded in the same flag word as the link, so the literal fields have to be
     * cleared when switching over (and restored when switching back).
     */
    function buildSourceControl(host, index, paramPath, param, type, isLinked) {
        var entries = bbEntriesFor(type);
        var usesBb = param['Blackboard Index'] !== undefined;

        if (param['Expression Index'] !== undefined) {
            var ex = document.createElement('span');
            ex.className = 'exprref';
            ex.textContent = 'EXB ' + param['Expression Index'];
            ex.title = 'Value computed by expression ' + param['Expression Index'];
            host.appendChild(ex);
            return;
        }

        if (usesBb) {
            var sel = document.createElement('select');
            sel.className = 'bbsel';
            for (var i = 0; i < entries.length; i++) {
                var opt = document.createElement('option');
                var bbIndex = entries[i]['Blackboard Index'] !== undefined ? entries[i]['Blackboard Index'] : i;
                opt.value = String(bbIndex);
                opt.textContent = entries[i].Name || ('BB ' + bbIndex);
                if (bbIndex === param['Blackboard Index']) { opt.selected = true; }
                sel.appendChild(opt);
            }
            if (!entries.length) {
                var missing = document.createElement('option');
                missing.textContent = 'BB ' + param['Blackboard Index'] + ' (missing)';
                missing.selected = true;
                sel.appendChild(missing);
            }
            sel.title = 'Reads the blackboard parameter';
            sel.addEventListener('mousedown', function (e) { e.stopPropagation(); });
            sel.addEventListener('change', function () {
                mutate([{ path: paramPath.concat(['Blackboard Index']), value: parseInt(sel.value, 10) || 0 }],
                       'Set blackboard source');
            });
            host.appendChild(sel);

            var revert = document.createElement('button');
            revert.className = 'srcbtn';
            revert.textContent = '×';
            revert.title = 'Use a literal value instead';
            revert.addEventListener('mousedown', function (e) { e.stopPropagation(); });
            revert.addEventListener('click', function () {
                var next = clone(param);
                delete next['Blackboard Index'];
                delete next['Vector Component'];
                next.Flags = ['Uses Default'];
                mutate([{ path: paramPath, value: next }], 'Use literal value');
                render();
            });
            host.appendChild(revert);
            return;
        }

        if (!isLinked && entries.length) {
            var toBb = document.createElement('button');
            toBb.className = 'srcbtn';
            toBb.textContent = 'BB';
            toBb.title = 'Read this value from a blackboard parameter';
            toBb.addEventListener('mousedown', function (e) { e.stopPropagation(); });
            toBb.addEventListener('click', function () {
                var next = clone(param);
                var first = entries[0]['Blackboard Index'];
                next['Blackboard Index'] = first !== undefined ? first : 0;
                next.Flags = [];
                if (next['Node Index'] !== undefined) {
                    next['Node Index'] = -1;
                    next['Output Index'] = 0;
                }
                delete next['Expression Index'];
                mutate([{ path: paramPath, value: next }], 'Use blackboard value');
                render();
            });
            host.appendChild(toBb);
        }
    }

    /** Inline editor widget matching the parameter's value type. */
    function buildValueEditor(host, type, value, onChange, nodeIndex) {
        function stop(e) { e.stopPropagation(); }
        function grew(el) {
            // The node can change width as the text grows, so its pins move.
            if (nodeIndex !== undefined) { measureNode(nodeIndex); drawLinks(); }
        }
        if (type === 'Bool') {
            var cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = !!value;
            cb.addEventListener('mousedown', stop);
            cb.addEventListener('change', function () { onChange(cb.checked); });
            host.appendChild(cb);
        } else if (type === 'Int' || type === 'Float') {
            var num = document.createElement('input');
            num.type = 'number';
            num.className = 'num';
            if (type === 'Float') { num.step = 'any'; }
            num.value = (value === undefined || value === null) ? 0 : value;
            num.addEventListener('mousedown', stop);
            num.addEventListener('input', function () { autoSizeInput(num, 48, 150); grew(); });
            num.addEventListener('change', function () {
                var v = type === 'Int' ? parseInt(num.value, 10) : parseFloat(num.value);
                if (isNaN(v)) { v = 0; }
                onChange(v);
            });
            host.appendChild(num);
            autoSizeInput(num, 48, 150);
        } else if (type === 'String') {
            var txt = document.createElement('input');
            txt.type = 'text';
            txt.className = 'str';
            txt.value = value === undefined || value === null ? '' : String(value);
            txt.title = txt.value;
            txt.addEventListener('mousedown', stop);
            txt.addEventListener('input', function () { autoSizeInput(txt, 70, 420); grew(); });
            txt.addEventListener('change', function () { onChange(txt.value); });
            host.appendChild(txt);
            // Sized to the value so long names are readable instead of clipped.
            autoSizeInput(txt, 70, 420);
        } else if (type === 'Vector3F') {
            var arr = Array.isArray(value) ? value : [0, 0, 0];
            for (var i = 0; i < 3; i++) {
                (function (comp) {
                    var f = document.createElement('input');
                    f.type = 'number';
                    f.step = 'any';
                    f.className = 'vec';
                    f.value = arr[comp] === undefined ? 0 : arr[comp];
                    f.addEventListener('mousedown', stop);
                    f.addEventListener('change', function () {
                        var next = [Number(arr[0]) || 0, Number(arr[1]) || 0, Number(arr[2]) || 0];
                        var v = parseFloat(f.value);
                        next[comp] = isNaN(v) ? 0 : v;
                        onChange(next);
                    });
                    host.appendChild(f);
                })(i);
            }
        }
        // Pointer values have no meaningful inline representation.
    }

    // ---------------------------------------------------------------- geometry
    var measureSpan = null;

    /** Width the given text would occupy in that element's font. */
    function textWidth(text, el) {
        if (!measureSpan) {
            measureSpan = document.createElement('span');
            measureSpan.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;top:-9999px;left:-9999px';
            document.body.appendChild(measureSpan);
        }
        var cs = window.getComputedStyle(el);
        measureSpan.style.font = cs.font || (cs.fontSize + ' ' + cs.fontFamily);
        measureSpan.textContent = text === undefined || text === null ? '' : String(text);
        return measureSpan.offsetWidth;
    }

    /** Grow a field to fit its value so long strings are readable, not clipped. */
    function autoSizeInput(el, min, max) {
        var width = textWidth(el.value, el) + 14;
        el.style.width = Math.round(Math.max(min, Math.min(max, width))) + 'px';
    }

    /** Re-measure a single node after its content changed size. */
    function measureNode(index) {
        var el = nodeEls[index];
        if (!el) { return; }
        var g = { w: el.offsetWidth, h: el.offsetHeight, pins: {} };
        var boxes = el.querySelectorAll('[data-pin]');
        for (var b = 0; b < boxes.length; b++) {
            var box = boxes[b];
            var x = box.offsetWidth / 2;
            var y = box.offsetHeight / 2;
            var cur = box;
            while (cur && cur !== el) {
                x += cur.offsetLeft;
                y += cur.offsetTop;
                cur = cur.offsetParent;
            }
            g.pins[box.dataset.pin] = { x: x + el.clientLeft, y: y + el.clientTop };
        }
        geom[index] = g;
    }

    function measureAll() {
        var all = nodes();
        for (var i = 0; i < all.length; i++) {
            var el = nodeEls[i];
            if (!el) { continue; }
            var g = { w: el.offsetWidth, h: el.offsetHeight, pins: {} };
            var boxes = el.querySelectorAll('[data-pin]');
            for (var b = 0; b < boxes.length; b++) {
                var box = boxes[b];
                // offsetLeft/offsetTop are relative to the nearest *positioned*
                // ancestor - which is .node itself, since the rows in between are
                // statically positioned. Walking offsetParent (rather than
                // parentElement) is what keeps the intermediate rows from being
                // counted twice and dragging every pin downward.
                var x = box.offsetWidth / 2;
                var y = box.offsetHeight / 2;
                var cur = box;
                while (cur && cur !== el) {
                    x += cur.offsetLeft;
                    y += cur.offsetTop;
                    cur = cur.offsetParent;
                }
                // offsetLeft/Top are measured from the node's padding edge, but the
                // node's canvas position is its border edge, so add the border back.
                g.pins[box.dataset.pin] = { x: x + el.clientLeft, y: y + el.clientTop };
            }
            geom[i] = g;
        }
    }

    function ensureLayout() {
        var all = nodes();
        var missing = [];
        for (var i = 0; i < all.length; i++) {
            if (!layout[i]) { missing.push(i); }
        }
        if (missing.length === all.length && all.length > 0) {
            autoLayout(true);
            return;
        }
        // Park any node without a stored position in a column beside the graph.
        var maxX = 0, maxY = 0;
        for (var k in layout) {
            if (Object.prototype.hasOwnProperty.call(layout, k)) {
                maxX = Math.max(maxX, layout[k].x);
                maxY = Math.max(maxY, layout[k].y);
            }
        }
        for (var m = 0; m < missing.length; m++) {
            layout[missing[m]] = { x: maxX + 420, y: 60 + m * 140 };
        }
    }

    function positionAll() {
        var all = nodes();
        for (var i = 0; i < all.length; i++) {
            var el = nodeEls[i];
            var pos = layout[i];
            if (!el || !pos) { continue; }
            el.style.transform = 'translate(' + pos.x + 'px,' + pos.y + 'px)';
        }
    }

    function pinPos(nodeIndex, pinKey) {
        var g = geom[nodeIndex];
        var pos = layout[nodeIndex];
        if (!g || !pos) { return null; }
        var p = g.pins[pinKey];
        if (!p) {
            // Pin no longer exists (e.g. link points at a removed parameter):
            // fall back to the node's left/right edge so the edge stays visible.
            var right = pinKey.indexOf('out:') === 0 || pinKey.indexOf('flowout:') === 0;
            return { x: pos.x + (right ? g.w : 0), y: pos.y + 14 };
        }
        return { x: pos.x + p.x, y: pos.y + p.y };
    }

    function bezier(a, b) {
        var dx = Math.max(40, Math.abs(b.x - a.x) * 0.5);
        return 'M ' + a.x + ' ' + a.y + ' C ' + (a.x + dx) + ' ' + a.y + ', ' +
               (b.x - dx) + ' ' + b.y + ', ' + b.x + ' ' + b.y;
    }

    function drawLinks() {
        while (linkGroup.firstChild) { linkGroup.removeChild(linkGroup.firstChild); }
        var links = collectLinks();
        var minX = 0, minY = 0, maxX = 100, maxY = 100;
        var all = nodes();
        for (var i = 0; i < all.length; i++) {
            var pos = layout[i], g = geom[i];
            if (!pos || !g) { continue; }
            minX = Math.min(minX, pos.x); minY = Math.min(minY, pos.y);
            maxX = Math.max(maxX, pos.x + g.w); maxY = Math.max(maxY, pos.y + g.h);
        }
        linkLayer.setAttribute('width', String(maxX - minX + 400));
        linkLayer.setAttribute('height', String(maxY - minY + 400));
        linkLayer.style.left = '0px';
        linkLayer.style.top = '0px';

        for (var li = 0; li < links.length; li++) {
            var lk = links[li];
            var a = pinPos(lk.from.node, lk.from.pin);
            var b = pinPos(lk.to.node, lk.to.pin);
            if (!a || !b) { continue; }
            var d = bezier(a, b);

            var hit = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            hit.setAttribute('d', d);
            hit.setAttribute('fill', 'none');
            hit.setAttribute('stroke', 'transparent');
            hit.setAttribute('stroke-width', '12');
            hit.setAttribute('class', 'hit');
            hit.dataset.link = String(li);
            linkGroup.appendChild(hit);

            var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            path.setAttribute('d', d);
            path.setAttribute('fill', 'none');
            path.setAttribute('stroke', lk.color);
            path.setAttribute('stroke-width', lk.kind === 'flow' ? '2.4' : '1.8');
            path.setAttribute('stroke-opacity', '0.92');
            if (selectedLink !== null && selectedLink.index === li) {
                path.setAttribute('stroke', '#ffb300');
                path.setAttribute('stroke-width', '3.4');
            }
            linkGroup.appendChild(path);

            var t = document.createElementNS('http://www.w3.org/2000/svg', 'title');
            t.textContent = lk.title || '';
            hit.appendChild(t);
        }
        drawLinks._cache = links;
    }

    var interactTimer = null;

    /** Hold the compositor promotion for the duration of a gesture, then let go. */
    function markInteracting() {
        canvasEl.classList.add('interacting');
        if (interactTimer) { clearTimeout(interactTimer); }
        interactTimer = setTimeout(function () {
            interactTimer = null;
            canvasEl.classList.remove('interacting');
        }, 180);
    }

    function applyTransform() {
        canvasEl.style.transform = 'translate(' + view.x + 'px,' + view.y + 'px) scale(' + view.z + ')';
        document.getElementById('zoomLabel').textContent = Math.round(view.z * 100) + '%';
        markInteracting();
        cull();
    }

    /** Hide off-screen nodes; large graphs otherwise cost far too much layout time. */
    function cull() {
        var rect = graphWrap.getBoundingClientRect();
        var margin = 200 / view.z;
        var vx0 = (-view.x) / view.z - margin;
        var vy0 = (-view.y) / view.z - margin;
        var vx1 = (rect.width - view.x) / view.z + margin;
        var vy1 = (rect.height - view.y) / view.z + margin;
        var all = nodes();
        for (var i = 0; i < all.length; i++) {
            var el = nodeEls[i], pos = layout[i], g = geom[i];
            if (!el || !pos || !g) { continue; }
            var vis = !(pos.x + g.w < vx0 || pos.x > vx1 || pos.y + g.h < vy0 || pos.y > vy1);
            el.style.visibility = vis ? 'visible' : 'hidden';
        }
    }

    function screenToCanvas(clientX, clientY) {
        var rect = graphWrap.getBoundingClientRect();
        return {
            x: (clientX - rect.left - view.x) / view.z,
            y: (clientY - rect.top - view.y) / view.z
        };
    }

    // ---------------------------------------------------------------- auto layout
    /**
     * Port of Starlight's AINB auto-layout: lay each command's tree out left to
     * right, place data providers to the left of their consumer and flow children
     * to the right, then resolve overlaps. Node sizes come from the real DOM here
     * rather than Starlight's estimates, so spacing is tighter.
     */
    function autoLayout(silent) {
        var all = nodes();
        if (!all.length) { return; }

        var HGAP = 150, VSEP = 20, GROUP_GAP = 100;
        var vn = [];
        for (var i = 0; i < all.length; i++) {
            var g = geom[i];
            vn.push({
                i: i, x: 0, y: 0, relY: 0, treeH: 0,
                w: g ? Math.max(320, Math.min(600, g.w)) : 320,
                h: g ? g.h + 20 : 140
            });
        }

        function flowChildren(idx) {
            var res = [];
            var plugs = plugsOf(all[idx]);
            for (var f = 0; f < FLOW_PLUGS.length; f++) {
                var arr = plugs[FLOW_PLUGS[f]] || [];
                for (var q = 0; q < arr.length; q++) {
                    var ni = arr[q]['Node Index'];
                    if (ni !== undefined && ni >= 0 && ni < all.length) { res.push(ni); }
                }
            }
            return res;
        }
        function dataProviders(idx) {
            var res = [];
            var ins = inputsOf(all[idx]);
            for (var t = 0; t < PARAM_TYPES.length; t++) {
                var list = ins[PARAM_TYPES[t]] || [];
                for (var p = 0; p < list.length; p++) {
                    var e = list[p];
                    if (e['Node Index'] !== undefined && e['Node Index'] > 0 && e['Node Index'] < all.length) {
                        res.push(e['Node Index']);
                    }
                    if (e.Sources) {
                        for (var s = 0; s < e.Sources.length; s++) {
                            var sn = e.Sources[s]['Node Index'];
                            if (sn !== undefined && sn > 0 && sn < all.length) { res.push(sn); }
                        }
                    }
                }
            }
            return res;
        }

        function calcTreeHeight(idx, visited) {
            if (visited.indexOf(idx) !== -1) { return; }
            visited.push(idx);

            var kids = flowChildren(idx);
            var childH = 0, childCount = 0;
            for (var c = 0; c < kids.length; c++) {
                childCount++;
                if (visited.indexOf(kids[c]) === -1) {
                    calcTreeHeight(kids[c], visited);
                    childH += vn[kids[c]].treeH;
                }
            }
            if (childCount > 0) { childH += (childCount - 1) * VSEP; }

            var provs = dataProviders(idx);
            var provH = 0, provCount = 0;
            for (var d = 0; d < provs.length; d++) {
                provCount++;
                if (visited.indexOf(provs[d]) === -1) {
                    calcTreeHeight(provs[d], visited);
                    provH += vn[provs[d]].treeH;
                }
            }
            if (provCount > 0) { provH += (provCount - 1) * VSEP; }

            vn[idx].treeH = Math.max(vn[idx].h, Math.max(childH, provH));

            var curY = -(childH / 2);
            for (var c2 = 0; c2 < kids.length; c2++) {
                var kn = vn[kids[c2]];
                if (visited.indexOf(kids[c2]) === -1 || kn.relY === 0) {
                    kn.relY = curY + kn.treeH / 2;
                    curY += kn.treeH + VSEP;
                }
            }
            curY = -(provH / 2);
            for (var d2 = 0; d2 < provs.length; d2++) {
                var pn = vn[provs[d2]];
                if (visited.indexOf(provs[d2]) === -1 || pn.relY === 0) {
                    pn.relY = curY + pn.treeH / 2;
                    curY += pn.treeH + VSEP;
                }
            }
        }

        function collides(x, y, w, h, placed) {
            var M = 20;
            for (var i2 = 0; i2 < placed.length; i2++) {
                var o = placed[i2];
                if (x < o.x + o.w + M && x + w + M > o.x && y < o.y + o.h + M && y + h + M > o.y) {
                    return true;
                }
            }
            return false;
        }
        function resolveY(x, y, w, h, placed) {
            if (!collides(x, y, w, h, placed)) { return y; }
            for (var off = 50; off < 5000; off += 50) {
                if (!collides(x, y + off, w, h, placed)) { return y + off; }
                if (!collides(x, y - off, w, h, placed)) { return y - off; }
            }
            return y;
        }

        function placeSubtree(idx, x, y, placed, bounds) {
            if (placed.indexOf(idx) !== -1) { return; }
            var finalY = resolveY(x, y, vn[idx].w, vn[idx].h, bounds);
            placed.push(idx);
            vn[idx].x = x;
            vn[idx].y = finalY;
            bounds.push({ x: x, y: finalY, w: vn[idx].w, h: vn[idx].h });

            var provs = dataProviders(idx);
            for (var d = 0; d < provs.length; d++) {
                if (placed.indexOf(provs[d]) === -1) {
                    placeSubtree(provs[d], x - vn[provs[d]].w - HGAP, finalY + vn[provs[d]].relY, placed, bounds);
                }
            }
            var kids = flowChildren(idx);
            for (var c = 0; c < kids.length; c++) {
                if (placed.indexOf(kids[c]) === -1) {
                    placeSubtree(kids[c], x + vn[idx].w + HGAP, finalY + vn[kids[c]].relY, placed, bounds);
                }
            }
        }

        function collectGroup(root, outSet, visited) {
            if (visited.indexOf(root) !== -1) { return; }
            visited.push(root);
            if (outSet.indexOf(root) === -1) { outSet.push(root); }
            var kids = flowChildren(root).concat(dataProviders(root));
            for (var i3 = 0; i3 < kids.length; i3++) { collectGroup(kids[i3], outSet, visited); }
        }

        var processed = [];
        var curY = 100;
        var cmds = (doc && doc.Commands) || [];
        for (var ci = 0; ci < cmds.length; ci++) {
            var root = cmds[ci]['Root Node Index'];
            if (root === undefined || root < 0 || root >= all.length) { continue; }
            var groupNodes = [];
            collectGroup(root, groupNodes, []);
            for (var gi = 0; gi < groupNodes.length; gi++) {
                if (processed.indexOf(groupNodes[gi]) === -1) { processed.push(groupNodes[gi]); }
                vn[groupNodes[gi]].relY = 0;
            }
            var placed = [], bounds = [];
            calcTreeHeight(root, []);
            placeSubtree(root, 100, curY, placed, bounds);
            var maxY = curY;
            for (var bi = 0; bi < bounds.length; bi++) { maxY = Math.max(maxY, bounds[bi].y + bounds[bi].h); }
            curY = maxY + GROUP_GAP;
        }

        // Anything not reachable from a command still needs a home.
        for (var oi = 0; oi < all.length; oi++) {
            if (processed.indexOf(oi) !== -1) { continue; }
            var orphanSet = [];
            collectGroup(oi, orphanSet, []);
            var isNew = false;
            for (var os = 0; os < orphanSet.length; os++) {
                if (processed.indexOf(orphanSet[os]) === -1) { processed.push(orphanSet[os]); isNew = true; }
                vn[orphanSet[os]].relY = 0;
            }
            if (!isNew) { continue; }
            var placed2 = [], bounds2 = [];
            calcTreeHeight(oi, []);
            placeSubtree(oi, 100, curY, placed2, bounds2);
            var maxY2 = curY;
            for (var b2 = 0; b2 < bounds2.length; b2++) { maxY2 = Math.max(maxY2, bounds2[b2].y + bounds2[b2].h); }
            curY = maxY2 + GROUP_GAP;
        }

        // Producers must end up strictly left of their consumers.
        var changed = true, iter = 0;
        while (changed && iter < 1000) {
            changed = false; iter++;
            for (var n1 = 0; n1 < all.length; n1++) {
                var provs2 = dataProviders(n1);
                for (var pv = 0; pv < provs2.length; pv++) {
                    var prov = vn[provs2[pv]];
                    var targetX = vn[n1].x - prov.w - HGAP;
                    if (prov.x > targetX) { prov.x = targetX; changed = true; }
                }
            }
        }

        // Greedy vertical separation pass.
        var M2 = 13, hadCollision = true, it2 = 0;
        while (hadCollision && it2 < 100) {
            hadCollision = false; it2++;
            for (var a1 = 0; a1 < vn.length; a1++) {
                for (var b1 = a1 + 1; b1 < vn.length; b1++) {
                    var A = vn[a1], B = vn[b1];
                    if (A.x < B.x + B.w + M2 && A.x + A.w + M2 > B.x &&
                        A.y < B.y + B.h + M2 && A.y + A.h + M2 > B.y) {
                        hadCollision = true;
                        if (B.y >= A.y) { B.y = A.y + A.h + M2; }
                        else { A.y = B.y + B.h + M2; }
                    }
                }
            }
        }

        for (var f2 = 0; f2 < vn.length; f2++) {
            layout[vn[f2].i] = { x: Math.round(vn[f2].x), y: Math.round(vn[f2].y) };
        }
        positionAll();
        drawLinks();
        saveLayout();
        if (!silent) { fitToView(); showStatus('Auto layout applied'); }
    }

    function fitToView() {
        var all = nodes();
        if (!all.length) { return; }
        var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (var i = 0; i < all.length; i++) {
            var pos = layout[i], g = geom[i];
            if (!pos || !g) { continue; }
            minX = Math.min(minX, pos.x); minY = Math.min(minY, pos.y);
            maxX = Math.max(maxX, pos.x + g.w); maxY = Math.max(maxY, pos.y + g.h);
        }
        if (minX === Infinity) { return; }
        var rect = graphWrap.getBoundingClientRect();
        var pad = 60;
        var zx = (rect.width - pad * 2) / Math.max(1, maxX - minX);
        var zy = (rect.height - pad * 2) / Math.max(1, maxY - minY);
        view.z = Math.max(0.08, Math.min(1.4, Math.min(zx, zy)));
        view.x = pad - minX * view.z + (rect.width - pad * 2 - (maxX - minX) * view.z) / 2;
        view.y = pad - minY * view.z + (rect.height - pad * 2 - (maxY - minY) * view.z) / 2;
        applyTransform();
    }

    function focusNode(index) {
        var pos = layout[index], g = geom[index];
        if (!pos || !g) { return; }
        var rect = graphWrap.getBoundingClientRect();
        view.z = Math.max(view.z, 0.6);
        view.x = rect.width / 2 - (pos.x + g.w / 2) * view.z;
        view.y = rect.height / 2 - (pos.y + g.h / 2) * view.z;
        applyTransform();
    }

    function saveLayout() {
        vscode.postMessage({ type: 'saveLayout', layout: layout, view: view });
    }

    // ---------------------------------------------------------------- selection
    function setSelection(indices) {
        selectedNodes = indices.slice();
        selectedLink = null;
        for (var k in nodeEls) {
            if (Object.prototype.hasOwnProperty.call(nodeEls, k)) {
                nodeEls[k].classList.toggle('selected', selectedNodes.indexOf(Number(k)) !== -1);
            }
        }
        renderDetails();
        renderNodeList();
        drawLinks();
    }

    // ---------------------------------------------------------------- side panels
    function renderSidePanels() {
        renderNodeList();
        renderCommandList();
        renderBlackboard();
    }

    function renderNodeList() {
        var host = document.getElementById('nodeList');
        var all = nodes();
        var filter = nodeFilterText.toLowerCase();
        var html = '';
        var shown = 0;
        for (var i = 0; i < all.length; i++) {
            var n = all[i];
            var label = nodeTitle(n);
            var hay = (i + ' ' + label + ' ' + (n['Node Type'] || '')).toLowerCase();
            if (filter && hay.indexOf(filter) === -1) { continue; }
            shown++;
            html += '<div class="list-item' + (selectedNodes.indexOf(i) !== -1 ? ' selected' : '') +
                '" data-node="' + i + '">' +
                '<span class="swatch" style="background:' + nodeHeaderColor(n) + '"></span>' +
                '<span class="idx">#' + i + '</span>' +
                '<span class="nm" title="' + esc(label) + '">' + esc(label) + '</span></div>';
        }
        if (!shown) { html = '<div class="empty">' + (all.length ? 'No nodes match the filter.' : 'This file has no nodes.') + '</div>'; }
        host.innerHTML = html;
    }

    function renderCommandList() {
        var host = document.getElementById('commandList');
        var cmds = (doc && doc.Commands) || [];
        if (!cmds.length) { host.innerHTML = '<div class="empty">No commands defined.</div>'; return; }
        var html = '';
        for (var i = 0; i < cmds.length; i++) {
            var c = cmds[i];
            html += '<div class="group">' +
                '<div class="field"><label>Name</label>' +
                '<input type="text" data-cmd-name="' + i + '" value="' + esc(c.Name || '') + '"></div>' +
                '<div class="field"><label>Root node</label>' +
                '<div class="row"><input type="number" data-cmd-root="' + i + '" value="' +
                (c['Root Node Index'] === undefined ? -1 : c['Root Node Index']) + '" style="flex:1 1 auto">' +
                '<button class="flat" data-cmd-goto="' + i + '">Go</button></div></div>' +
                '<div class="row"><span class="mono muted" style="flex:1 1 auto" title="' + esc(c.GUID || '') + '">' +
                esc((c.GUID || '').slice(0, 13)) + '&hellip;</span>' +
                '<button class="flat danger" data-cmd-del="' + i + '">Remove</button></div></div>';
        }
        host.innerHTML = html;
    }

    function renderBlackboard() {
        var host = document.getElementById('bbList');
        var bb = (doc && doc.Blackboard) || {};
        var html = '';
        var any = false;
        for (var t = 0; t < BB_TYPES.length; t++) {
            var type = BB_TYPES[t];
            var list = bb[type] || [];
            if (!list.length) { continue; }
            any = true;
            html += '<div class="group"><div class="group-title"><span class="swatch" style="background:' +
                BB_TYPE_COLOR[type] + ';width:8px;height:8px;border-radius:2px"></span>' + type +
                '<span class="line"></span></div>';
            for (var i = 0; i < list.length; i++) {
                var e = list[i];
                html += '<div class="group" style="margin-left:4px">' +
                    '<div class="field"><label>Name (index ' + (e['Blackboard Index'] !== undefined ? e['Blackboard Index'] : i) + ')</label>' +
                    '<input type="text" data-bb-name="' + type + ':' + i + '" value="' + esc(e.Name || '') + '"></div>' +
                    '<div class="field"><label>Default</label>' + bbValueInput(type, i, e['Default Value']) + '</div>' +
                    (e['Source File'] !== undefined ?
                        '<div class="muted mono" title="' + esc(e['Source File']) + '">' +
                        esc(String(e['Source File']).split('/').pop()) + '</div>' : '') +
                    '<div class="row"><button class="flat danger" data-bb-del="' + type + ':' + i + '">Remove</button></div></div>';
            }
            html += '</div>';
        }
        if (!any) { html = '<div class="empty">This file has no blackboard parameters.</div>'; }
        host.innerHTML = html;
    }

    function bbValueInput(type, i, value) {
        var key = type + ':' + i;
        if (type === 'Bool') {
            return '<input type="checkbox" data-bb-val="' + key + '"' + (value ? ' checked' : '') + '>';
        }
        if (type === 'S32' || type === 'F32') {
            return '<input type="number"' + (type === 'F32' ? ' step="any"' : '') +
                ' data-bb-val="' + key + '" value="' + (value === undefined ? 0 : value) + '">';
        }
        if (type === 'Vec3f') {
            var a = Array.isArray(value) ? value : [0, 0, 0];
            return '<div class="row">' +
                '<input type="number" step="any" data-bb-vec="' + key + ':0" value="' + (a[0] || 0) + '">' +
                '<input type="number" step="any" data-bb-vec="' + key + ':1" value="' + (a[1] || 0) + '">' +
                '<input type="number" step="any" data-bb-vec="' + key + ':2" value="' + (a[2] || 0) + '"></div>';
        }
        return '<input type="text" data-bb-val="' + key + '" value="' + esc(value === undefined ? '' : value) + '">';
    }

    function renderDetails() {
        var host = document.getElementById('details');
        if (!doc) { host.innerHTML = ''; return; }

        if (selectedNodes.length === 0) {
            host.innerHTML =
                '<div class="group"><div class="group-title">File<span class="line"></span></div>' +
                '<div class="field"><label>Filename</label><input type="text" id="fFilename" value="' + esc(doc.Filename || '') + '"></div>' +
                '<div class="field"><label>Category</label><select id="fCategory">' +
                ['AI', 'Logic', 'Sequence'].map(function (c) {
                    return '<option value="' + c + '"' + (doc.Category === c ? ' selected' : '') + '>' + c + '</option>';
                }).join('') + '</select></div>' +
                '<div class="field"><label>Version</label><input type="text" value="0x' +
                Number(doc.Version || 0).toString(16) + '" disabled></div>' +
                '<div class="field"><label>Blackboard ID</label><input type="text" value="' +
                esc(doc['Blackboard ID']) + '" disabled></div>' +
                '<div class="muted" style="font-size:11px">' + nodes().length + ' nodes, ' +
                ((doc.Commands || []).length) + ' commands, ' +
                ((doc.Modules || []).length) + ' modules</div></div>' +
                '<div class="empty">Select a node to edit it.</div>';
            var fn = document.getElementById('fFilename');
            fn.addEventListener('change', function () { mutate([{ path: ['Filename'], value: fn.value }], 'Rename file'); });
            var fc = document.getElementById('fCategory');
            fc.addEventListener('change', function () { mutate([{ path: ['Category'], value: fc.value }], 'Set category'); });
            return;
        }

        if (selectedNodes.length > 1) {
            host.innerHTML = '<div class="group"><div class="group-title">Selection<span class="line"></span></div>' +
                '<div>' + selectedNodes.length + ' nodes selected</div>' +
                '<div class="row" style="margin-top:8px"><button class="flat danger" id="btnDelSel">Delete selected</button></div></div>';
            document.getElementById('btnDelSel').addEventListener('click', function () { deleteNodes(selectedNodes.slice()); });
            return;
        }

        var index = selectedNodes[0];
        var n = nodeAt(index);
        if (!n) { host.innerHTML = ''; return; }

        var flagsHtml = '';
        for (var f = 0; f < NODE_FLAGS.length; f++) {
            var on = (n.Flags || []).indexOf(NODE_FLAGS[f]) !== -1;
            flagsHtml += '<label class="row" style="gap:6px"><input type="checkbox" data-nflag="' +
                esc(NODE_FLAGS[f]) + '"' + (on ? ' checked' : '') + '><span>' + NODE_FLAGS[f] + '</span></label>';
        }

        var queriesHtml = '';
        var qs = n.Queries || [];
        if (qs.length) {
            for (var q = 0; q < qs.length; q++) {
                var qn = nodeAt(qs[q]);
                queriesHtml += '<span class="chip" title="' + esc(qn ? nodeTitle(qn) : '') + '">#' + qs[q] + '</span>';
            }
        } else { queriesHtml = '<span class="muted">none</span>'; }

        host.innerHTML =
            '<div class="group"><div class="group-title">Node #' + index + '<span class="line"></span></div>' +
            '<div class="field"><label>Name</label><input type="text" id="dName" value="' + esc(n.Name || '') + '"></div>' +
            '<div class="field"><label>Node type</label><select id="dType">' +
            ELEMENT_NODE_TYPES.map(function (t) {
                return '<option value="' + t + '"' + (n['Node Type'] === t ? ' selected' : '') + '>' + t + '</option>';
            }).join('') + '</select></div>' +
            '<div class="field"><label>GUID</label><input type="text" class="mono" value="' + esc(n.GUID || '') + '" disabled></div>' +
            '</div>' +
            '<div class="group"><div class="group-title">Flags<span class="line"></span></div>' + flagsHtml + '</div>' +
            '<div class="group"><div class="group-title">Queries<span class="line"></span></div>' + queriesHtml + '</div>' +
            '<div class="group"><div class="group-title">Actions<span class="line"></span></div>' +
            '<div class="row"><button class="flat" id="btnDup">Duplicate</button>' +
            '<button class="flat" id="btnFocus">Focus</button>' +
            '<button class="flat danger" id="btnDel">Delete</button></div></div>';

        var dName = document.getElementById('dName');
        dName.addEventListener('change', function () {
            mutate([{ path: ['Nodes', index, 'Name'], value: dName.value }], 'Rename node');
            render();
        });
        var dType = document.getElementById('dType');
        dType.addEventListener('change', function () {
            mutate([{ path: ['Nodes', index, 'Node Type'], value: dType.value }], 'Change node type');
            render();
        });
        var checks = host.querySelectorAll('[data-nflag]');
        for (var c = 0; c < checks.length; c++) {
            (function (cb) {
                cb.addEventListener('change', function () {
                    var flags = (nodeAt(index).Flags || []).slice();
                    var name = cb.dataset.nflag;
                    var at = flags.indexOf(name);
                    if (cb.checked && at === -1) { flags.push(name); }
                    if (!cb.checked && at !== -1) { flags.splice(at, 1); }
                    mutate([{ path: ['Nodes', index, 'Flags'], value: flags }], 'Set node flags');
                });
            })(checks[c]);
        }
        document.getElementById('btnDup').addEventListener('click', function () { duplicateNode(index); });
        document.getElementById('btnFocus').addEventListener('click', function () { focusNode(index); });
        document.getElementById('btnDel').addEventListener('click', function () { deleteNodes([index]); });
    }

    // ---------------------------------------------------------------- structural edits
    /** Remap every node reference after nodes are removed. */
    function remapReferences(newNodes, mapOldToNew) {
        function mapIdx(v) {
            if (v === undefined || v < 0) { return v; }
            var m = mapOldToNew[v];
            return m === undefined ? -1 : m;
        }
        for (var i = 0; i < newNodes.length; i++) {
            var n = newNodes[i];
            n['Node Index'] = i;

            var ins = inputsOf(n);
            for (var t = 0; t < PARAM_TYPES.length; t++) {
                var list = ins[PARAM_TYPES[t]] || [];
                for (var p = 0; p < list.length; p++) {
                    var e = list[p];
                    if (e['Node Index'] !== undefined) {
                        var mapped = mapIdx(e['Node Index']);
                        if (mapped < 0 && e['Node Index'] >= 0) {
                            // Producer is gone: fall back to the constant default.
                            e['Node Index'] = -1;
                            e['Output Index'] = 0;
                            e.Flags = ['Uses Default'];
                        } else { e['Node Index'] = mapped; }
                    }
                    if (e.Sources) {
                        var keep = [];
                        for (var s = 0; s < e.Sources.length; s++) {
                            var m2 = mapIdx(e.Sources[s]['Node Index']);
                            if (m2 >= 0) { e.Sources[s]['Node Index'] = m2; keep.push(e.Sources[s]); }
                        }
                        if (keep.length) { e.Sources = keep; } else { delete e.Sources; }
                    }
                }
            }

            var plugs = plugsOf(n);
            for (var pk in plugs) {
                if (!Object.prototype.hasOwnProperty.call(plugs, pk)) { continue; }
                var kept = [];
                for (var q = 0; q < plugs[pk].length; q++) {
                    var m3 = mapIdx(plugs[pk][q]['Node Index']);
                    if (m3 >= 0) { plugs[pk][q]['Node Index'] = m3; kept.push(plugs[pk][q]); }
                }
                if (kept.length) { plugs[pk] = kept; } else { delete plugs[pk]; }
            }

            if (n.Queries) {
                var qk = [];
                for (var qq = 0; qq < n.Queries.length; qq++) {
                    var m4 = mapIdx(n.Queries[qq]);
                    if (m4 >= 0 && qk.indexOf(m4) === -1) { qk.push(m4); }
                }
                n.Queries = qk;
            }
        }
    }

    function deleteNodes(indices) {
        if (!indices.length) { return; }
        var all = clone(nodes());
        var drop = {};
        for (var i = 0; i < indices.length; i++) { drop[indices[i]] = true; }

        var kept = [], map = {};
        for (var k = 0; k < all.length; k++) {
            if (drop[k]) { continue; }
            map[k] = kept.length;
            kept.push(all[k]);
        }
        remapReferences(kept, map);
        // Deleting a consumer can leave its producer's outputs unread.
        normalizeDerivedFlags(kept);

        var cmds = clone((doc && doc.Commands) || []);
        for (var c = 0; c < cmds.length; c++) {
            var r = cmds[c]['Root Node Index'];
            if (r !== undefined) {
                cmds[c]['Root Node Index'] = (map[r] === undefined) ? -1 : map[r];
            }
        }

        // Node positions are keyed by index, so they have to shift too.
        var newLayout = {};
        for (var oldIdx in map) {
            if (Object.prototype.hasOwnProperty.call(map, oldIdx) && layout[oldIdx]) {
                newLayout[map[oldIdx]] = layout[oldIdx];
            }
        }
        layout = newLayout;

        mutate([
            { path: ['Nodes'], value: kept },
            { path: ['Commands'], value: cmds }
        ], indices.length > 1 ? 'Delete nodes' : 'Delete node');
        selectedNodes = [];
        render();
        saveLayout();
    }

    function makeGuid() {
        var hex = '0123456789abcdef';
        var s = '';
        for (var i = 0; i < 32; i++) {
            s += hex[Math.floor(Math.random() * 16)];
            if (i === 7 || i === 11 || i === 15 || i === 19) { s += '-'; }
        }
        return s;
    }

    /** Strip identity and all inbound/outbound wiring from a copied node. */
    function sanitizeCopy(n) {
        var c = clone(n);
        c.GUID = makeGuid();
        c.Queries = [];
        c.Plugs = {};
        var ins = inputsOf(c);
        for (var t = 0; t < PARAM_TYPES.length; t++) {
            var list = ins[PARAM_TYPES[t]] || [];
            for (var p = 0; p < list.length; p++) {
                if (list[p]['Node Index'] !== undefined || list[p].Sources) {
                    list[p]['Node Index'] = -1;
                    list[p]['Output Index'] = 0;
                    list[p].Flags = ['Uses Default'];
                }
                delete list[p].Sources;
            }
        }
        var outs = outputsOf(c);
        for (var o = 0; o < PARAM_TYPES.length; o++) {
            var olist = outs[PARAM_TYPES[o]] || [];
            for (var k = 0; k < olist.length; k++) { olist[k]['Is Output'] = false; }
        }
        return c;
    }

    function appendNode(newNode, pos) {
        var all = clone(nodes());
        newNode['Node Index'] = all.length;
        all.push(newNode);
        layout[all.length - 1] = pos || { x: 100, y: 100 };
        mutate([{ path: ['Nodes'], value: all }], 'Add node');
        render();
        setSelection([all.length - 1]);
        saveLayout();
    }

    function duplicateNode(index) {
        var n = nodeAt(index);
        if (!n) { return; }
        var pos = layout[index] || { x: 100, y: 100 };
        appendNode(sanitizeCopy(n), { x: pos.x + 60, y: pos.y + 60 });
    }

    function createBlankNode(type, name) {
        return {
            'Node Type': type,
            'Node Index': 0,
            'Name': type === 'UserDefined' ? (name || 'NewNode') : '',
            'GUID': makeGuid(),
            'Flags': [],
            'Queries': [],
            'Attachments': [],
            'Properties': {},
            'Parameters': { 'Inputs': {}, 'Outputs': {} },
            'XLink Actions': [],
            'Plugs': {}
        };
    }

    function defaultValueFor(type) {
        if (type === 'Bool') { return false; }
        if (type === 'Int') { return 0; }
        if (type === 'Float') { return 0.0; }
        if (type === 'String') { return ''; }
        if (type === 'Vector3F') { return [0, 0, 0]; }
        return null; // Pointer inputs must serialize with a null default
    }

    /** Build a fully-formed node from a catalog definition. */
    function nodeFromDef(def) {
        var n = createBlankNode(def.type, def.name);
        n.Name = def.name;

        var i;
        for (i = 0; i < (def.props || []).length; i++) {
            var pr = def.props[i];
            if (!n.Properties[pr.t]) { n.Properties[pr.t] = []; }
            n.Properties[pr.t].push({
                'Name': pr.n,
                'Default Value': pr.d !== undefined ? pr.d : defaultValueFor(pr.t),
                'Flags': []
            });
        }
        for (i = 0; i < (def.in || []).length; i++) {
            var ip = def.in[i];
            if (!n.Parameters.Inputs[ip.t]) { n.Parameters.Inputs[ip.t] = []; }
            var entry = { 'Name': ip.n };
            // Pointer params always serialize a Classname, so never omit it.
            if (ip.t === 'Pointer') { entry.Classname = ip.c || ''; }
            entry['Default Value'] = ip.d !== undefined ? ip.d : defaultValueFor(ip.t);
            entry['Node Index'] = -1;
            entry['Output Index'] = 0;
            entry.Flags = ['Uses Default'];
            n.Parameters.Inputs[ip.t].push(entry);
        }
        for (i = 0; i < (def.out || []).length; i++) {
            var op = def.out[i];
            if (!n.Parameters.Outputs[op.t]) { n.Parameters.Outputs[op.t] = []; }
            var oent = { 'Name': op.n };
            if (op.t === 'Pointer') { oent.Classname = op.c || ''; }
            // Nothing reads a brand-new node's outputs yet; the flag flips on when
            // something connects to it.
            oent['Is Output'] = false;
            n.Parameters.Outputs[op.t].push(oent);
        }
        if (def.type !== 'UserDefined') { n.Name = ''; }
        return n;
    }

    // ---------------------------------------------------------------- dialog
    // VS Code webviews stub out window.prompt (it silently returns null), so every
    // "give me a name" flow needs a real in-page dialog.
    var dialogCallback = null;

    function showDialog(title, fields, onOk) {
        var body = document.getElementById('dialogBody');
        var html = '';
        for (var i = 0; i < fields.length; i++) {
            var f = fields[i];
            html += '<div><label for="dlg_' + f.key + '">' + esc(f.label) + '</label>';
            if (f.type === 'select') {
                html += '<select id="dlg_' + f.key + '">';
                for (var o = 0; o < f.options.length; o++) {
                    var opt = f.options[o];
                    var value = opt.value !== undefined ? opt.value : opt;
                    var label = opt.label !== undefined ? opt.label : opt;
                    html += '<option value="' + esc(value) + '"' +
                        (String(value) === String(f.value) ? ' selected' : '') + '>' + esc(label) + '</option>';
                }
                html += '</select>';
            } else {
                html += '<input type="text" id="dlg_' + f.key + '" value="' + esc(f.value || '') + '" autocomplete="off">';
            }
            html += '</div>';
        }
        body.innerHTML = html;
        document.getElementById('dialogTitle').textContent = title;
        dialogCallback = { fields: fields, onOk: onOk };
        document.getElementById('dialog').classList.add('show');
        var first = body.querySelector('input, select');
        if (first) { first.focus(); if (first.select) { first.select(); } }
    }

    function closeDialog() {
        document.getElementById('dialog').classList.remove('show');
        dialogCallback = null;
    }

    function submitDialog() {
        if (!dialogCallback) { return; }
        var values = {};
        for (var i = 0; i < dialogCallback.fields.length; i++) {
            var key = dialogCallback.fields[i].key;
            var el = document.getElementById('dlg_' + key);
            values[key] = el ? el.value : '';
        }
        var cb = dialogCallback.onOk;
        closeDialog();
        if (cb) { cb(values); }
    }

    document.getElementById('dialogOk').addEventListener('click', submitDialog);
    document.getElementById('dialogCancel').addEventListener('click', closeDialog);
    document.getElementById('dialog').addEventListener('mousedown', function (e) {
        if (e.target.id === 'dialog') { closeDialog(); }
    });
    document.getElementById('dialog').addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); submitDialog(); }
        else if (e.key === 'Escape') { e.preventDefault(); closeDialog(); }
    });

    // ---------------------------------------------------------------- node catalog
    var pickerPos = null;

    function openNodePicker(pos) {
        pickerPos = pos;
        var overlay = document.getElementById('picker');
        overlay.classList.add('show');
        var input = document.getElementById('pickerSearch');
        input.value = '';
        renderPickerResults('');
        input.focus();
    }

    function closeNodePicker() {
        document.getElementById('picker').classList.remove('show');
    }

    function renderPickerResults(query) {
        var host = document.getElementById('pickerResults');
        if (!nodeDefs.length) {
            host.innerHTML = '<div class="empty">No node definitions available. ' +
                'Generate config/ainbNodeDefs.json.gz with scripts/convert_ainb_defs.py.</div>';
            return;
        }
        var q = query.toLowerCase().trim();
        var matches = [];
        for (var i = 0; i < nodeDefs.length && matches.length < 300; i++) {
            var d = nodeDefs[i];
            if (!q || d.name.toLowerCase().indexOf(q) !== -1) { matches.push(d); }
        }
        var total = 0;
        if (q) {
            for (var k = 0; k < nodeDefs.length; k++) {
                if (nodeDefs[k].name.toLowerCase().indexOf(q) !== -1) { total++; }
            }
        } else { total = nodeDefs.length; }

        var html = '';
        for (var m = 0; m < matches.length; m++) {
            var def = matches[m];
            var counts = [];
            if (def.in) { counts.push(def.in.length + ' in'); }
            if (def.out) { counts.push(def.out.length + ' out'); }
            if (def.props) { counts.push(def.props.length + ' prop'); }
            if (def.flow) { counts.push(def.flow.length + ' flow'); }
            html += '<div class="pick" data-def="' + esc(def.name) + '"' + (m === 0 ? ' data-first="1"' : '') + '>' +
                '<span class="swatch" style="background:' +
                (def.type !== 'UserDefined' ? '#ff8080' : (def.name.indexOf('.module') !== -1 ? '#80ff80' : '#80c3f8')) +
                '"></span><span class="pnm">' + esc(def.name) + '</span>' +
                '<span class="pmeta">' + esc((def.cats || []).join('/')) + '</span>' +
                '<span class="pmeta">' + counts.join(' &middot; ') + '</span></div>';
        }
        if (!matches.length) { html = '<div class="empty">No nodes match "' + esc(query) + '".</div>'; }
        document.getElementById('pickerCount').textContent =
            total > matches.length ? (matches.length + ' of ' + total + ' matches') : (total + ' nodes');
        host.innerHTML = html;
    }

    function addNodeFromCatalog(name) {
        var def = nodeDefByName[name];
        if (!def) { return; }
        closeNodePicker();
        appendNode(nodeFromDef(def), pickerPos || { x: 100, y: 100 });
    }

    // ---------------------------------------------------------------- link edits
    /**
     * Wire a producer's output into a consumer's input. AINB also records the
     * producer in the consumer's Queries list and mirrors it into the Generic plug
     * array; real game files keep those three in sync, so we do too.
     */
    function createDataLink(srcNode, srcType, srcIndex, dstNode, dstType, dstParam) {
        var consumer = clone(nodeAt(dstNode));
        if (!consumer) { return; }
        var list = (consumer.Parameters.Inputs || {})[dstType];
        if (!list || !list[dstParam]) { return; }

        var p = list[dstParam];
        if (p['Node Index'] !== undefined && p['Node Index'] >= 0 && p['Node Index'] !== srcNode) {
            // Already driven by someone else: promote to a multi-source input. A
            // multi-source param carries its wiring purely in Sources, so the
            // single-source fields must go.
            if (!p.Sources) { p.Sources = [{ 'Node Index': p['Node Index'], 'Output Index': p['Output Index'] || 0, 'Flags': [] }]; }
            p.Sources.push({ 'Node Index': srcNode, 'Output Index': srcIndex, 'Flags': [] });
            delete p['Node Index'];
            delete p['Output Index'];
            delete p.Flags;
        } else if (p.Sources) {
            p.Sources.push({ 'Node Index': srcNode, 'Output Index': srcIndex, 'Flags': [] });
        } else {
            p['Node Index'] = srcNode;
            p['Output Index'] = srcIndex;
            // "Uses Default" means the value is constant; a node-driven input must
            // not claim it. Game files never set any flag on a linked input.
            p.Flags = [];
        }
        // Blackboard/expression indices share the same flag word as the link, so a
        // parameter cannot be driven by a node and one of those at the same time.
        delete p['Blackboard Index'];
        delete p['Expression Index'];
        delete p['Vector Component'];

        if (!consumer.Queries) { consumer.Queries = []; }
        if (consumer.Queries.indexOf(srcNode) === -1) { consumer.Queries.push(srcNode); }

        if (!consumer.Plugs) { consumer.Plugs = {}; }
        if (!consumer.Plugs.Generic) { consumer.Plugs.Generic = []; }
        var already = false;
        for (var i = 0; i < consumer.Plugs.Generic.length; i++) {
            if (consumer.Plugs.Generic[i]['Node Index'] === srcNode &&
                consumer.Plugs.Generic[i].Name === p.Name) { already = true; break; }
        }
        if (!already) { consumer.Plugs.Generic.push({ 'Node Index': srcNode, 'Name': p.Name }); }

        // The producer side has to be updated too: a node that something queries must
        // carry "Is Query", and the output it drives must be marked as an output.
        // Missing either makes the writer fail with a bare index error on save.
        var producer = (srcNode === dstNode) ? consumer : clone(nodeAt(srcNode));
        if (!producer) { return; }
        if (!producer.Flags) { producer.Flags = []; }
        if (producer.Flags.indexOf('Is Query') === -1) { producer.Flags.push('Is Query'); }
        var outList = ((producer.Parameters && producer.Parameters.Outputs) || {})[srcType] || [];
        if (outList[srcIndex]) { outList[srcIndex]['Is Output'] = true; }

        var ops = [{ path: ['Nodes', dstNode], value: consumer }];
        if (srcNode !== dstNode) { ops.push({ path: ['Nodes', srcNode], value: producer }); }
        mutate(ops, 'Connect ' + p.Name);
        render();
    }

    /** Give a node its first child on a definition-declared flow output. */
    function createFlowPlug(srcNode, plugName, dstNode) {
        var parent = clone(nodeAt(srcNode));
        if (!parent) { return; }
        if (!parent.Plugs) { parent.Plugs = {}; }
        if (!parent.Plugs.Child) { parent.Plugs.Child = []; }
        parent.Plugs.Child.push({ 'Node Index': dstNode, 'Name': plugName });
        mutate([{ path: ['Nodes', srcNode], value: parent }], 'Connect ' + plugName);
        render();
    }

    function createFlowLink(srcNode, plugKind, plugIndex, dstNode) {
        var parent = clone(nodeAt(srcNode));
        if (!parent || !parent.Plugs || !parent.Plugs[plugKind] || !parent.Plugs[plugKind][plugIndex]) { return; }
        parent.Plugs[plugKind][plugIndex]['Node Index'] = dstNode;
        mutate([{ path: ['Nodes', srcNode], value: parent }], 'Reconnect flow');
        render();
    }

    function deleteLink(link) {
        if (!link) { return; }
        if (link.kind === 'flow') {
            var parent = clone(nodeAt(link.ref.node));
            if (!parent) { return; }
            var arr = parent.Plugs[link.ref.plug];
            if (!arr) { return; }
            arr.splice(link.ref.index, 1);
            if (!arr.length) { delete parent.Plugs[link.ref.plug]; }
            mutate([{ path: ['Nodes', link.ref.node], value: parent }], 'Delete flow link');
        } else {
            var consumer = clone(nodeAt(link.ref.node));
            if (!consumer) { return; }
            var list = (consumer.Parameters.Inputs || {})[link.ref.type];
            if (!list || !list[link.ref.index]) { return; }
            var p = list[link.ref.index];
            var removedSrc;
            if (link.ref.multi >= 0 && p.Sources) {
                removedSrc = p.Sources[link.ref.multi] && p.Sources[link.ref.multi]['Node Index'];
                p.Sources.splice(link.ref.multi, 1);
                if (p.Sources.length === 1) {
                    // Back down to a single source: move it into the inline fields.
                    p['Node Index'] = p.Sources[0]['Node Index'];
                    p['Output Index'] = p.Sources[0]['Output Index'] || 0;
                    p.Flags = [];
                    delete p.Sources;
                } else if (!p.Sources.length) {
                    delete p.Sources;
                    p['Node Index'] = -1;
                    p['Output Index'] = 0;
                    p.Flags = ['Uses Default'];
                }
            } else {
                removedSrc = p['Node Index'];
                p['Node Index'] = -1;
                p['Output Index'] = 0;
                // An unlinked input falls back to its constant default again.
                p.Flags = ['Uses Default'];
            }

            // Drop the mirrored query/plug entries if nothing else still uses that producer.
            var stillUsed = false;
            var ins = consumer.Parameters.Inputs || {};
            for (var t = 0; t < PARAM_TYPES.length; t++) {
                var l2 = ins[PARAM_TYPES[t]] || [];
                for (var q = 0; q < l2.length; q++) {
                    if (l2[q]['Node Index'] === removedSrc) { stillUsed = true; }
                    if (l2[q].Sources) {
                        for (var s = 0; s < l2[q].Sources.length; s++) {
                            if (l2[q].Sources[s]['Node Index'] === removedSrc) { stillUsed = true; }
                        }
                    }
                }
            }
            if (!stillUsed && removedSrc !== undefined && removedSrc >= 0) {
                if (consumer.Queries) {
                    var at = consumer.Queries.indexOf(removedSrc);
                    if (at !== -1) { consumer.Queries.splice(at, 1); }
                }
                if (consumer.Plugs && consumer.Plugs.Generic) {
                    consumer.Plugs.Generic = consumer.Plugs.Generic.filter(function (g) {
                        return g['Node Index'] !== removedSrc;
                    });
                    if (!consumer.Plugs.Generic.length) { delete consumer.Plugs.Generic; }
                }
            }
            var ops = [{ path: ['Nodes', link.ref.node], value: consumer }];

            // If that was the output's last reader, it is no longer an output.
            if (removedSrc !== undefined && removedSrc >= 0 && removedSrc !== link.ref.node) {
                var preview = nodes().slice();
                preview[link.ref.node] = consumer;
                var stillConsumed = computeConsumedOutputs(preview);
                var outPin = (link.from.pin || '').split(':');
                if (outPin[0] === 'out' && !stillConsumed[removedSrc + ':' + Number(outPin[2])]) {
                    var producer = clone(nodeAt(removedSrc));
                    var pl = ((producer.Parameters && producer.Parameters.Outputs) || {})[outPin[1]] || [];
                    if (pl[Number(outPin[2])]) {
                        pl[Number(outPin[2])]['Is Output'] = false;
                        ops.push({ path: ['Nodes', removedSrc], value: producer });
                    }
                }
            }
            mutate(ops, 'Delete link');
        }
        selectedLink = null;
        render();
    }

    // ---------------------------------------------------------------- interaction
    var dragNode = null, dragStart = null, dragOrigin = null, panStart = null;
    var lastMouse = { x: 0, y: 0 };
    var autoPanFrame = 0;

    /**
     * Scroll the canvas when a drag reaches the edge of the viewport, so links and
     * nodes can be dragged to somewhere off-screen without letting go first.
     */
    function autoPanStep() {
        autoPanFrame = 0;
        if (!dragNode && !pendingLink) { return; }

        var rect = graphWrap.getBoundingClientRect();
        var margin = 56, maxSpeed = 18;
        var dx = 0, dy = 0;
        if (lastMouse.x < rect.left + margin) {
            dx = (rect.left + margin - lastMouse.x) / margin * maxSpeed;
        } else if (lastMouse.x > rect.right - margin) {
            dx = -(lastMouse.x - (rect.right - margin)) / margin * maxSpeed;
        }
        if (lastMouse.y < rect.top + margin) {
            dy = (rect.top + margin - lastMouse.y) / margin * maxSpeed;
        } else if (lastMouse.y > rect.bottom - margin) {
            dy = -(lastMouse.y - (rect.bottom - margin)) / margin * maxSpeed;
        }

        if (dx || dy) {
            view.x += Math.max(-maxSpeed, Math.min(maxSpeed, dx));
            view.y += Math.max(-maxSpeed, Math.min(maxSpeed, dy));
            applyTransform();
            // Panning moves the world under the cursor, so the drag has to be
            // recomputed from the same screen position to stay under the pointer.
            updateDrag(lastMouse.x, lastMouse.y);
        }
        scheduleAutoPan();
    }

    function scheduleAutoPan() {
        if (!autoPanFrame && (dragNode || pendingLink)) {
            autoPanFrame = window.requestAnimationFrame(autoPanStep);
        }
    }

    /** Shared by mousemove and the auto-pan loop. */
    function updateDrag(clientX, clientY) {
        if (dragNode) {
            var cur = screenToCanvas(clientX, clientY);
            var dx = cur.x - dragStart.x, dy = cur.y - dragStart.y;
            for (var i = 0; i < dragNode.length; i++) {
                var idx = dragNode[i];
                layout[idx] = {
                    x: Math.round(dragOrigin[idx].x + dx),
                    y: Math.round(dragOrigin[idx].y + dy),
                };
            }
            positionAll();
            drawLinks();
        } else if (pendingLink) {
            var c = screenToCanvas(clientX, clientY);
            tempLink.setAttribute('d', bezier(pendingLink.anchor, c));
        }
    }

    graphWrap.addEventListener('mousedown', function (e) {
        hideCtxMenu();
        var pinBox = e.target.closest ? e.target.closest('[data-pin]') : null;
        if (pinBox && e.button === 0 && !readOnly) {
            startLinkDrag(pinBox, e);
            e.preventDefault();
            return;
        }

        var header = e.target.closest ? e.target.closest('.node-header') : null;
        var nodeEl = e.target.closest ? e.target.closest('.node') : null;

        if (nodeEl && e.button === 0) {
            var idx = Number(nodeEl.dataset.index);
            if (e.ctrlKey || e.metaKey) {
                var at = selectedNodes.indexOf(idx);
                if (at === -1) { selectedNodes.push(idx); } else { selectedNodes.splice(at, 1); }
                setSelection(selectedNodes);
            } else if (selectedNodes.indexOf(idx) === -1) {
                setSelection([idx]);
            }
            if (header) {
                dragNode = selectedNodes.slice();
                dragStart = screenToCanvas(e.clientX, e.clientY);
                dragOrigin = {};
                for (var i = 0; i < dragNode.length; i++) {
                    dragOrigin[dragNode[i]] = { x: layout[dragNode[i]].x, y: layout[dragNode[i]].y };
                }
                e.preventDefault();
            }
            return;
        }

        var hitPath = e.target.tagName === 'path' && e.target.dataset.link !== undefined ? e.target : null;
        if (hitPath && e.button === 0) {
            var links = drawLinks._cache || [];
            var li = Number(hitPath.dataset.link);
            selectedNodes = [];
            selectedLink = { index: li, link: links[li] };
            for (var k in nodeEls) {
                if (Object.prototype.hasOwnProperty.call(nodeEls, k)) { nodeEls[k].classList.remove('selected'); }
            }
            drawLinks();
            renderDetails();
            return;
        }

        if (e.button === 0 || e.button === 1) {
            panStart = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false };
            graphWrap.classList.add('panning');
            e.preventDefault();
        }
    });

    window.addEventListener('mousemove', function (e) {
        lastMouse.x = e.clientX;
        lastMouse.y = e.clientY;
        if (dragNode || pendingLink) {
            updateDrag(e.clientX, e.clientY);
            scheduleAutoPan();
            return;
        }
        if (panStart) {
            view.x = panStart.vx + (e.clientX - panStart.x);
            view.y = panStart.vy + (e.clientY - panStart.y);
            if (Math.abs(e.clientX - panStart.x) > 3 || Math.abs(e.clientY - panStart.y) > 3) { panStart.moved = true; }
            applyTransform();
        }
    });

    window.addEventListener('mouseup', function (e) {
        if (autoPanFrame) { window.cancelAnimationFrame(autoPanFrame); autoPanFrame = 0; }
        if (dragNode) { dragNode = null; saveLayout(); }
        if (pendingLink) { finishLinkDrag(e); }
        if (panStart) {
            if (!panStart.moved && e.button === 0 && e.target === graphWrap) { setSelection([]); }
            panStart = null;
            graphWrap.classList.remove('panning');
        }
    });

    graphWrap.addEventListener('wheel', function (e) {
        e.preventDefault();
        var rect = graphWrap.getBoundingClientRect();
        var mx = e.clientX - rect.left, my = e.clientY - rect.top;
        var before = { x: (mx - view.x) / view.z, y: (my - view.y) / view.z };
        var factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
        view.z = Math.max(0.05, Math.min(3, view.z * factor));
        view.x = mx - before.x * view.z;
        view.y = my - before.y * view.z;
        applyTransform();
        saveLayoutDebounced();
    }, { passive: false });

    function startLinkDrag(box, e) {
        var nodeIndex = Number(box.dataset.node);
        var pin = box.dataset.pin;
        var anchor = pinPos(nodeIndex, pin);
        if (!anchor) { return; }
        pendingLink = { node: nodeIndex, pin: pin, anchor: anchor };
        tempLink.style.display = '';
        tempLink.setAttribute('d', bezier(anchor, anchor));
        graphWrap.classList.add('linking');
    }

    function finishLinkDrag(e) {
        var pl = pendingLink;
        pendingLink = null;
        tempLink.style.display = 'none';
        graphWrap.classList.remove('linking');
        var target = e.target.closest ? e.target.closest('[data-pin]') : null;
        if (!target) { return; }
        var tn = Number(target.dataset.node);
        var tp = target.dataset.pin;
        if (tn === pl.node) { return; }

        var from = pl, to = { node: tn, pin: tp };
        // Allow dragging in either direction.
        if (from.pin.indexOf('in:') === 0 || from.pin === 'flowin') {
            var swap = from; from = to; to = swap;
        }

        if (from.pin.indexOf('out:') === 0 && to.pin.indexOf('in:') === 0) {
            var fp = from.pin.split(':');
            var tpp = to.pin.split(':');
            createDataLink(from.node, fp[1], Number(fp[2]), to.node, tpp[1], Number(tpp[2]));
        } else if (from.pin.indexOf('flowout:') === 0 && to.pin === 'flowin') {
            var kp = from.pin.split(':');
            createFlowLink(from.node, kp[1], Number(kp[2]), to.node);
        } else if (from.pin.indexOf('flownew:') === 0 && to.pin === 'flowin') {
            createFlowPlug(from.node, from.pin.slice('flownew:'.length), to.node);
        } else {
            showStatus('Those pins cannot be connected');
        }
    }

    var saveLayoutTimer = null;
    function saveLayoutDebounced() {
        if (saveLayoutTimer) { clearTimeout(saveLayoutTimer); }
        saveLayoutTimer = setTimeout(saveLayout, 400);
    }

    // ---------------------------------------------------------------- context menu
    function hideCtxMenu() { ctxMenu.style.display = 'none'; }

    function showCtxMenu(x, y, items) {
        var html = '';
        for (var i = 0; i < items.length; i++) {
            var it = items[i];
            if (it.sep) { html += '<div class="msep"></div>'; }
            else if (it.head) { html += '<div class="mhead">' + esc(it.head) + '</div>'; }
            else { html += '<div class="mi' + (it.disabled ? ' disabled' : '') + '" data-mi="' + i + '">' + esc(it.label) + '</div>'; }
        }
        ctxMenu.innerHTML = html;
        ctxMenu.style.display = 'block';
        ctxMenu.style.left = Math.min(x, window.innerWidth - ctxMenu.offsetWidth - 8) + 'px';
        ctxMenu.style.top = Math.min(y, window.innerHeight - ctxMenu.offsetHeight - 8) + 'px';
        ctxMenu.onclick = function (ev) {
            var mi = ev.target.closest('[data-mi]');
            if (!mi) { return; }
            var item = items[Number(mi.dataset.mi)];
            if (item && item.action && !item.disabled) { hideCtxMenu(); item.action(); }
        };
    }

    graphWrap.addEventListener('contextmenu', function (e) {
        e.preventDefault();
        var pos = screenToCanvas(e.clientX, e.clientY);
        var nodeEl = e.target.closest ? e.target.closest('.node') : null;
        var hitPath = e.target.tagName === 'path' && e.target.dataset.link !== undefined ? e.target : null;

        if (hitPath) {
            var links = drawLinks._cache || [];
            var lk = links[Number(hitPath.dataset.link)];
            showCtxMenu(e.clientX, e.clientY, [
                { head: lk.kind === 'flow' ? 'Flow link' : 'Data link' },
                { label: 'Delete link', disabled: readOnly, action: function () { deleteLink(lk); } }
            ]);
            return;
        }

        if (nodeEl) {
            var idx = Number(nodeEl.dataset.index);
            if (selectedNodes.indexOf(idx) === -1) { setSelection([idx]); }
            showCtxMenu(e.clientX, e.clientY, [
                { head: nodeTitle(nodeAt(idx)) },
                { label: 'Copy', action: function () { clipboard = sanitizeCopy(nodeAt(idx)); showStatus('Node copied'); } },
                { label: 'Duplicate', disabled: readOnly, action: function () { duplicateNode(idx); } },
                { sep: true },
                { label: 'Focus', action: function () { focusNode(idx); } },
                { sep: true },
                { label: selectedNodes.length > 1 ? 'Delete ' + selectedNodes.length + ' nodes' : 'Delete node',
                  disabled: readOnly,
                  action: function () { deleteNodes(selectedNodes.slice()); } }
            ]);
            return;
        }

        var items = [{ head: readOnly ? 'Read-only (game dump)' : 'Add node' }];
        items.push({
            label: nodeDefs.length ? 'Search node types... (' + nodeDefs.length + ')' : 'Search node types...',
            disabled: readOnly || !nodeDefs.length,
            action: function () { openNodePicker(pos); },
        });
        items.push({ label: 'Blank user-defined node...', disabled: readOnly, action: function () {
            showDialog('Add user-defined node', [
                { key: 'name', label: 'Node name', type: 'text', value: 'NewNode' },
            ], function (values) {
                if (values.name) { appendNode(createBlankNode('UserDefined', values.name), pos); }
            });
        } });
        var common = ['Element_BoolSelector', 'Element_S32Selector', 'Element_F32Selector',
                      'Element_StringSelector', 'Element_Sequential', 'Element_Simultaneous',
                      'Element_Fork', 'Element_Join', 'Element_StateEnd', 'Element_SplitTiming'];
        for (var ci = 0; ci < common.length; ci++) {
            (function (t) {
                items.push({ label: t.replace('Element_', ''), disabled: readOnly, action: function () { appendNode(createBlankNode(t), pos); } });
            })(common[ci]);
        }
        items.push({ sep: true });
        items.push({ label: 'Paste', disabled: readOnly || !clipboard, action: function () {
            if (clipboard) { appendNode(clone(clipboard), pos); }
        } });
        items.push({ sep: true });
        items.push({ label: 'Auto layout', action: function () { autoLayout(); } });
        items.push({ label: 'Fit to view', action: function () { fitToView(); } });
        showCtxMenu(e.clientX, e.clientY, items);
    });

    window.addEventListener('click', function (e) {
        if (!ctxMenu.contains(e.target)) { hideCtxMenu(); }
    });

    // ---------------------------------------------------------------- keyboard
    window.addEventListener('keydown', function (e) {
        var tag = (e.target.tagName || '').toLowerCase();
        var typing = tag === 'input' || tag === 'textarea' || tag === 'select';

        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
            e.preventDefault(); vscode.postMessage({ type: 'save' }); return;
        }
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
            if (typing) { return; }
            e.preventDefault(); vscode.postMessage({ type: 'undo' }); return;
        }
        if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) {
            if (typing) { return; }
            e.preventDefault(); vscode.postMessage({ type: 'redo' }); return;
        }
        if (typing) { return; }

        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c' && selectedNodes.length === 1) {
            clipboard = sanitizeCopy(nodeAt(selectedNodes[0])); showStatus('Node copied'); return;
        }
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v' && clipboard) {
            appendNode(clone(clipboard), { x: 120 - view.x / view.z, y: 120 - view.y / view.z }); return;
        }
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
            e.preventDefault();
            var idxs = [];
            for (var i = 0; i < nodes().length; i++) { idxs.push(i); }
            setSelection(idxs); return;
        }
        if (e.key === 'Delete' || e.key === 'Backspace') {
            if (selectedLink) { deleteLink(selectedLink.link); }
            else if (selectedNodes.length) { deleteNodes(selectedNodes.slice()); }
            return;
        }
        if (e.key === 'f' || e.key === 'F') { fitToView(); return; }
        if (e.key === 'a' || e.key === 'A') {
            var r = graphWrap.getBoundingClientRect();
            openNodePicker(screenToCanvas(r.left + r.width / 2, r.top + r.height / 2));
            return;
        }
        if (e.key === 'Escape') { setSelection([]); hideCtxMenu(); closeNodePicker(); closeDialog(); return; }
    });

    // ---------------------------------------------------------------- panel events
    document.querySelectorAll('#left .tab').forEach(function (tab) {
        tab.addEventListener('click', function () {
            activeTab = tab.dataset.tab;
            document.querySelectorAll('#left .tab').forEach(function (t) {
                t.classList.toggle('active', t.dataset.tab === activeTab);
            });
            document.querySelectorAll('#left .panel').forEach(function (p) {
                p.classList.toggle('active', p.dataset.panel === activeTab);
            });
        });
    });

    document.getElementById('nodeFilter').addEventListener('input', function (e) {
        nodeFilterText = e.target.value;
        renderNodeList();
    });

    document.getElementById('nodeList').addEventListener('click', function (e) {
        var item = e.target.closest('[data-node]');
        if (!item) { return; }
        var idx = Number(item.dataset.node);
        setSelection([idx]);
        focusNode(idx);
    });

    document.getElementById('commandList').addEventListener('click', function (e) {
        var go = e.target.closest('[data-cmd-goto]');
        if (go) {
            var ci = Number(go.dataset.cmdGoto);
            var root = (doc.Commands[ci] || {})['Root Node Index'];
            if (root !== undefined && root >= 0) { setSelection([root]); focusNode(root); }
            return;
        }
        var del = e.target.closest('[data-cmd-del]');
        if (del) {
            var di = Number(del.dataset.cmdDel);
            var cmds = clone(doc.Commands || []);
            cmds.splice(di, 1);
            mutate([{ path: ['Commands'], value: cmds }], 'Remove command');
            render();
        }
    });

    document.getElementById('commandList').addEventListener('change', function (e) {
        var nameEl = e.target.closest('[data-cmd-name]');
        if (nameEl) {
            mutate([{ path: ['Commands', Number(nameEl.dataset.cmdName), 'Name'], value: nameEl.value }], 'Rename command');
            render();
            return;
        }
        var rootEl = e.target.closest('[data-cmd-root]');
        if (rootEl) {
            var v = parseInt(rootEl.value, 10);
            if (isNaN(v)) { v = -1; }
            mutate([{ path: ['Commands', Number(rootEl.dataset.cmdRoot), 'Root Node Index'], value: v }], 'Set command root');
            render();
        }
    });

    document.getElementById('btnAddCommand').addEventListener('click', function () {
        showDialog('Add command', [
            { key: 'name', label: 'Command name', type: 'text', value: 'Root' },
            { key: 'root', label: 'Root node index', type: 'text',
              value: String(selectedNodes.length ? selectedNodes[0] : 0) },
        ], function (values) {
            if (!values.name) { return; }
            var root = parseInt(values.root, 10);
            if (isNaN(root)) { root = 0; }
            var cmds = clone(doc.Commands || []);
            cmds.push({ Name: values.name, GUID: makeGuid(), 'Root Node Index': root });
            mutate([{ path: ['Commands'], value: cmds }], 'Add command');
            render();
        });
    });

    document.getElementById('bbList').addEventListener('change', function (e) {
        var nameEl = e.target.closest('[data-bb-name]');
        if (nameEl) {
            var kp = nameEl.dataset.bbName.split(':');
            mutate([{ path: ['Blackboard', kp[0], Number(kp[1]), 'Name'], value: nameEl.value }], 'Rename blackboard param');
            return;
        }
        var valEl = e.target.closest('[data-bb-val]');
        if (valEl) {
            var vp = valEl.dataset.bbVal.split(':');
            var type = vp[0], i = Number(vp[1]);
            var value;
            if (type === 'Bool') { value = valEl.checked; }
            else if (type === 'S32') { value = parseInt(valEl.value, 10) || 0; }
            else if (type === 'F32') { value = parseFloat(valEl.value) || 0; }
            else { value = valEl.value; }
            mutate([{ path: ['Blackboard', type, i, 'Default Value'], value: value }], 'Set blackboard default');
            return;
        }
        var vecEl = e.target.closest('[data-bb-vec]');
        if (vecEl) {
            var xp = vecEl.dataset.bbVec.split(':');
            var arr = clone(getPath(doc, ['Blackboard', xp[0], Number(xp[1]), 'Default Value'])) || [0, 0, 0];
            arr[Number(xp[2])] = parseFloat(vecEl.value) || 0;
            mutate([{ path: ['Blackboard', xp[0], Number(xp[1]), 'Default Value'], value: arr }], 'Set blackboard default');
        }
    });

    document.getElementById('bbList').addEventListener('click', function (e) {
        var del = e.target.closest('[data-bb-del]');
        if (!del) { return; }
        var kp = del.dataset.bbDel.split(':');
        var type = kp[0], i = Number(kp[1]);
        var list = clone(getPath(doc, ['Blackboard', type]) || []);
        list.splice(i, 1);
        for (var k = 0; k < list.length; k++) { list[k]['Blackboard Index'] = k; }
        var bb = clone(doc.Blackboard || {});
        if (list.length) { bb[type] = list; } else { delete bb[type]; }
        mutate([{ path: ['Blackboard'], value: bb }], 'Remove blackboard param');
        render();
    });

    document.getElementById('btnAddBB').addEventListener('click', function () {
        showDialog('Add blackboard parameter', [
            { key: 'type', label: 'Type', type: 'select', options: BB_TYPES, value: 'Bool' },
            { key: 'name', label: 'Name', type: 'text', value: 'NewParam' },
        ], function (values) {
            if (!values.name || BB_TYPES.indexOf(values.type) === -1) { return; }
            var bb = clone(doc.Blackboard || {});
            if (!bb[values.type]) { bb[values.type] = []; }
            var defaults = { S32: 0, F32: 0.0, Bool: false, String: '', Vec3f: [0, 0, 0], Pointer: '' };
            bb[values.type].push({
                'Blackboard Index': bb[values.type].length, 'Name': values.name, 'Notes': '',
                'Flags': 0, 'Default Value': defaults[values.type]
            });
            mutate([{ path: ['Blackboard'], value: bb }], 'Add blackboard param');
            render();
        });
    });

    // ---------------------------------------------------------------- picker events
    document.getElementById('pickerSearch').addEventListener('input', function (e) {
        renderPickerResults(e.target.value);
    });

    document.getElementById('pickerResults').addEventListener('click', function (e) {
        var row = e.target.closest('[data-def]');
        if (row) { addNodeFromCatalog(row.dataset.def); }
    });

    document.getElementById('picker').addEventListener('mousedown', function (e) {
        if (e.target.id === 'picker') { closeNodePicker(); }
    });

    document.getElementById('pickerSearch').addEventListener('keydown', function (e) {
        var host = document.getElementById('pickerResults');
        var active = host.querySelector('.pick.active') || host.querySelector('[data-first]');
        if (e.key === 'Enter') {
            e.preventDefault();
            if (active) { addNodeFromCatalog(active.dataset.def); }
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            var all = [].slice.call(host.querySelectorAll('.pick'));
            if (!all.length) { return; }
            var idx = active ? all.indexOf(active) : -1;
            idx += (e.key === 'ArrowDown' ? 1 : -1);
            if (idx < 0) { idx = 0; }
            if (idx >= all.length) { idx = all.length - 1; }
            all.forEach(function (el) { el.classList.remove('active'); });
            all[idx].classList.add('active');
            all[idx].scrollIntoView({ block: 'nearest' });
        } else if (e.key === 'Escape') {
            e.preventDefault();
            closeNodePicker();
        }
    });

    // ---------------------------------------------------------------- toolbar
    document.getElementById('btnSave').addEventListener('click', function () { vscode.postMessage({ type: 'save' }); });
    document.getElementById('btnUndo').addEventListener('click', function () { vscode.postMessage({ type: 'undo' }); });
    document.getElementById('btnRedo').addEventListener('click', function () { vscode.postMessage({ type: 'redo' }); });
    document.getElementById('btnAddNode').addEventListener('click', function () {
        var rect = graphWrap.getBoundingClientRect();
        openNodePicker(screenToCanvas(rect.left + rect.width / 2, rect.top + rect.height / 2));
    });
    document.getElementById('btnAutoLayout').addEventListener('click', function () { autoLayout(); });
    document.getElementById('btnFit').addEventListener('click', fitToView);
    document.getElementById('btnZoomIn').addEventListener('click', function () {
        view.z = Math.min(3, view.z * 1.2); applyTransform(); saveLayoutDebounced();
    });
    document.getElementById('btnZoomOut').addEventListener('click', function () {
        view.z = Math.max(0.05, view.z / 1.2); applyTransform(); saveLayoutDebounced();
    });
    document.getElementById('btnExportLayout').addEventListener('click', function () {
        vscode.postMessage({ type: 'exportLayout', layout: layout });
    });
    document.getElementById('btnImportLayout').addEventListener('click', function () {
        vscode.postMessage({ type: 'importLayout' });
    });
    document.getElementById('btnToggleLeft').addEventListener('click', function () {
        document.getElementById('left').classList.toggle('collapsed');
    });
    document.getElementById('btnToggleRight').addEventListener('click', function () {
        document.getElementById('right').classList.toggle('collapsed');
    });

    function refreshToolbar() {
        document.getElementById('btnUndo').disabled = readOnly || !canUndo;
        document.getElementById('btnRedo').disabled = readOnly || !canRedo;
        document.getElementById('btnSave').disabled = readOnly || !isDirty;
        document.getElementById('btnAddNode').disabled = readOnly || !nodeDefs.length;
        document.getElementById('fileLabel').innerHTML =
            (readOnly ? '<span class="ro-badge">Read-Only</span> ' : '') +
            (isDirty ? '<span class="dirty-dot">&#9679;</span> ' : '') + esc(${JSON.stringify(fileName)});
    }

    // ---------------------------------------------------------------- host messages
    function adoptNodeDefs(defs) {
        nodeDefs = defs;
        nodeDefByName = {};
        for (var di = 0; di < nodeDefs.length; di++) {
            nodeDefByName[nodeDefs[di].name] = nodeDefs[di];
        }
    }

    window.addEventListener('message', function (event) {
        var msg = event.data;
        if (msg.type === 'init' || msg.type === 'setDoc') {
            doc = msg.doc;
            if (msg.nodeDefs && msg.nodeDefs.length) {
                adoptNodeDefs(msg.nodeDefs);
            }
            if (msg.layout && Object.keys(msg.layout).length) { layout = msg.layout; }
            if (msg.view) { view = msg.view; }
            canUndo = !!msg.canUndo; canRedo = !!msg.canRedo; isDirty = !!msg.isDirty;
            readOnly = !!msg.readOnly;
            document.getElementById('loading').classList.add('hidden');
            document.getElementById('errorBox').classList.remove('show');
            render();
            refreshToolbar();
            if (msg.type === 'init' && (!msg.view)) { fitToView(); }
        } else if (msg.type === 'nodeDefs') {
            if (msg.nodeDefs && msg.nodeDefs.length) {
                adoptNodeDefs(msg.nodeDefs);
                render();
                refreshToolbar();
            }
        } else if (msg.type === 'state') {
            canUndo = !!msg.canUndo; canRedo = !!msg.canRedo; isDirty = !!msg.isDirty;
            readOnly = !!msg.readOnly;
            refreshToolbar();
        } else if (msg.type === 'layout') {
            if (msg.layout) { layout = msg.layout; positionAll(); drawLinks(); saveLayout(); showStatus('Layout imported'); }
        } else if (msg.type === 'error') {
            document.getElementById('loading').classList.add('hidden');
            document.getElementById('errorText').textContent = msg.message || 'Unknown error';
            document.getElementById('errorBox').classList.add('show');
        } else if (msg.type === 'status') {
            showStatus(msg.message);
        }
    });

    window.addEventListener('resize', function () { cull(); });

    vscode.postMessage({ type: 'ready' });
})();
</script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
