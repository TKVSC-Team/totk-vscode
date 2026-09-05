import * as fs from 'fs';
import * as path from 'path';

export const INDEX_SCHEMA_VERSION = 4;

export interface GameIndexPaths {
    indexDir: string;
    romfsIndex: string;
    romfsIndexState: string;
    canonicalIndex: string;
    canonicalIndexState: string;
    ainbNodeDefs: string;
    ainbNodeDefsState: string;
}

let indexStorageRoot: string | undefined;

export function setIndexStorageRoot(globalStorageFsPath: string): void {
    indexStorageRoot = globalStorageFsPath;
}

export function getIndexPathsForGame(gameId: string): GameIndexPaths | undefined {
    return indexStorageRoot ? getGameIndexPaths(indexStorageRoot, gameId) : undefined;
}

export function getGameIndexDir(globalStorageFsPath: string, gameId: string): string {
    return path.join(globalStorageFsPath, 'indexes', gameId);
}

export function getGameIndexPaths(globalStorageFsPath: string, gameId: string): GameIndexPaths {
    const indexDir = getGameIndexDir(globalStorageFsPath, gameId);
    return {
        indexDir,
        romfsIndex: path.join(indexDir, 'romfs-index.sqlite'),
        romfsIndexState: path.join(indexDir, 'romfs-index.state.json'),
        canonicalIndex: path.join(indexDir, 'canonical-paths.sqlite'),
        canonicalIndexState: path.join(indexDir, 'canonical-paths.state.json'),
        ainbNodeDefs: path.join(indexDir, 'ainb-node-defs.json.gz'),
        ainbNodeDefsState: path.join(indexDir, 'ainb-node-defs.state.json'),
    };
}

const LEGACY_INDEX_FILES = [
    'romfs-index.sqlite',
    'romfs-index.state.json',
    'canonical-paths.sqlite',
    'canonical-paths.state.json',
] as const;

/** Move pre-Phase-3 index files from globalStorage root into `indexes/totk/`. */
export async function migrateLegacyIndexFiles(
    globalStorageFsPath: string,
    gameId = 'totk',
): Promise<void> {
    const targets = getGameIndexPaths(globalStorageFsPath, gameId);
    await fs.promises.mkdir(targets.indexDir, { recursive: true });

    const moves: Array<[string, string]> = [
        ['romfs-index.sqlite', targets.romfsIndex],
        ['romfs-index.state.json', targets.romfsIndexState],
        ['canonical-paths.sqlite', targets.canonicalIndex],
        ['canonical-paths.state.json', targets.canonicalIndexState],
    ];

    for (const [legacyName, targetPath] of moves) {
        const legacyPath = path.join(globalStorageFsPath, legacyName);
        if (fs.existsSync(legacyPath) && !fs.existsSync(targetPath)) {
            await fs.promises.rename(legacyPath, targetPath);
        }
    }

    for (const legacyName of LEGACY_INDEX_FILES) {
        const legacyPath = path.join(globalStorageFsPath, legacyName);
        if (fs.existsSync(legacyPath)) {
            // Leftover after partial migration - leave in place; next rebuild uses new path.
        }
    }
}
