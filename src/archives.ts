/** SARC-based archives (.pack, .sarc, .genvb, .blarc, .bntx and optional .zs compression). */

export const ARCHIVE_FILE_PATTERN = /\.(pack|sarc|genvb|blarc|bfarc|bntx)(\.zs)?$/i;

const BNTX_PARENT_PATTERN = /\.bntx(\.zs)?[/\\]/i;

/** True when the URI path indicates a file inside a BNTX container. */
export function isBntxTextureUri(uri: { fsPath: string }): boolean {
    return BNTX_PARENT_PATTERN.test(uri.fsPath);
}

const DISK_ARCHIVE_PATTERN = /^(.+?\.(pack|sarc|genvb|blarc|bfarc|bntx)(\.zs)?)(?=\\|\/|$)/i;

export function isArchiveFileName(name: string): boolean {
    return ARCHIVE_FILE_PATTERN.test(name.replace(/\\/g, '/').split('/').pop() ?? name);
}

export function isArchiveFile(filePath: string): boolean {
    return ARCHIVE_FILE_PATTERN.test(filePath.replace(/\\/g, '/'));
}

/** True when the path continues *inside* an archive file (virtual path). */
export function isPathInsideArchive(filePath: string): boolean {
    const normalized = filePath.replace(/\\/g, '/').replace(/\/+$/, '');
    const segments = normalized.split('/').filter(Boolean);
    for (let i = 0; i < segments.length; i++) {
        if (!isArchiveFileName(segments[i]!)) {
            continue;
        }
        if (i < segments.length - 1) {
            return true;
        }
    }
    return false;
}

/** Use archive listing / reads (on-disk archive file or path inside one). */
export function isArchiveBrowsePath(filePath: string): boolean {
    return isPathInsideArchive(filePath) || isArchiveFile(filePath);
}

/** @deprecated Prefer {@link isPathInsideArchive}. */
export function pathContainsArchive(filePath: string): boolean {
    return isPathInsideArchive(filePath);
}

/** First on-disk archive in a path (for nested archive browsing). */
export function getDiskArchivePath(fsPath: string): string {
    const match = fsPath.replace(/\\/g, '/').match(DISK_ARCHIVE_PATTERN);
    return match ? match[1]! : fsPath;
}

/** Path inside the on-disk archive (may include nested archive segments). */
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
