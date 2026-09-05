import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { getActiveGameId } from './gameProfile';
import { getIndexPathsForGame } from './indexPaths';

/** One parameter of a node definition. `c` is only present for Pointer params. */
export interface AinbParamDef {
    n: string;
    t: string;
    c?: string;
    /** The game's declared default, when the dump provided a usable one. */
    d?: boolean | number | string | number[];
}

export interface AinbNodeDef {
    name: string;
    type: string;
    cats?: string[];
    tags?: string[];
    flow?: string[];
    in?: AinbParamDef[];
    out?: AinbParamDef[];
    props?: AinbParamDef[];
}

interface AinbNodeDefCatalog {
    version: number;
    source?: string;
    definitions: AinbNodeDef[];
}

/** Bumped when `python/ainb_node_defs.py` changes shape, to force a rebuild. */
export const AINB_NODE_DEFS_SCHEMA_VERSION = 2;

let cached: AinbNodeDefCatalog | undefined;
let cachedFile: string | undefined;
const failedFiles = new Set<string>();

/** Where a generated catalog lives for `gameId`, if index storage is set up. */
export function generatedAinbNodeDefsPath(gameId?: string): string | undefined {
    return getIndexPathsForGame(gameId ?? getActiveGameId())?.ainbNodeDefs;
}

/**
 * Node signatures for the active game, so new nodes can be created with the right
 * parameters instead of empty shells.
 *
 * Preferred source is the catalog harvested from the user's own dump - it matches their
 * game version and carries the defaults the game declares. Until that exists the shipped
 * catalog stands in: signatures converted from Starlight's database by
 * `scripts/convert_ainb_defs.py`, see the README credits.
 *
 * Roughly 2 MB once decompressed, so it is read once and kept for the session.
 */
export function loadAinbNodeDefs(extensionPath: string): AinbNodeDef[] {
    const generated = generatedAinbNodeDefsPath();
    const file = generated && fs.existsSync(generated)
        ? generated
        : path.join(extensionPath, 'config', 'ainbNodeDefs.json.gz');

    if (cached && cachedFile === file) {
        return cached.definitions;
    }
    if (failedFiles.has(file)) {
        return [];
    }

    try {
        const raw = zlib.gunzipSync(fs.readFileSync(file)).toString('utf-8');
        const parsed = JSON.parse(raw) as AinbNodeDefCatalog;
        if (!parsed || !Array.isArray(parsed.definitions)) {
            throw new Error('Malformed node definition catalog');
        }
        cached = parsed;
        cachedFile = file;
        return cached.definitions;
    } catch {
        // The editor still works without definitions - only the node catalog and
        // definition-declared flow pins go away.
        failedFiles.add(file);
        return [];
    }
}

/** Forget the loaded catalog, so the next load picks up a rebuild or a game switch. */
export function invalidateAinbNodeDefs(): void {
    cached = undefined;
    cachedFile = undefined;
    failedFiles.clear();
}

export type AinbNodeDefsBuilder = (force?: boolean) => Promise<boolean>;

let builder: AinbNodeDefsBuilder | undefined;

/** Installed during activation; the editor stays decoupled from the bridge plumbing. */
export function setAinbNodeDefsBuilder(build: AinbNodeDefsBuilder | undefined): void {
    builder = build;
}

/**
 * Build the catalog for the active game if it is missing or stale. Resolves to true when
 * a fresh catalog landed, so callers know to re-read it.
 */
export async function ensureAinbNodeDefs(): Promise<boolean> {
    if (!builder) {
        return false;
    }
    const built = await builder();
    if (built) {
        invalidateAinbNodeDefs();
    }
    return built;
}
