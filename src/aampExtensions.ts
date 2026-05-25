import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

let baseExtensions: Set<string> | undefined;

export function initAampExtensions(extensionPath: string): void {
    const jsonPath = path.join(extensionPath, 'config', 'aamp-extensions.json');
    const parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf8')) as string[];
    baseExtensions = new Set(parsed.map((ext) => ext.toLowerCase()));
}

function extensionName(filePath: string): string {
    let lower = filePath.toLowerCase().replace(/\\/g, '/');
    if (lower.endsWith('.zs')) {
        lower = lower.slice(0, -3);
    }
    const dot = lower.lastIndexOf('.');
    return dot === -1 ? '' : lower.slice(dot + 1);
}

export function getAampExtensions(): Set<string> {
    const base = baseExtensions ?? new Set<string>();
    const extra = vscode.workspace
        .getConfiguration('totk-editor')
        .get<string[]>('extraAampExtensions', [])
        .map((ext) => ext.toLowerCase().replace(/^\./, ''));
    return new Set([...base, ...extra]);
}

export function isAampExtension(filePath: string): boolean {
    const ext = extensionName(filePath);
    return ext !== '' && getAampExtensions().has(ext);
}
