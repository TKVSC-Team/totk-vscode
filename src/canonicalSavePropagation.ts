import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { runBridgeJsonAsync } from './bridge';
import { isArchiveFile } from './archives';
import { hasBaseCanonicalPath, queryCanonicalArchives } from './canonicalPathIndex';
import { isWithinRoot, normalizePath, pathsEqual, resolveProjectRomfsMount } from './projectPaths';
import {
    addProjectCanonicalEntry,
    queryProjectCanonicalArchives,
} from './projectCanonicalOverlay';

export interface ProjectRootInfo {
    fsPath: string;
    label: string;
}

export interface CanonicalSaveWriteInput {
    diskArchivePath: string;
    internalPath: string;
    textContent?: string;
    rawContent?: Uint8Array;
}

export interface CanonicalSavePropagationOptions {
    enabled: boolean;
    romfsPath: string;
    canonicalIndexPath: string;
    bridgePath: string;
    pythonExecutable: string;
    bridgeEnv: NodeJS.ProcessEnv;
    projectRoots: ProjectRootInfo[];
    projectOverlayDbPath: string;
    writeInput: CanonicalSaveWriteInput;
    output: vscode.OutputChannel;
}

function splitRel(relPath: string): string[] {
    return relPath.split('/').filter((segment) => segment.length > 0);
}

function inferActiveProjectRoot(
    editedPath: string,
    roots: ProjectRootInfo[],
): ProjectRootInfo | undefined {
    const normalizedEditedPath = normalizePath(editedPath);
    let best: { root: ProjectRootInfo; score: number } | undefined;

    for (const root of roots) {
        const container = isArchiveFile(root.fsPath) ? path.dirname(root.fsPath) : root.fsPath;
        const normalizedContainer = normalizePath(container);
        if (!isWithinRoot(normalizedContainer, normalizedEditedPath)) {
            continue;
        }
        const score = normalizedContainer.length;
        if (!best || score > best.score) {
            best = { root: { ...root, fsPath: normalizedContainer }, score };
        }
    }

    return best?.root;
}

async function ensureArchiveInProject(
    projectArchivePath: string,
    dumpArchivePath: string,
    output: vscode.OutputChannel,
): Promise<boolean> {
    if (fs.existsSync(projectArchivePath)) {
        return true;
    }
    if (!fs.existsSync(dumpArchivePath)) {
        output.appendLine(
            `[canonical-save] Missing source archive in dump: ${dumpArchivePath}`,
        );
        return false;
    }

    await fs.promises.mkdir(path.dirname(projectArchivePath), { recursive: true });
    await fs.promises.copyFile(dumpArchivePath, projectArchivePath);
    output.appendLine(`[canonical-save] Copied archive into project: ${projectArchivePath}`);
    return true;
}

export async function propagateCanonicalSave(
    options: CanonicalSavePropagationOptions,
): Promise<void> {
    if (!options.enabled) {
        return;
    }

    const canonicalPath = options.writeInput.internalPath.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
    if (!canonicalPath) {
        return;
    }

    const archiveMatches = (await queryCanonicalArchives(
        options.canonicalIndexPath,
        options.romfsPath,
        canonicalPath,
    )) ?? [];

    const activeProjectRoot = inferActiveProjectRoot(
        options.writeInput.diskArchivePath,
        options.projectRoots,
    );
    if (!activeProjectRoot) {
        options.output.appendLine(
            `[canonical-save] Could not infer active project root for ${options.writeInput.diskArchivePath}`,
        );
        return;
    }

    const projectRomfsRoot = resolveProjectRomfsMount(activeProjectRoot.fsPath, options.romfsPath);
    const relFromProjectRomfs = path.relative(projectRomfsRoot, options.writeInput.diskArchivePath);
    const projectArchiveRel = relFromProjectRomfs
        .replace(/\\/g, '/')
        .replace(/^\/+/, '')
        .replace(/\/+$/, '');
    const baseHasCanonical = await hasBaseCanonicalPath(
        options.canonicalIndexPath,
        options.romfsPath,
        canonicalPath,
    );

    if (projectArchiveRel && !projectArchiveRel.startsWith('..') && !baseHasCanonical) {
        await addProjectCanonicalEntry(
            options.projectOverlayDbPath,
            activeProjectRoot.fsPath,
            canonicalPath,
            projectArchiveRel,
        );
    }

    const projectMatches = await queryProjectCanonicalArchives(
        options.projectOverlayDbPath,
        activeProjectRoot.fsPath,
        canonicalPath,
    );

    const mergedMatches = new Map<string, { archiveRelPath: string; canonicalPath: string }>();
    for (const match of archiveMatches) {
        mergedMatches.set(match.archiveRelPath.toLowerCase(), match);
    }
    for (const match of projectMatches) {
        mergedMatches.set(match.archiveRelPath.toLowerCase(), match);
    }

    if (mergedMatches.size <= 1) {
        return;
    }

    const primaryArchive = normalizePath(options.writeInput.diskArchivePath);
    const writeMode = options.writeInput.textContent !== undefined ? 'text' : 'raw';
    const encodedRaw = options.writeInput.rawContent
        ? Buffer.from(options.writeInput.rawContent).toString('base64')
        : '';

    let propagated = 0;
    for (const match of mergedMatches.values()) {
        const dumpArchivePath = path.join(options.romfsPath, ...splitRel(match.archiveRelPath));
        const projectArchivePath = path.join(projectRomfsRoot, ...splitRel(match.archiveRelPath));

        if (pathsEqual(projectArchivePath, primaryArchive)) {
            continue;
        }

        const ready = await ensureArchiveInProject(projectArchivePath, dumpArchivePath, options.output);
        if (!ready) {
            continue;
        }

        try {
            if (writeMode === 'text') {
                await runBridgeJsonAsync<{ success: boolean }>(
                    options.pythonExecutable,
                    options.bridgePath,
                    ['write', projectArchivePath, match.canonicalPath],
                    options.writeInput.textContent ?? '',
                    options.bridgeEnv,
                );
            } else {
                await runBridgeJsonAsync<{ success: boolean }>(
                    options.pythonExecutable,
                    options.bridgePath,
                    ['write-raw', projectArchivePath, match.canonicalPath],
                    encodedRaw,
                    options.bridgeEnv,
                );
            }
            propagated++;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            options.output.appendLine(
                `[canonical-save] Failed to propagate to ${projectArchivePath}: ${message}`,
            );
        }
    }

    if (propagated > 0) {
        options.output.appendLine(
            `[canonical-save] Updated ${propagated} additional archive instance(s) for ${canonicalPath}`,
        );
    }
}
