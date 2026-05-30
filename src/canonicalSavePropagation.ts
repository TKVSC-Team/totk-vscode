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
    blacklistPrefixes: string[];
    archiveTypeBlacklist: string[];
    fileExtensionBlacklist: string[];
    writeInput: CanonicalSaveWriteInput;
    output: vscode.OutputChannel;
    onPulledNewFiles?: () => void | Promise<void>;
}

function splitRel(relPath: string): string[] {
    return relPath.split('/').filter((segment) => segment.length > 0);
}

function normalizePrefix(value: string): string {
    return value.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '').toLowerCase();
}

function isCanonicalPathBlacklisted(canonicalPath: string, prefixes: string[]): boolean {
    const normalizedCanonical = normalizePrefix(canonicalPath);
    if (!normalizedCanonical) {
        return false;
    }
    for (const prefixRaw of prefixes) {
        const prefix = normalizePrefix(prefixRaw);
        if (!prefix) {
            continue;
        }
        const hasPathSeparator = prefix.includes('/');
        if (hasPathSeparator) {
            if (normalizedCanonical === prefix || normalizedCanonical.startsWith(`${prefix}/`)) {
                return true;
            }
            continue;
        }
        const segments = normalizedCanonical.split('/');
        if (segments.includes(prefix)) {
            return true;
        }
    }
    return false;
}

function normalizeArchiveType(ext: string): string {
    const value = ext.trim().toLowerCase();
    if (!value) {
        return '';
    }
    return value.startsWith('.') ? value : `.${value}`;
}

function pathContainsBlacklistedArchiveType(pathValue: string, archiveTypes: string[]): boolean {
    const normalizedPath = pathValue.replace(/\\/g, '/').toLowerCase();
    if (!normalizedPath) {
        return false;
    }
    const segments = normalizedPath.split('/');
    for (const rawExt of archiveTypes) {
        const ext = normalizeArchiveType(rawExt);
        if (!ext) {
            continue;
        }
        for (const segment of segments) {
            if (segment.endsWith(ext) || segment.endsWith(`${ext}.zs`)) {
                return true;
            }
        }
    }
    return false;
}

function normalizeFileSuffix(value: string): string {
    const suffix = value.trim().toLowerCase();
    if (!suffix) {
        return '';
    }
    return suffix.startsWith('.') ? suffix : `.${suffix}`;
}

function pathMatchesBlacklistedFileSuffix(pathValue: string, fileSuffixes: string[]): boolean {
    const normalizedPath = pathValue.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
    if (!normalizedPath) {
        return false;
    }
    const fileName = normalizedPath.split('/').pop() ?? '';
    if (!fileName) {
        return false;
    }
    for (const rawSuffix of fileSuffixes) {
        const suffix = normalizeFileSuffix(rawSuffix);
        if (!suffix) {
            continue;
        }
        if (fileName.endsWith(suffix) || fileName.endsWith(`${suffix}.zs`)) {
            return true;
        }
    }
    return false;
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
): Promise<{ ready: boolean; copied: boolean }> {
    if (fs.existsSync(projectArchivePath)) {
        return { ready: true, copied: false };
    }
    if (!fs.existsSync(dumpArchivePath)) {
        output.appendLine(
            `[canonical-save] Missing source archive in dump: ${dumpArchivePath}`,
        );
        return { ready: false, copied: false };
    }

    await fs.promises.mkdir(path.dirname(projectArchivePath), { recursive: true });
    await fs.promises.copyFile(dumpArchivePath, projectArchivePath);
    output.appendLine(`[canonical-save] Copied archive into project: ${projectArchivePath}`);
    return { ready: true, copied: true };
}

interface TkvscConfig {
    canonicalSyncBlacklistPrefixes?: string[];
    canonicalSyncFileExtensionBlacklist?: string[];
}

function loadTkvscConfig(projectRoot: string): TkvscConfig {
    try {
        const configPath = path.join(projectRoot, '.tkvsc');
        if (fs.existsSync(configPath)) {
            const raw = fs.readFileSync(configPath, 'utf8');
            return JSON.parse(raw) as TkvscConfig;
        }
    } catch (e) {
        // Suppress or ignore
    }
    return {};
}

export async function propagateCanonicalSave(
    options: CanonicalSavePropagationOptions,
): Promise<void> {
    if (!options.enabled) {
        return;
    }

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

    // Load and merge project-specific exclusions from .tkvsc
    const projectConfig = loadTkvscConfig(activeProjectRoot.fsPath);
    const mergedBlacklistPrefixes = [...options.blacklistPrefixes];
    if (projectConfig.canonicalSyncBlacklistPrefixes) {
        mergedBlacklistPrefixes.push(...projectConfig.canonicalSyncBlacklistPrefixes);
    }
    const mergedFileExtensionBlacklist = [...options.fileExtensionBlacklist];
    if (projectConfig.canonicalSyncFileExtensionBlacklist) {
        mergedFileExtensionBlacklist.push(...projectConfig.canonicalSyncFileExtensionBlacklist);
    }

    const canonicalPath = options.writeInput.internalPath.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
    if (!canonicalPath) {
        return;
    }
    if (isCanonicalPathBlacklisted(canonicalPath, mergedBlacklistPrefixes)) {
        options.output.appendLine(
            `[canonical-save] Skipped sync for blacklisted canonical path: ${canonicalPath}`,
        );
        return;
    }
    if (pathContainsBlacklistedArchiveType(canonicalPath, options.archiveTypeBlacklist)) {
        options.output.appendLine(
            `[canonical-save] Skipped sync for blacklisted archive type path: ${canonicalPath}`,
        );
        return;
    }
    if (pathMatchesBlacklistedFileSuffix(canonicalPath, mergedFileExtensionBlacklist)) {
        options.output.appendLine(
            `[canonical-save] Skipped sync for blacklisted file suffix: ${canonicalPath}`,
        );
        return;
    }

    const archiveMatches = (await queryCanonicalArchives(
        options.canonicalIndexPath,
        options.romfsPath,
        canonicalPath,
    )) ?? [];

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
    let copiedArchives = 0;
    const tasks = Array.from(mergedMatches.values()).map(async (match) => {
        const dumpArchivePath = path.join(options.romfsPath, ...splitRel(match.archiveRelPath));
        const projectArchivePath = path.join(projectRomfsRoot, ...splitRel(match.archiveRelPath));
        if (
            pathContainsBlacklistedArchiveType(match.canonicalPath, options.archiveTypeBlacklist) ||
            pathContainsBlacklistedArchiveType(match.archiveRelPath, options.archiveTypeBlacklist)
        ) {
            return { propagated: false, copied: false };
        }
        if (pathMatchesBlacklistedFileSuffix(match.canonicalPath, mergedFileExtensionBlacklist)) {
            return { propagated: false, copied: false };
        }

        if (pathsEqual(projectArchivePath, primaryArchive)) {
            return { propagated: false, copied: false };
        }

        const prepareResult = await ensureArchiveInProject(
            projectArchivePath,
            dumpArchivePath,
            options.output,
        );
        if (!prepareResult.ready) {
            return { propagated: false, copied: false };
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
            return { propagated: true, copied: prepareResult.copied };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            options.output.appendLine(
                `[canonical-save] Failed to propagate to ${projectArchivePath}: ${message}`,
            );
            return { propagated: false, copied: prepareResult.copied };
        }
    });

    const results = await Promise.all(tasks);
    for (const res of results) {
        if (res.propagated) {
            propagated++;
        }
        if (res.copied) {
            copiedArchives++;
        }
    }

    if (propagated > 0) {
        options.output.appendLine(
            `[canonical-save] Updated ${propagated} additional archive instance(s) for ${canonicalPath}`,
        );
    }
    if (copiedArchives > 0) {
        await options.onPulledNewFiles?.();
    }
}
