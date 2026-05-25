import * as fs from 'fs';
import * as path from 'path';

let extensions: Record<string, string> | undefined;

export function initCoreFsExtensions(extensionPath: string): void {
    const jsonPath = path.join(extensionPath, 'config', 'coreFsExtensions.json');
    extensions = JSON.parse(fs.readFileSync(jsonPath, 'utf8')) as Record<string, string>;
}

export function getHandlerType(filePath: string): string | undefined {
    let lower = filePath.toLowerCase().replace(/\\/g, '/');
    if (lower.endsWith('.zs')) { lower = lower.slice(0, -3); }
    const dot = lower.lastIndexOf('.');
    const ext = dot === -1 ? '' : lower.slice(dot + 1);
    return extensions?.[ext];
}

export function isCoreExtension(filePath: string): boolean {
    return getHandlerType(filePath) !== undefined;
}

export function getCoreExtensions(): Record<string, string> {
    return extensions ?? {};
}