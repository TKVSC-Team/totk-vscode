import * as vscode from 'vscode';
import { BarsEntry, BarsAudioResult } from './bridge';

const panels = new Map<string, vscode.WebviewPanel>();
let extensionUri: vscode.Uri | undefined;

export function initBarsViewer(extUri: vscode.Uri): void {
    extensionUri = extUri;
}

export function openBarsViewer(
    barsName: string,
    key: string,
    entries: BarsEntry[],
    fetchAudio: (index: number, usePrefetch: boolean) => Promise<BarsAudioResult>,
    replaceAudio?: (index: number) => Promise<BarsEntry[] | undefined>,
): void {
    const existing = panels.get(key);

    if (existing) {
        existing.reveal();
        return;
    }

    const os = require('os');
    const panel = vscode.window.createWebviewPanel(
        'totkBarsViewer',
        `BARS: ${barsName}`,
        vscode.ViewColumn.Active,
        { 
            enableScripts: true, 
            retainContextWhenHidden: true,
            localResourceRoots: [
                vscode.Uri.file(os.tmpdir()),
                ...(extensionUri ? [extensionUri] : []),
                ...(vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders.map(f => f.uri) : [])
            ]
        },
    );

    panel.webview.html = buildHtml(barsName, entries, !!replaceAudio);

    panel.webview.onDidReceiveMessage(async (message) => {
        if (message.type === 'replace-audio' && replaceAudio) {
            try {
                const newEntries = await replaceAudio(message.index);
                if (newEntries) {
                    // Rebuild the whole view so metadata and playback reflect the new audio.
                    panel.webview.html = buildHtml(barsName, newEntries, true);
                } else {
                    panel.webview.postMessage({ type: 'replace-done', index: message.index });
                }
            } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                void vscode.window.showErrorMessage(`Audio replacement failed: ${msg}`);
                panel.webview.postMessage({ type: 'replace-done', index: message.index });
            }
            return;
        }
        if (message.type === 'fetch-audio') {
            try {
                const res = await fetchAudio(message.index, !!message.usePrefetch);
                if (res.wavPath) {
                    const uri = panel.webview.asWebviewUri(vscode.Uri.file(res.wavPath));
                    panel.webview.postMessage({ type: 'audio-loaded', index: message.index, url: uri.toString(), result: res });
                } else {
                    void vscode.window.showErrorMessage('Failed to decode BARS audio entry: ' + (res.error || 'Unknown error'));
                    // Reset UI loading state
                    panel.webview.postMessage({ type: 'audio-error', index: message.index });
                }
            } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                void vscode.window.showErrorMessage(`Error fetching audio: ${msg}`);
                panel.webview.postMessage({ type: 'audio-error', index: message.index });
            }
        }
    });

    panels.set(key, panel);
    panel.onDidDispose(() => {
        panels.delete(key);
    });
}

function buildHtml(barsName: string, entries: BarsEntry[], canReplace: boolean): string {
    const playableIndices: number[] = [];

    const entriesHtml = entries.map((e, idx) => {
        const canPlay = e.has_prefetch || e.has_romfs_bwav;
        if (canPlay) {
            playableIndices.push(idx);
        }

        let metaHtml = '';
        if (e.metadata) {
            const m = e.metadata;
            const markers = m.markers && m.markers.length > 0
                ? `<div class="meta-row">Markers: <strong>${m.markers.length}</strong></div>` : '';
            
            // Format name hash and offsets to hex as BarsReaderGUI does
            const nameHashHex = e.name_hash ? e.name_hash.toString(16).toUpperCase() : 'N/A';
            const metaOffsetHex = e.amta_offset ? e.amta_offset.toString(16).toUpperCase() : 'N/A';
            const bwavOffsetHex = e.bwav_offset !== -1 ? e.bwav_offset.toString(16).toUpperCase() : 'N/A';

            metaHtml = `
                <div class="metadata-block">
                    <div class="meta-row">Name Hash: <strong>${nameHashHex}</strong></div>
                    <div class="meta-row">Meta Offset: <strong>${metaOffsetHex}</strong></div>
                    <div class="meta-row">Asset Offset: <strong>${bwavOffsetHex}</strong></div>
                    <div class="meta-row">Type: <strong>${escapeHtml(m.audio_type)}</strong></div>
                    <div class="meta-row">Channels: <strong>${m.channel_count}</strong></div>
                    <div class="meta-row">Volume: <strong>${m.volume_db.toFixed(1)} dB</strong></div>
                    ${markers}
                    <div class="meta-row" id="loop-label-${idx}" style="display: none;">Loop: <strong id="loop-label-text-${idx}"></strong></div>
                </div>
            `;
        } else {
            metaHtml = `
                <div class="metadata-block">
                    <div class="meta-row" id="loop-label-${idx}" style="display: none;">Loop: <strong id="loop-label-text-${idx}"></strong></div>
                </div>
            `;
        }

        return `
        <div class="entry" data-index="${idx}" data-name="${escapeHtml(e.name)}">
            <div class="entry-header">
                <div class="entry-name">${escapeHtml(e.name)}</div>
                <div class="entry-meta">
                    ${e.has_prefetch ? `<button class="tag prefetch" id="tag-prefetch-${idx}" data-index="${idx}">Prefetch</button>` : ''}
                    ${e.has_romfs_bwav ? `<button class="tag romfs" id="tag-romfs-${idx}" data-index="${idx}">Full</button>` : ''}
                    ${canReplace ? `<button class="tag replace" id="replace-btn-${idx}" data-index="${idx}" title="Replace this entry's audio with a WAV or BWAV file">Replace</button>` : ''}
                </div>
            </div>
            
            <div class="custom-player-wrapper">
                <div class="custom-player" id="player-container-${idx}">
                    <button class="player-play-btn" id="play-btn-${idx}" data-index="${idx}" ${!canPlay ? 'disabled title="Unavailable"' : 'disabled title="Loading..."'}>
                        ${canPlay ? '<span class="play-icon">▶</span><span class="pause-icon" style="display:none;">⏸</span>' : '✕'}
                    </button>
                    <button class="player-repeat-btn" id="repeat-btn-${idx}" data-index="${idx}" style="display: none;" title="Repeat">
                        <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"></polyline><path d="M3 11V9a4 4 0 0 1 4-4h14"></path><polyline points="7 23 3 19 7 15"></polyline><path d="M21 13v2a4 4 0 0 1-4 4H3"></path></svg>
                    </button>
                    <span class="time-display" id="time-current-${idx}">0:00</span>
                    <div class="progress-container">
                        <input type="range" class="progress-bar" id="progress-${idx}" value="0" min="0" max="100" step="0.01" disabled>
                        <div id="loop-start-marker-${idx}" class="loop-marker" style="display: none;"></div>
                        <div id="loop-end-marker-${idx}" class="loop-marker" style="display: none;"></div>
                    </div>
                    <span class="time-display" id="time-total-${idx}">--:--</span>
                </div>
            </div>

            ${metaHtml}
        </div>
        `;
    }).join('');

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
    :root {
        --player-bg: var(--vscode-editorWidget-background, #252526);
        --player-border: var(--vscode-panel-border, #444);
        --player-accent: var(--vscode-button-background, #0e639c);
        --player-accent-hover: var(--vscode-button-hoverBackground, #1177bb);
        --player-text: var(--vscode-foreground, #ccc);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
        font-family: var(--vscode-font-family, 'Segoe UI', sans-serif);
        font-size: 13px;
        color: var(--player-text);
        background: var(--vscode-editor-background, #1e1e1e);
        padding: 20px;
    }
    .header {
        font-size: 18px;
        font-weight: 600;
        margin-bottom: 24px;
        color: var(--vscode-foreground, #ddd);
        word-break: break-all;
    }
    .entry-list {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
        gap: 16px;
    }
    .entry {
        background: var(--player-bg);
        border: 1px solid var(--player-border);
        padding: 16px;
        border-radius: 8px;
        display: flex;
        flex-direction: column;
        gap: 14px;
    }
    .entry-header {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 12px;
    }
    .entry-name {
        font-weight: 600;
        font-size: 14px;
        word-break: break-all;
    }
    .entry-meta {
        display: flex;
        gap: 6px;
        flex-wrap: wrap;
        justify-content: flex-end;
    }
    .tag {
        font-size: 10px;
        padding: 2px 6px;
        border-radius: 4px;
        text-transform: uppercase;
        font-weight: 600;
        white-space: nowrap;
        border: 1px solid transparent;
        cursor: pointer;
        opacity: 0.5;
        transition: opacity 0.1s, border-color 0.1s;
    }
    .tag:hover {
        opacity: 0.8;
    }
    .tag.active {
        opacity: 1;
        border-color: currentColor;
    }
    .tag.prefetch { background: #3b82f640; color: #60a5fa; }
    .tag.romfs { background: #10b98140; color: #34d399; }
    .tag.replace { background: #f59e0b40; color: #fbbf24; opacity: 0.8; }
    .tag.replace:hover { opacity: 1; }
    .tag.replace:disabled { opacity: 0.4; cursor: wait; }
    
    .custom-player {
        display: flex;
        align-items: center;
        gap: 10px;
        background: var(--vscode-editor-background, #1e1e1e);
        padding: 10px 14px;
        border-radius: 6px;
        border: 1px solid var(--player-border);
    }
    .player-play-btn {
        background: var(--player-accent);
        color: #fff;
        border: none;
        width: 32px;
        height: 32px;
        border-radius: 50%;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 14px;
        flex-shrink: 0;
        transition: background 0.1s;
    }
    .player-play-btn:hover:not(:disabled) {
        background: var(--player-accent-hover);
    }
    .player-play-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
        background: var(--player-border);
    }
    .time-display {
        font-size: 11px;
        color: var(--vscode-descriptionForeground, #a0a0a0);
        min-width: 36px;
        text-align: center;
        font-variant-numeric: tabular-nums;
    }
    .progress-container {
        flex: 1;
        position: relative;
        display: flex;
        align-items: center;
    }
    input[type=range].progress-bar {
        width: 100%;
        -webkit-appearance: none;
        background: transparent;
        cursor: pointer;
        height: 16px;
    }
    input[type=range].progress-bar::-webkit-slider-runnable-track {
        height: 4px;
        background: var(--player-border);
        border-radius: 2px;
    }
    input[type=range].progress-bar::-webkit-slider-thumb {
        -webkit-appearance: none;
        height: 12px;
        width: 12px;
        border-radius: 50%;
        background: var(--player-accent);
        margin-top: -4px;
        transition: transform 0.1s;
    }
    input[type=range].progress-bar:hover::-webkit-slider-thumb:not(:disabled) {
        transform: scale(1.2);
    }
    input[type=range].progress-bar:disabled {
        cursor: not-allowed;
        opacity: 0.5;
    }
    .loop-marker {
        position: absolute;
        top: 2px;
        bottom: 2px;
        width: 2px;
        background: #f59e0b;
        pointer-events: none;
        z-index: 1;
        border-radius: 1px;
    }
    .player-repeat-btn {
        background: transparent;
        color: var(--player-text);
        border: none;
        width: 24px;
        height: 24px;
        border-radius: 4px;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        opacity: 0.5;
        transition: opacity 0.1s, background 0.1s;
    }
    .player-repeat-btn:hover {
        background: var(--vscode-list-hoverBackground, #2a2d2e);
        opacity: 0.8;
    }
    .player-repeat-btn.active {
        opacity: 1;
        color: #f59e0b;
    }
    .loop-label {
        font-size: 11px;
        color: #f59e0b;
        margin-top: 6px;
        text-align: center;
    }
    .metadata-block {
        font-size: 11px;
        color: var(--vscode-descriptionForeground, #a0a0a0);
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 6px 12px;
        background: var(--vscode-editor-background, #1e1e1e);
        padding: 10px 12px;
        border-radius: 6px;
        border: 1px solid var(--player-border);
        margin-top: auto;
    }
    .meta-row.loop-row {
        color: #f59e0b;
    }
    .meta-row.loop-row strong {
        color: #f59e0b;
    }
    .meta-row strong {
        color: var(--player-text);
    }
</style>
</head>
<body>
    <div class="header" style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px;">
        <span>BARS: ${escapeHtml(barsName)}</span>
        <div style="display: flex; align-items: center; gap: 8px;">
            <label for="sort-select" style="font-size: 13px; color: var(--vscode-descriptionForeground);">Sort by:</label>
            <select id="sort-select" style="background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border); padding: 4px; border-radius: 4px; outline: none; cursor: pointer;">
                <option value="default">Default</option>
                <option value="alphabetical">Alphabetical</option>
            </select>
        </div>
    </div>
    <div class="entry-list">
        ${entriesHtml}
    </div>
    
    <script>
        const vscode = acquireVsCodeApi();
        
        function formatTime(seconds) {
            if (isNaN(seconds) || !isFinite(seconds)) return '--:--';
            const m = Math.floor(seconds / 60);
            const s = Math.floor(seconds % 60);
            return m + ':' + (s < 10 ? '0' : '') + s;
        }

        const sortSelect = document.getElementById('sort-select');
        sortSelect.addEventListener('change', () => {
            const list = document.querySelector('.entry-list');
            const entries = Array.from(list.querySelectorAll('.entry'));
            const mode = sortSelect.value;
            
            entries.sort((a, b) => {
                if (mode === 'alphabetical') {
                    return a.dataset.name.localeCompare(b.dataset.name);
                } else {
                    return parseInt(a.dataset.index) - parseInt(b.dataset.index);
                }
            });
            
            entries.forEach(e => list.appendChild(e));
        });

        const playableIndices = ${JSON.stringify(playableIndices)};
        let fetchQueue = [...playableIndices];
        let activeFetches = 0;
        const MAX_CONCURRENT = 5;
        
        const prefetchStates = {};
        
        // Web Audio API
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const players = {}; 
        
        function updateUI(idx) {
            const p = players[idx];
            const btn = document.getElementById('play-btn-' + idx);
            if (!btn || !p) return;
            const playIcon = btn.querySelector('.play-icon');
            const pauseIcon = btn.querySelector('.pause-icon');
            if (p.isPlaying) {
                playIcon.style.display = 'none';
                pauseIcon.style.display = 'inline';
            } else {
                playIcon.style.display = 'inline';
                pauseIcon.style.display = 'none';
                
                if (p.pausedAt === 0) {
                    const progress = document.getElementById('progress-' + idx);
                    const timeCurrent = document.getElementById('time-current-' + idx);
                    if (progress) progress.value = 0;
                    if (timeCurrent) timeCurrent.textContent = formatTime(0);
                }
            }
        }

        function playAudio(idx) {
            if (audioCtx.state === 'suspended') audioCtx.resume();
            
            const p = players[idx];
            if (!p || !p.buffer) return;
            if (p.isPlaying) return;

            // Pause all others
            Object.keys(players).forEach(otherIdx => {
                if (otherIdx != idx && players[otherIdx].isPlaying) pauseAudio(otherIdx);
            });

            p.source = audioCtx.createBufferSource();
            p.source.buffer = p.buffer;
            if (p.isLooping && p.loopEnd !== null) {
                p.source.loop = true;
                p.source.loopStart = p.loopStart;
                p.source.loopEnd = p.loopEnd;
            }
            p.source.connect(audioCtx.destination);
            
            p.source.start(0, p.pausedAt);
            p.startedAt = audioCtx.currentTime - p.pausedAt;
            p.isPlaying = true;
            
            const currentSource = p.source;
            p.source.onended = () => {
                if (p.source !== currentSource) return;
                
                // If it reached the actual end (not stopped manually)
                if (p.isPlaying && (!p.isLooping || p.loopEnd === null)) {
                    p.isPlaying = false;
                    p.pausedAt = 0;
                    updateUI(idx);
                }
            };

            updateUI(idx);
        }

        function pauseAudio(idx) {
            const p = players[idx];
            if (!p || !p.isPlaying) return;
            
            p.source.stop();
            p.pausedAt = audioCtx.currentTime - p.startedAt;
            
            if (p.isLooping && p.loopEnd !== null && p.pausedAt >= p.loopEnd) {
                const loopDur = p.loopEnd - p.loopStart;
                while(p.pausedAt >= p.loopEnd) {
                    p.pausedAt -= loopDur;
                }
            }

            p.isPlaying = false;
            updateUI(idx);
        }

        function seekAudio(idx, time) {
            const p = players[idx];
            if (!p) return;
            
            const wasPlaying = p.isPlaying;
            if (wasPlaying) pauseAudio(idx);
            p.pausedAt = time;
            if (wasPlaying) playAudio(idx);
        }
        
        function renderLoop() {
            requestAnimationFrame(renderLoop);
            Object.keys(players).forEach(idx => {
                const p = players[idx];
                if (!p.isPlaying) return;
                
                let currentTime = audioCtx.currentTime - p.startedAt;
                if (p.isLooping && p.loopEnd !== null && currentTime >= p.loopEnd) {
                    const loopDur = p.loopEnd - p.loopStart;
                    const pastLoop = currentTime - p.loopStart;
                    currentTime = p.loopStart + (pastLoop % loopDur);
                } else if (currentTime > p.buffer.duration) {
                     currentTime = p.buffer.duration;
                }
                
                const progress = document.getElementById('progress-' + idx);
                const timeCurrent = document.getElementById('time-current-' + idx);
                if (!p.isSeeking && progress && timeCurrent) {
                    progress.value = currentTime;
                    timeCurrent.textContent = formatTime(currentTime);
                }
            });
        }
        requestAnimationFrame(renderLoop);

        function fetchNext() {
            while (fetchQueue.length > 0 && activeFetches < MAX_CONCURRENT) {
                activeFetches++;
                const index = fetchQueue.shift();
                vscode.postMessage({ type: 'fetch-audio', index, usePrefetch: prefetchStates[index] });
            }
        }

        // Replace buttons (every entry, playable or not)
        document.querySelectorAll('.tag.replace').forEach(el => {
            el.addEventListener('click', () => {
                const idx = parseInt(el.dataset.index);
                el.disabled = true;
                el.textContent = 'Replacing…';
                vscode.postMessage({ type: 'replace-audio', index: idx });
            });
        });

        // Initialize players
        playableIndices.forEach(idx => {
            const btnRomfs = document.getElementById('tag-romfs-' + idx);
            const btnPrefetch = document.getElementById('tag-prefetch-' + idx);
            
            prefetchStates[idx] = !btnRomfs && !!btnPrefetch;

            function updateTags() {
                if (btnRomfs) btnRomfs.classList.toggle('active', !prefetchStates[idx]);
                if (btnPrefetch) btnPrefetch.classList.toggle('active', prefetchStates[idx]);
            }
            updateTags();

            function toggleAudio(usePrefetch) {
                if (prefetchStates[idx] === usePrefetch) return;
                prefetchStates[idx] = usePrefetch;
                updateTags();
                
                if (players[idx] && players[idx].isPlaying) pauseAudio(idx);
                delete players[idx];
                
                const btn = document.getElementById('play-btn-' + idx);
                const progress = document.getElementById('progress-' + idx);
                const timeTotal = document.getElementById('time-total-' + idx);
                const timeCurrent = document.getElementById('time-current-' + idx);
                const playIcon = btn.querySelector('.play-icon');
                const pauseIcon = btn.querySelector('.pause-icon');

                if (btn) {
                    btn.disabled = true;
                    btn.title = "Loading...";
                }
                if (playIcon) playIcon.style.display = 'inline';
                if (pauseIcon) pauseIcon.style.display = 'none';
                
                if (progress) {
                    progress.value = 0;
                    progress.disabled = true;
                }
                if (timeTotal) timeTotal.textContent = '--:--';
                if (timeCurrent) timeCurrent.textContent = '0:00';
                
                const repeatBtn = document.getElementById('repeat-btn-' + idx);
                const markerStart = document.getElementById('loop-start-marker-' + idx);
                const markerEnd = document.getElementById('loop-end-marker-' + idx);
                const loopLabel = document.getElementById('loop-label-' + idx);
                
                if (repeatBtn) {
                    repeatBtn.style.display = 'none';
                    repeatBtn.classList.remove('active');
                }
                if (markerStart) markerStart.style.display = 'none';
                if (markerEnd) markerEnd.style.display = 'none';
                if (loopLabel) loopLabel.style.display = 'none';

                fetchQueue.push(idx);
                fetchNext();
            }

            if (btnRomfs) {
                btnRomfs.addEventListener('click', () => toggleAudio(false));
            }
            if (btnPrefetch) {
                btnPrefetch.addEventListener('click', () => toggleAudio(true));
            }

            const btn = document.getElementById('play-btn-' + idx);
            const progress = document.getElementById('progress-' + idx);
            const timeCurrent = document.getElementById('time-current-' + idx);
            const repeatBtn = document.getElementById('repeat-btn-' + idx);

            btn.addEventListener('click', () => {
                const p = players[idx];
                if (!p) return;
                if (!p.isPlaying) {
                    playAudio(idx);
                } else {
                    pauseAudio(idx);
                }
            });

            repeatBtn.addEventListener('click', () => {
                const p = players[idx];
                if (!p) return;
                p.isLooping = !p.isLooping;
                repeatBtn.classList.toggle('active', p.isLooping);
                
                const wasPlaying = p.isPlaying;
                if (wasPlaying) pauseAudio(idx);
                if (wasPlaying) playAudio(idx);
            });

            progress.addEventListener('input', () => {
                const p = players[idx];
                if (p) p.isSeeking = true;
                timeCurrent.textContent = formatTime(progress.value);
            });

            progress.addEventListener('change', () => {
                const p = players[idx];
                if (p) {
                    p.isSeeking = false;
                    seekAudio(idx, parseFloat(progress.value));
                }
            });
        });

        window.addEventListener('message', event => {
            const message = event.data;
            if (message.type === 'audio-loaded') {
                const { index, url, result } = message;
                const btn = document.getElementById('play-btn-' + index);
                const progress = document.getElementById('progress-' + index);
                const timeTotal = document.getElementById('time-total-' + index);

                fetch(url)
                    .then(response => response.arrayBuffer())
                    .then(arrayBuffer => audioCtx.decodeAudioData(arrayBuffer))
                    .then(audioBuffer => {
                        players[index] = {
                            buffer: audioBuffer,
                            source: null,
                            startedAt: 0,
                            pausedAt: 0,
                            isPlaying: false,
                            loopStart: result.loopStart !== undefined ? result.loopStart : null,
                            loopEnd: result.loopEnd !== undefined ? result.loopEnd : null,
                            isLooping: result.loopStart !== undefined && result.loopStart !== null,
                            isSeeking: false
                        };
                        
                        if (timeTotal) timeTotal.textContent = formatTime(audioBuffer.duration);
                        if (progress) {
                            progress.max = audioBuffer.duration;
                            progress.disabled = false;
                        }
                        if (btn) {
                            btn.disabled = false;
                            btn.title = "Play/Pause";
                        }
                        
                        if (players[index].isLooping) {
                            const repeatBtn = document.getElementById('repeat-btn-' + index);
                            const markerStart = document.getElementById('loop-start-marker-' + index);
                            const markerEnd = document.getElementById('loop-end-marker-' + index);
                            const loopLabel = document.getElementById('loop-label-' + index);
                            
                            if (repeatBtn) {
                                repeatBtn.classList.add('active');
                                repeatBtn.style.display = 'flex';
                            }
                            if (markerStart) {
                                markerStart.style.display = 'block';
                                markerStart.style.left = (players[index].loopStart / audioBuffer.duration * 100) + '%';
                            }
                            if (markerEnd) {
                                markerEnd.style.display = 'block';
                                markerEnd.style.left = (players[index].loopEnd / audioBuffer.duration * 100) + '%';
                            }
                            if (loopLabel) {
                                loopLabel.style.display = 'block';
                                loopLabel.classList.add('loop-row');
                                const textElement = document.getElementById('loop-label-text-' + index);
                                if (textElement) textElement.textContent = \`\${formatTime(players[index].loopStart)} - \${formatTime(players[index].loopEnd)}\`;
                            }
                        }
                        
                        activeFetches--;
                        fetchNext();
                    })
                    .catch(e => {
                        console.error('Error decoding audio', e);
                        if (btn) {
                            btn.title = "Error decoding";
                            btn.querySelector('.play-icon').textContent = '✕';
                        }
                        activeFetches--;
                        fetchNext();
                    });
            } else if (message.type === 'replace-done') {
                const rbtn = document.getElementById('replace-btn-' + message.index);
                if (rbtn) {
                    rbtn.disabled = false;
                    rbtn.textContent = 'Replace';
                }
            } else if (message.type === 'audio-error') {
                const btn = document.getElementById('play-btn-' + message.index);
                if (btn) {
                    btn.title = "Error loading";
                    btn.querySelector('.play-icon').textContent = '✕';
                }
                activeFetches--;
                fetchNext();
            }
        });

        // Start fetching process
        fetchNext();
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
