import * as fs from 'fs';
import * as path from 'path';
import { getActiveGameId, getGameProfileRegistry } from './gameProfile';

const DEFAULT_ARCHIVE_PATTERN = /\.(pack|sarc|genvb|blarc|bfarc|bkres|bntx)(\.zs)?$/i;

const TXTG_FILE_PATTERN = /\.txtg(\.zs)?$/i;
const BNTX_PARENT_PATTERN = /\.bntx(\.zs)?[/\\]/i;
const BWAV_FILE_PATTERN = /\.bwav(\.zs)?$/i;
const BARS_FILE_PATTERN = /\.bars(\.zs)?$/i;

class ArchiveRegistry {
    private readonly patternsByGame = new Map<string, RegExp[]>();

    registerGamePatterns(gameId: string, patternSources: string[]): void {
        const patterns = patternSources
            .map((source) => {
                try {
                    return new RegExp(source, 'i');
                } catch {
                    return undefined;
                }
            })
            .filter((pattern): pattern is RegExp => pattern !== undefined);
        if (patterns.length === 0) {
            patterns.push(DEFAULT_ARCHIVE_PATTERN);
        }
        this.patternsByGame.set(gameId, patterns);
    }

    initFromGameProfiles(): void {
        this.patternsByGame.clear();
        for (const profile of getGameProfileRegistry().getAllProfiles()) {
            const sources = profile.archivePatterns?.length
                ? profile.archivePatterns
                : [DEFAULT_ARCHIVE_PATTERN.source];
            this.registerGamePatterns(profile.id, sources);
        }
        if (!this.patternsByGame.has('totk')) {
            this.registerGamePatterns('totk', [DEFAULT_ARCHIVE_PATTERN.source]);
        }
    }

    registerPattern(gameId: string, patternSource: string): void {
        const existing = this.patternsByGame.get(gameId) ?? [DEFAULT_ARCHIVE_PATTERN];
        try {
            existing.push(new RegExp(patternSource, 'i'));
        } catch {
            return;
        }
        this.patternsByGame.set(gameId, existing);
    }

    private getPatterns(gameId?: string): RegExp[] {
        const id = gameId ?? getActiveGameId();
        return this.patternsByGame.get(id) ?? [DEFAULT_ARCHIVE_PATTERN];
    }

    isArchiveFileName(name: string, gameId?: string): boolean {
        const normalized = name.replace(/\\/g, '/').split('/').pop() ?? name;
        return this.getPatterns(gameId).some((pattern) => pattern.test(normalized));
    }

    isArchiveFile(filePath: string, gameId?: string): boolean {
        const normalized = filePath.replace(/\\/g, '/');
        return this.getPatterns(gameId).some((pattern) => pattern.test(normalized));
    }

    getDiskArchivePath(fsPath: string, gameId?: string): string {
        const normalized = fsPath.replace(/\\/g, '/').replace(/\/+$/, '');
        if (!normalized) {
            return fsPath;
        }

        const isWindowsDrive = /^[a-zA-Z]:/.test(normalized);
        const isUnc = !isWindowsDrive && normalized.startsWith('//');
        const isUnixAbsolute = !isWindowsDrive && !isUnc && normalized.startsWith('/');

        const segments = normalized.split('/').filter(Boolean);
        if (segments.length === 0) {
            return fsPath;
        }

        let lastArchiveIndex = -1;
        for (let i = 0; i < segments.length; i++) {
            if (this.isArchiveFileName(segments[i]!, gameId)) {
                lastArchiveIndex = i;
            }
        }

        if (lastArchiveIndex < 0) {
            return fsPath;
        }

        const toDiskPath = (endIndex: number): string => {
            const prefix = segments.slice(0, endIndex + 1).join('/');
            if (isWindowsDrive) {
                return prefix.replace(/\//g, path.sep);
            }
            if (isUnc) {
                return `//${prefix}`;
            }
            if (isUnixAbsolute) {
                return `/${prefix}`;
            }
            return prefix;
        };

        // Nested archive entries (e.g. timg/__Combined.bntx inside a .blarc) are virtual;
        // walk back to the last archive segment that exists on disk.
        for (let i = lastArchiveIndex; i >= 0; i--) {
            if (!this.isArchiveFileName(segments[i]!, gameId)) {
                continue;
            }
            const diskPath = toDiskPath(i);
            if (fs.existsSync(diskPath)) {
                return diskPath;
            }
        }

        return toDiskPath(lastArchiveIndex);
    }
}

const registry = new ArchiveRegistry();

export function initArchiveRegistry(): void {
    registry.initFromGameProfiles();
}

export function getArchiveRegistry(): ArchiveRegistry {
    return registry;
}

export function registerArchivePattern(gameId: string, patternSource: string): void {
    registry.registerPattern(gameId, patternSource);
}

export function isArchiveFileName(name: string, gameId?: string): boolean {
    return registry.isArchiveFileName(name, gameId);
}

export function isArchiveFile(filePath: string, gameId?: string): boolean {
    return registry.isArchiveFile(filePath, gameId);
}

export function getDiskArchivePath(fsPath: string, gameId?: string): string {
    return registry.getDiskArchivePath(fsPath, gameId);
}

export function isTxtgFile(filePath: string): boolean {
    return TXTG_FILE_PATTERN.test(filePath.replace(/\\/g, '/'));
}

export function isBntxTextureUri(uri: { fsPath: string }): boolean {
    return BNTX_PARENT_PATTERN.test(uri.fsPath);
}

export function isBwavAudioFile(filePath: string): boolean {
    return BWAV_FILE_PATTERN.test(filePath.replace(/\\/g, '/'));
}

export function isBarsAudioArchive(filePath: string): boolean {
    return BARS_FILE_PATTERN.test(filePath.replace(/\\/g, '/'));
}

export function isPathInsideArchive(filePath: string, gameId?: string): boolean {
    const normalized = filePath.replace(/\\/g, '/').replace(/\/+$/, '');
    const segments = normalized.split('/').filter(Boolean);
    for (let i = 0; i < segments.length; i++) {
        if (!isArchiveFileName(segments[i]!, gameId)) {
            continue;
        }
        if (i < segments.length - 1) {
            return true;
        }
    }
    return false;
}

export function isArchiveBrowsePath(filePath: string, gameId?: string): boolean {
    return isPathInsideArchive(filePath, gameId) || isArchiveFile(filePath, gameId);
}

/** @deprecated Prefer {@link isPathInsideArchive}. */
export function pathContainsArchive(filePath: string): boolean {
    return isPathInsideArchive(filePath);
}

export function getLocatorInsideDiskArchive(fsPath: string, diskArchive: string): string {
    let rest = fsPath.substring(diskArchive.length);
    if (rest.startsWith('/') || rest.startsWith('\\')) {
        rest = rest.substring(1);
    }
    return rest.replace(/\\/g, '/');
}

/** @deprecated Use getDiskArchivePath - kept for callers expecting the old name. */
export function getArchivePhysicalPath(fsPath: string): string {
    return getDiskArchivePath(fsPath);
}

export function archiveCacheKey(diskArchive: string, locator: string): string {
    return `${diskArchive}::${locator}`;
}

/** @deprecated Use {@link isArchiveFile} via archiveRegistry. */
export const ARCHIVE_FILE_PATTERN = DEFAULT_ARCHIVE_PATTERN;
