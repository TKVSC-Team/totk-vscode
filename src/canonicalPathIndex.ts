import * as fs from 'fs';
import * as path from 'path';
import initSqlJs, { Database } from 'sql.js';

let db: Database | undefined;
let loadedDbPath: string | undefined;
let loadedRoot: string | undefined;
let extensionPath: string | undefined;

export function setCanonicalIndexExtensionPath(extPath: string): void {
    extensionPath = extPath;
}

function getWasmPath(): string | undefined {
    const candidates: string[] = [];
    if (extensionPath) {
        candidates.push(path.join(extensionPath, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'));
    }
    try {
        const sqlJsDir = path.dirname(require.resolve('sql.js'));
        candidates.push(path.join(sqlJsDir, 'dist', 'sql-wasm.wasm'));
        candidates.push(path.join(sqlJsDir, 'sql-wasm.wasm'));
    } catch {
        // fall through
    }
    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }
    return undefined;
}

function normalizePath(value: string): string {
    return value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

export function normalizeCanonicalPath(value: string): string {
    return value.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '').toLowerCase();
}

function normalizeCasePreservingRel(value: string): string {
    return value.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
}

async function openDb(dbPath: string): Promise<Database | undefined> {
    if (!fs.existsSync(dbPath)) {
        return undefined;
    }

    if (loadedDbPath === dbPath && db) {
        return db;
    }

    closeDb();

    const wasmBinary = getWasmPath();
    const initOpts: Parameters<typeof initSqlJs>[0] = {};
    if (wasmBinary) {
        initOpts.locateFile = () => wasmBinary;
    }
    const SQL = await initSqlJs(initOpts);
    const fileBuffer = fs.readFileSync(dbPath);
    db = new SQL.Database(fileBuffer);
    loadedDbPath = dbPath;

    const rootResult = db.exec("SELECT value FROM meta WHERE key = 'root'");
    loadedRoot = rootResult[0]?.values?.[0]?.[0] as string | undefined;
    return db;
}

function closeDb(): void {
    if (!db) {
        return;
    }
    db.close();
    db = undefined;
    loadedDbPath = undefined;
    loadedRoot = undefined;
}

export async function queryCanonicalArchives(
    dbPath: string,
    romfsPath: string,
    canonicalPath: string,
): Promise<Array<{ archiveRelPath: string; canonicalPath: string }> | undefined> {
    const canonical = normalizeCanonicalPath(canonicalPath);
    if (!canonical) {
        return undefined;
    }

    const database = await openDb(dbPath);
    if (!database || !loadedRoot) {
        return undefined;
    }

    const normalizedRomfs = normalizePath(romfsPath);
    if (normalizePath(String(loadedRoot)) !== normalizedRomfs) {
        return undefined;
    }

    const archivePaths = new Map<string, { archiveRelPath: string; canonicalPath: string }>();
    try {
        const stmt = database.prepare(`
            SELECT archive_rel_path, canonical_path
            FROM canonical_entries
            WHERE canonical_path = :canonical COLLATE NOCASE
        `);
        stmt.bind({ ':canonical': canonical });
        while (stmt.step()) {
            const row = stmt.get();
            const archiveRelPath = normalizeCasePreservingRel(String(row[0] ?? ''));
            const canonicalPathValue = normalizeCasePreservingRel(String(row[1] ?? ''));
            const dedupeKey = normalizeCanonicalPath(archiveRelPath);
            if (archiveRelPath && dedupeKey && canonicalPathValue) {
                archivePaths.set(dedupeKey, {
                    archiveRelPath,
                    canonicalPath: canonicalPathValue,
                });
            }
        }
        stmt.free();
    } catch {
        const stmt = database.prepare(`
            SELECT archive_rel_path, canonical_path
            FROM canonical_entries
            WHERE canonical_path = :canonical COLLATE NOCASE
        `);
        stmt.bind({ ':canonical': canonical });
        while (stmt.step()) {
            const row = stmt.get();
            const archiveRelPath = normalizeCasePreservingRel(String(row[0] ?? ''));
            const canonicalPathValue = normalizeCasePreservingRel(String(row[1] ?? canonical));
            const key = normalizeCanonicalPath(archiveRelPath);
            if (archiveRelPath && key) {
                archivePaths.set(key, {
                    archiveRelPath,
                    canonicalPath: canonicalPathValue,
                });
            }
        }
        stmt.free();
    }

    return [...archivePaths.values()].sort((left, right) =>
        left.archiveRelPath.localeCompare(right.archiveRelPath, undefined, { sensitivity: 'base' }),
    );
}

export async function hasBaseCanonicalPath(
    dbPath: string,
    romfsPath: string,
    canonicalPath: string,
): Promise<boolean> {
    const canonical = normalizeCanonicalPath(canonicalPath);
    if (!canonical) {
        return false;
    }

    const database = await openDb(dbPath);
    if (!database || !loadedRoot) {
        return false;
    }

    const normalizedRomfs = normalizePath(romfsPath);
    if (normalizePath(String(loadedRoot)) !== normalizedRomfs) {
        return false;
    }

    const stmt = database.prepare(`
        SELECT 1
        FROM canonical_entries
        WHERE canonical_path = :canonical COLLATE NOCASE
        LIMIT 1
    `);
    stmt.bind({ ':canonical': canonical });
    const exists = stmt.step();
    stmt.free();
    return exists;
}

export function invalidateCanonicalPathIndex(): void {
    closeDb();
}
