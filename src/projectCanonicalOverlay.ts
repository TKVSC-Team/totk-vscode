import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import initSqlJs, { Database } from 'sql.js';
import { runBridgeJsonAsync } from './bridge';
import { isArchiveFile } from './archives';
import { normalizePath, resolveProjectRomfsMount } from './projectPaths';

let db: Database | undefined;
let loadedDbPath: string | undefined;
let extensionPath: string | undefined;
const importPromises = new Map<string, Promise<void>>();

export interface CanonicalArchiveMatch {
    archiveRelPath: string;
    canonicalPath: string;
}

export interface EnsureProjectImportOptions {
    overlayDbPath: string;
    projectRoot: string;
    romfsPath: string;
    pythonExecutable: string;
    bridgePath: string;
    bridgeEnv: NodeJS.ProcessEnv;
    output: vscode.OutputChannel;
    importSchemaVersion: number;
    shouldIncludeCanonicalPath: (canonicalPath: string) => Promise<boolean>;
}

interface ArchivePathInfo {
    archivePath: string;
    mtimeMs: number;
}

export function setProjectCanonicalOverlayExtensionPath(extPath: string): void {
    extensionPath = extPath;
}

function normalizeRel(value: string): string {
    return value.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
}

function normalizeRelLower(value: string): string {
    return normalizeRel(value).toLowerCase();
}

function projectIdFromRoot(projectRoot: string): string {
    return normalizePath(projectRoot).replace(/\\/g, '/').toLowerCase();
}

function normalizeProjectRoot(projectRoot: string): string {
    const normalized = normalizePath(projectRoot);
    try {
        if (fs.statSync(normalized).isFile()) {
            return normalizePath(path.dirname(normalized));
        }
    } catch {
        // fall through
    }
    return normalized;
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

async function openDb(dbPath: string): Promise<Database> {
    if (loadedDbPath === dbPath && db) {
        return db;
    }

    if (db) {
        db.close();
        db = undefined;
        loadedDbPath = undefined;
    }

    const wasmBinary = getWasmPath();
    const initOpts: Parameters<typeof initSqlJs>[0] = {};
    if (wasmBinary) {
        initOpts.locateFile = () => wasmBinary;
    }
    const SQL = await initSqlJs(initOpts);
    if (fs.existsSync(dbPath)) {
        db = new SQL.Database(fs.readFileSync(dbPath));
    } else {
        db = new SQL.Database();
    }
    loadedDbPath = dbPath;
    ensureSchema(db);
    return db;
}

function ensureSchema(database: Database): void {
    database.exec(`
        CREATE TABLE IF NOT EXISTS project_entries (
            project_id TEXT NOT NULL,
            canonical_path TEXT NOT NULL,
            archive_rel_path TEXT NOT NULL,
            PRIMARY KEY (project_id, canonical_path, archive_rel_path)
        );
        CREATE INDEX IF NOT EXISTS idx_project_entries_lookup
            ON project_entries(project_id, canonical_path COLLATE NOCASE);
        CREATE TABLE IF NOT EXISTS project_import_state (
            project_id TEXT PRIMARY KEY,
            schema_version INTEGER NOT NULL,
            imported_at INTEGER NOT NULL
        );
    `);
}

async function saveDb(dbPath: string): Promise<void> {
    if (!db || loadedDbPath !== dbPath) {
        return;
    }
    await fs.promises.mkdir(path.dirname(dbPath), { recursive: true });
    const data = db.export();
    await fs.promises.writeFile(dbPath, Buffer.from(data));
}

export async function queryProjectCanonicalArchives(
    overlayDbPath: string,
    projectRoot: string,
    canonicalPath: string,
): Promise<CanonicalArchiveMatch[]> {
    const normalizedCanonical = normalizeRel(canonicalPath);
    if (!normalizedCanonical) {
        return [];
    }

    const database = await openDb(overlayDbPath);
    const projectId = projectIdFromRoot(normalizeProjectRoot(projectRoot));
    const stmt = database.prepare(`
        SELECT archive_rel_path, canonical_path
        FROM project_entries
        WHERE project_id = :projectId
          AND canonical_path = :canonical COLLATE NOCASE
    `);
    stmt.bind({
        ':projectId': projectId,
        ':canonical': normalizedCanonical,
    });

    const matches = new Map<string, CanonicalArchiveMatch>();
    while (stmt.step()) {
        const row = stmt.get();
        const archiveRelPath = normalizeRel(String(row[0] ?? ''));
        const canonical = normalizeRel(String(row[1] ?? normalizedCanonical));
        if (!archiveRelPath || !canonical) {
            continue;
        }
        matches.set(normalizeRelLower(archiveRelPath), {
            archiveRelPath,
            canonicalPath: canonical,
        });
    }
    stmt.free();
    return [...matches.values()];
}

export async function addProjectCanonicalEntry(
    overlayDbPath: string,
    projectRoot: string,
    canonicalPath: string,
    archiveRelPath: string,
): Promise<void> {
    const canonical = normalizeRel(canonicalPath);
    const archiveRel = normalizeRel(archiveRelPath);
    if (!canonical || !archiveRel) {
        return;
    }
    const database = await openDb(overlayDbPath);
    const projectId = projectIdFromRoot(normalizeProjectRoot(projectRoot));
    const stmt = database.prepare(`
        INSERT OR IGNORE INTO project_entries (project_id, canonical_path, archive_rel_path)
        VALUES (:projectId, :canonical, :archiveRel)
    `);
    stmt.run({
        ':projectId': projectId,
        ':canonical': canonical,
        ':archiveRel': archiveRel,
    });
    stmt.free();
    await saveDb(overlayDbPath);
}

async function listArchivePaths(rootDir: string): Promise<ArchivePathInfo[]> {
    const pending = [rootDir];
    const archives: ArchivePathInfo[] = [];

    while (pending.length > 0) {
        const current = pending.pop();
        if (!current) {
            continue;
        }
        let entries: fs.Dirent[] = [];
        try {
            entries = await fs.promises.readdir(current, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const entry of entries) {
            const fullPath = path.join(current, entry.name);
            if (entry.isDirectory()) {
                pending.push(fullPath);
                continue;
            }
            if (isArchiveFile(fullPath)) {
                let mtimeMs = 0;
                try {
                    mtimeMs = (await fs.promises.stat(fullPath)).mtimeMs;
                } catch {
                    mtimeMs = 0;
                }
                archives.push({
                    archivePath: fullPath,
                    mtimeMs,
                });
            }
        }
    }
    return archives;
}

async function getProjectImportState(
    overlayDbPath: string,
    projectRoot: string,
): Promise<{ schemaVersion: number; importedAt: number } | undefined> {
    const database = await openDb(overlayDbPath);
    const projectId = projectIdFromRoot(normalizeProjectRoot(projectRoot));
    const stmt = database.prepare(`
        SELECT schema_version, imported_at
        FROM project_import_state
        WHERE project_id = :projectId
    `);
    stmt.bind({ ':projectId': projectId });
    if (!stmt.step()) {
        stmt.free();
        return undefined;
    }
    const row = stmt.get();
    stmt.free();
    return {
        schemaVersion: Number(row[0] ?? -1),
        importedAt: Number(row[1] ?? 0),
    };
}

async function markProjectImported(
    overlayDbPath: string,
    projectRoot: string,
    importSchemaVersion: number,
): Promise<void> {
    const database = await openDb(overlayDbPath);
    const projectId = projectIdFromRoot(normalizeProjectRoot(projectRoot));
    const stmt = database.prepare(`
        INSERT INTO project_import_state (project_id, schema_version, imported_at)
        VALUES (:projectId, :schemaVersion, :importedAt)
        ON CONFLICT(project_id) DO UPDATE SET
            schema_version = excluded.schema_version,
            imported_at = excluded.imported_at
    `);
    stmt.run({
        ':projectId': projectId,
        ':schemaVersion': importSchemaVersion,
        ':importedAt': Date.now(),
    });
    stmt.free();
    await saveDb(overlayDbPath);
}

export async function ensureProjectCanonicalImport(
    options: EnsureProjectImportOptions,
): Promise<void> {
    const projectRoot = normalizeProjectRoot(options.projectRoot);
    const projectId = projectIdFromRoot(projectRoot);

    const existing = importPromises.get(projectId);
    if (existing) {
        return existing;
    }

    const task = (async () => {
        const projectRomfsRoot = resolveProjectRomfsMount(projectRoot, options.romfsPath);
        if (!fs.existsSync(projectRomfsRoot)) {
            await markProjectImported(options.overlayDbPath, projectRoot, options.importSchemaVersion);
            return;
        }

        const archives = await listArchivePaths(projectRomfsRoot);
        const latestArchiveMtime = archives.reduce(
            (max, item) => Math.max(max, item.mtimeMs),
            0,
        );
        const importState = await getProjectImportState(options.overlayDbPath, projectRoot);
        if (
            importState &&
            importState.schemaVersion === options.importSchemaVersion &&
            importState.importedAt >= latestArchiveMtime
        ) {
            return;
        }

        const rows: Array<{ canonical: string; archiveRel: string }> = [];

        for (const archive of archives) {
            let listed: string[] = [];
            try {
                listed = await runBridgeJsonAsync<string[]>(
                    options.pythonExecutable,
                    options.bridgePath,
                    ['list', archive.archivePath, ''],
                    undefined,
                    options.bridgeEnv,
                );
            } catch {
                listed = [];
            }

            const archiveRel = normalizeRel(path.relative(projectRomfsRoot, archive.archivePath));
            if (!archiveRel) {
                continue;
            }
            for (const virtualPath of listed) {
                const canonical = normalizeRel(virtualPath);
                if (!canonical) {
                    continue;
                }
                rows.push({ canonical, archiveRel });
            }
        }

        if (rows.length > 0) {
            const filteredRows: Array<{ canonical: string; archiveRel: string }> = [];
            for (const row of rows) {
                if (await options.shouldIncludeCanonicalPath(row.canonical)) {
                    filteredRows.push(row);
                }
            }
            const database = await openDb(options.overlayDbPath);
            database.run('BEGIN');
            try {
                const clearStmt = database.prepare(`
                    DELETE FROM project_entries
                    WHERE project_id = :projectId
                `);
                clearStmt.run({ ':projectId': projectId });
                clearStmt.free();

                const stmt = database.prepare(`
                    INSERT OR IGNORE INTO project_entries (project_id, canonical_path, archive_rel_path)
                    VALUES (:projectId, :canonical, :archiveRel)
                `);
                for (const row of filteredRows) {
                    stmt.run({
                        ':projectId': projectId,
                        ':canonical': row.canonical,
                        ':archiveRel': row.archiveRel,
                    });
                }
                stmt.free();
                database.run('COMMIT');
            } catch (error) {
                database.run('ROLLBACK');
                throw error;
            }
            await saveDb(options.overlayDbPath);
            options.output.appendLine(
                `[canonical-save] Imported custom canonical paths: ${projectRoot} (${filteredRows.length}/${rows.length})`,
            );
        } else {
            const database = await openDb(options.overlayDbPath);
            const clearStmt = database.prepare(`
                DELETE FROM project_entries
                WHERE project_id = :projectId
            `);
            clearStmt.run({ ':projectId': projectId });
            clearStmt.free();
            await saveDb(options.overlayDbPath);
        }

        await markProjectImported(
            options.overlayDbPath,
            projectRoot,
            options.importSchemaVersion,
        );
    })().finally(() => {
        importPromises.delete(projectId);
    });

    importPromises.set(projectId, task);
    return task;
}
