import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export type GameProfileSource = 'builtin' | 'manifest' | 'api';

export interface GameIndexingConfig {
    enableRomfsSearch?: boolean;
    enableCanonicalPaths?: boolean;
    archiveExtensions?: string[];
}

/** Where this game keeps its AINB, for the node definition harvester. */
export interface GameAinbConfig {
    /** Directories under romfs holding loose AINB, e.g. `Logic`. Archives are always swept. */
    categoryDirs?: string[];
    /** Glob for the game's node definition tables; `{category}` expands to each categoryDir. */
    nodeDefinitionGlob?: string;
}

export interface GameProfileRegistration {
    id: string;
    displayName: string;
    romfsSentinel: string;
    compressionBackend: string;
    /** Key under the `TKVSC` settings namespace, e.g. `romfsPath` or `splatoon3.romfsPath`. */
    romfsSettingsKey?: string;
    /** Additional settings keys checked before romfsSettingsKey (legacy aliases). */
    legacyRomfsSettingsKeys?: string[];
    indexing?: GameIndexingConfig;
    archivePatterns?: string[];
    /** Game config (.gcf) with MSBT tag definitions. Relative to the registering extension root. */
    msbtConfigPath?: string;
    ainb?: GameAinbConfig;
}

export interface GameProfile extends GameProfileRegistration {
    source: GameProfileSource;
    /** Absolute path to the resolved MSBT `.gcf` file. */
    msbtConfigResolvedPath?: string;
}

export interface GameProfileRegisterOptions {
    /** Extension root used to resolve a relative `msbtConfigPath`. */
    extensionRoot?: string;
    /** TKVSC core extension root (TotK default config fallback). */
    coreExtensionPath?: string;
}

const DEFAULT_TOTK_PROFILE: GameProfileRegistration = {
    id: 'totk',
    displayName: 'Tears of the Kingdom',
    romfsSentinel: 'Pack/ZsDic.pack.zs',
    compressionBackend: 'totk-zstd',
    romfsSettingsKey: 'romfsPath',
    indexing: {
        enableRomfsSearch: true,
        enableCanonicalPaths: true,
    },
    msbtConfigPath: 'vendor/TotK.gcf',
    ainb: {
        categoryDirs: ['Logic', 'AI', 'Sequence'],
        nodeDefinitionGlob: '{category}/NodeDefinition/Node.Product.*.aidefn.byml*',
    },
};

const DEFAULT_ARCHIVE_EXTENSIONS = [
    '.pack',
    '.sarc',
    '.genvb',
    '.blarc',
    '.bfarc',
    '.bntx',
    '.pack.zs',
    '.sarc.zs',
    '.genvb.zs',
    '.blarc.zs',
    '.bfarc.zs',
    '.bntx.zs',
];

class GameProfileRegistry {
    private readonly profiles = new Map<string, GameProfile>();
    private initialized = false;
    private coreExtensionPath = '';

    initBuiltin(extensionPath: string): void {
        this.profiles.clear();
        this.coreExtensionPath = extensionPath;
        const totkPath = path.join(extensionPath, 'config', 'games', 'totk.json');
        if (fs.existsSync(totkPath)) {
            const raw = JSON.parse(fs.readFileSync(totkPath, 'utf8')) as GameProfileRegistration;
            this.registerProfile(raw, 'builtin', { coreExtensionPath: extensionPath });
        } else {
            this.registerProfile(DEFAULT_TOTK_PROFILE, 'builtin', { coreExtensionPath: extensionPath });
        }
        this.initialized = true;
    }

    registerProfile(
        registration: GameProfileRegistration,
        source: GameProfileSource = 'api',
        options?: GameProfileRegisterOptions,
    ): void {
        if (!registration.id) {
            return;
        }
        const indexing = {
            enableRomfsSearch: registration.indexing?.enableRomfsSearch ?? true,
            enableCanonicalPaths: registration.indexing?.enableCanonicalPaths ?? false,
            archiveExtensions:
                registration.indexing?.archiveExtensions?.length
                    ? [...registration.indexing.archiveExtensions]
                    : [...DEFAULT_ARCHIVE_EXTENSIONS],
        };
        const msbtConfigResolvedPath = resolveMsbtConfigPath(
            registration,
            options?.coreExtensionPath ?? this.coreExtensionPath,
            options?.extensionRoot,
        );
        this.profiles.set(registration.id, {
            ...registration,
            indexing,
            source,
            msbtConfigResolvedPath,
        });
    }

    getProfile(gameId: string): GameProfile | undefined {
        return this.profiles.get(gameId);
    }

    getAllProfiles(): GameProfile[] {
        return [...this.profiles.values()];
    }

    getActiveGameId(): string {
        const configured = vscode.workspace
            .getConfiguration('TKVSC')
            .get<string>('activeGameId', 'totk')
            .trim();
        if (configured && this.profiles.has(configured)) {
            return configured;
        }
        return 'totk';
    }

    getActiveProfile(): GameProfile {
        const activeId = this.getActiveGameId();
        return this.profiles.get(activeId) ?? this.profiles.get('totk')!;
    }

    resolveRomfsPath(gameId?: string): string {
        const profile = gameId ? this.profiles.get(gameId) : this.getActiveProfile();
        if (!profile) {
            return '';
        }

        const config = vscode.workspace.getConfiguration('TKVSC');
        const keys = [
            profile.romfsSettingsKey,
            ...(profile.legacyRomfsSettingsKeys ?? []),
        ].filter((key): key is string => Boolean(key));

        for (const key of keys) {
            const value = config.get<string>(key, '').trim();
            if (value) {
                return path.normalize(value);
            }
        }

        const sentinelParts = profile.romfsSentinel.replace(/\\/g, '/').split('/');
        const sentinelFile = sentinelParts.pop() ?? '';
        const sentinelDir = sentinelParts.join(path.sep);

        for (const folder of vscode.workspace.workspaceFolders ?? []) {
            if (folder.uri.scheme !== 'file' && folder.uri.scheme !== 'sarc') {
                continue;
            }
            const candidateRoot = folder.uri.fsPath;
            const candidate = sentinelDir
                ? path.join(candidateRoot, sentinelDir, sentinelFile)
                : path.join(candidateRoot, sentinelFile);
            if (fs.existsSync(candidate)) {
                return path.normalize(candidateRoot);
            }
        }

        return '';
    }

    isValidRomfsPath(romfsPath: string, gameId?: string): boolean {
        const profile = gameId ? this.profiles.get(gameId) : this.getActiveProfile();
        if (!profile || !romfsPath) {
            return false;
        }
        const sentinel = profile.romfsSentinel.replace(/\//g, path.sep);
        return fs.existsSync(path.join(romfsPath, sentinel));
    }

    getArchiveExtensions(gameId?: string): string[] {
        const profile = gameId ? this.profiles.get(gameId) : this.getActiveProfile();
        return profile?.indexing?.archiveExtensions ?? [...DEFAULT_ARCHIVE_EXTENSIONS];
    }

    getMsbtConfigPath(gameId?: string): string {
        const profile = gameId ? this.profiles.get(gameId) : this.getActiveProfile();
        if (profile?.msbtConfigResolvedPath && fs.existsSync(profile.msbtConfigResolvedPath)) {
            return profile.msbtConfigResolvedPath;
        }
        const fallback = path.join(this.coreExtensionPath, 'vendor', 'TotK.gcf');
        return fs.existsSync(fallback) ? fallback : profile?.msbtConfigResolvedPath ?? '';
    }

    ensureInitialized(): void {
        if (!this.initialized) {
            throw new Error('GameProfileRegistry not initialized');
        }
    }
}

const registry = new GameProfileRegistry();

function resolveMsbtConfigPath(
    registration: GameProfileRegistration,
    coreExtensionPath: string,
    extensionRoot?: string,
): string | undefined {
    const configured = registration.msbtConfigPath?.trim();
    const candidates: string[] = [];

    if (configured) {
        if (path.isAbsolute(configured)) {
            candidates.push(configured);
        } else {
            if (extensionRoot) {
                candidates.push(path.join(extensionRoot, configured));
            }
            if (coreExtensionPath) {
                candidates.push(path.join(coreExtensionPath, configured));
            }
        }
    } else if (registration.id === 'totk' && coreExtensionPath) {
        candidates.push(path.join(coreExtensionPath, 'vendor', 'TotK.gcf'));
    }

    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
            return path.normalize(candidate);
        }
    }

    return candidates[0] ? path.normalize(candidates[0]) : undefined;
}

export function initGameProfileRegistry(extensionPath: string): void {
    registry.initBuiltin(extensionPath);
}

export function getGameProfileRegistry(): GameProfileRegistry {
    return registry;
}

export function registerGameProfile(
    registration: GameProfileRegistration,
    options?: GameProfileRegisterOptions,
): void {
    registry.registerProfile(registration, 'api', options);
}

export function getActiveMsbtConfigPath(): string {
    return registry.getMsbtConfigPath();
}

export function getActiveGameProfile(): GameProfile {
    return registry.getActiveProfile();
}

export function getActiveGameId(): string {
    return registry.getActiveGameId();
}

export function resolveRomfsPathForGame(gameId?: string): string {
    return registry.resolveRomfsPath(gameId);
}

export function isRomfsPathValid(romfsPath: string, gameId?: string): boolean {
    return registry.isValidRomfsPath(romfsPath, gameId);
}

export function getRomfsSentinelPath(gameId?: string): string {
    const profile = gameId ? registry.getProfile(gameId) : registry.getActiveProfile();
    return profile?.romfsSentinel.replace(/\//g, path.sep) ?? path.join('Pack', 'ZsDic.pack.zs');
}
