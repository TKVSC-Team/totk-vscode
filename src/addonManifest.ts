import * as path from 'path';
import type { FormatRegistration, BridgeHandlerRegistration } from './formatRegistry';
import type { GameProfileRegistration } from './gameProfile';

export interface TkvscManifestContribution {
    id?: string;
    gameProfile?: GameProfileRegistration;
    formats?: FormatRegistration[];
    aampExtensions?: string[];
    archivePatterns?: string[];
    bridgeHandlers?: Array<{
        kind: string;
        modulePath: string;
        readFunction?: string;
        writeFunction?: string;
    }>;
}

function isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function parseGameProfile(raw: unknown): GameProfileRegistration | undefined {
    if (!raw || typeof raw !== 'object') {
        return undefined;
    }
    const obj = raw as Record<string, unknown>;
    const id = typeof obj.id === 'string' ? obj.id : undefined;
    const displayName = typeof obj.displayName === 'string' ? obj.displayName : undefined;
    const romfsSentinel = typeof obj.romfsSentinel === 'string' ? obj.romfsSentinel : undefined;
    const compressionBackend = typeof obj.compressionBackend === 'string' ? obj.compressionBackend : undefined;
    if (!id || !displayName || !romfsSentinel || !compressionBackend) {
        return undefined;
    }
    const profile: GameProfileRegistration = {
        id,
        displayName,
        romfsSentinel,
        compressionBackend,
    };
    if (typeof obj.romfsSettingsKey === 'string') {
        profile.romfsSettingsKey = obj.romfsSettingsKey;
    }
    if (isStringArray(obj.legacyRomfsSettingsKeys)) {
        profile.legacyRomfsSettingsKeys = obj.legacyRomfsSettingsKeys;
    }
    if (isStringArray(obj.archivePatterns)) {
        profile.archivePatterns = obj.archivePatterns;
    }
    if (typeof obj.msbtConfigPath === 'string' && obj.msbtConfigPath.trim()) {
        profile.msbtConfigPath = obj.msbtConfigPath.trim();
    }
    if (obj.ainb && typeof obj.ainb === 'object') {
        const ainb = obj.ainb as Record<string, unknown>;
        profile.ainb = {
            categoryDirs: isStringArray(ainb.categoryDirs) ? ainb.categoryDirs : undefined,
            nodeDefinitionGlob:
                typeof ainb.nodeDefinitionGlob === 'string' && ainb.nodeDefinitionGlob.trim()
                    ? ainb.nodeDefinitionGlob.trim()
                    : undefined,
        };
    }
    if (obj.indexing && typeof obj.indexing === 'object') {
        const indexing = obj.indexing as Record<string, unknown>;
        profile.indexing = {
            enableRomfsSearch:
                typeof indexing.enableRomfsSearch === 'boolean'
                    ? indexing.enableRomfsSearch
                    : undefined,
            enableCanonicalPaths:
                typeof indexing.enableCanonicalPaths === 'boolean'
                    ? indexing.enableCanonicalPaths
                    : undefined,
            archiveExtensions: isStringArray(indexing.archiveExtensions)
                ? indexing.archiveExtensions
                : undefined,
        };
    }
    return profile;
}

function parseFormats(raw: unknown): FormatRegistration[] | undefined {
    if (!Array.isArray(raw)) {
        return undefined;
    }
    const formats: FormatRegistration[] = [];
    for (const entry of raw) {
        if (!entry || typeof entry !== 'object') {
            continue;
        }
        const obj = entry as Record<string, unknown>;
        if (typeof obj.handler !== 'string' || !isStringArray(obj.extensions)) {
            continue;
        }
        formats.push({
            extensions: obj.extensions,
            handler: obj.handler,
            language: typeof obj.language === 'string' ? obj.language : undefined,
            editable: typeof obj.editable === 'boolean' ? obj.editable : undefined,
        });
    }
    return formats.length > 0 ? formats : undefined;
}

function parseBridgeHandlers(raw: unknown): TkvscManifestContribution['bridgeHandlers'] {
    if (!Array.isArray(raw)) {
        return undefined;
    }
    const handlers: NonNullable<TkvscManifestContribution['bridgeHandlers']> = [];
    for (const entry of raw) {
        if (!entry || typeof entry !== 'object') {
            continue;
        }
        const obj = entry as Record<string, unknown>;
        if (typeof obj.kind !== 'string' || typeof obj.modulePath !== 'string') {
            continue;
        }
        handlers.push({
            kind: obj.kind,
            modulePath: obj.modulePath,
            readFunction: typeof obj.readFunction === 'string' ? obj.readFunction : undefined,
            writeFunction: typeof obj.writeFunction === 'string' ? obj.writeFunction : undefined,
        });
    }
    return handlers.length > 0 ? handlers : undefined;
}

export function mergeArchivePatternLists(
    ...lists: Array<string[] | undefined>
): string[] | undefined {
    const merged = [...new Set(lists.flatMap((list) => list ?? []))];
    return merged.length > 0 ? merged : undefined;
}

export function parseTkvscContribution(raw: unknown): TkvscManifestContribution | undefined {
    if (!raw || typeof raw !== 'object') {
        return undefined;
    }
    const obj = raw as Record<string, unknown>;
    const contribution: TkvscManifestContribution = {};

    if (typeof obj.id === 'string' && obj.id.trim()) {
        contribution.id = obj.id.trim();
    }

    const gameProfile = parseGameProfile(obj.gameProfile);
    if (gameProfile) {
        contribution.gameProfile = gameProfile;
    }

    const formats = parseFormats(obj.formats);
    if (formats) {
        contribution.formats = formats;
    }

    if (isStringArray(obj.aampExtensions)) {
        contribution.aampExtensions = obj.aampExtensions;
    }

    if (isStringArray(obj.archivePatterns)) {
        contribution.archivePatterns = obj.archivePatterns;
    }

    const bridgeHandlers = parseBridgeHandlers(obj.bridgeHandlers);
    if (bridgeHandlers) {
        contribution.bridgeHandlers = bridgeHandlers;
    }

    if (
        !contribution.id
        && !contribution.gameProfile
        && !contribution.formats?.length
        && !contribution.aampExtensions?.length
        && !contribution.archivePatterns?.length
        && !contribution.bridgeHandlers?.length
    ) {
        return undefined;
    }

    return contribution;
}

export function contributionToBridgeHandlers(
    contribution: TkvscManifestContribution,
    extensionRoot: string,
): BridgeHandlerRegistration[] {
    const handlers: BridgeHandlerRegistration[] = [];
    for (const entry of contribution.bridgeHandlers ?? []) {
        if (!entry.kind || !entry.modulePath) {
            continue;
        }
        const resolved = path.isAbsolute(entry.modulePath)
            ? entry.modulePath
            : path.join(extensionRoot, entry.modulePath);
        handlers.push({
            kind: entry.kind,
            modulePath: resolved,
            readFunction: entry.readFunction,
            writeFunction: entry.writeFunction,
        });
    }
    return handlers;
}
