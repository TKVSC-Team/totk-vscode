import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export function resolveRomfsPath(): string {
    const configured = vscode.workspace
        .getConfiguration('TKVSC')
        .get<string>('romfsPath', '')
        .trim();
    if (configured) {
        return path.normalize(configured);
    }

    for (const folder of vscode.workspace.workspaceFolders ?? []) {
        if (folder.uri.scheme !== 'file' && folder.uri.scheme !== 'sarc') {
            continue;
        }
        const candidate = path.join(folder.uri.fsPath, 'Pack', 'ZsDic.pack.zs');
        if (fs.existsSync(candidate)) {
            return path.normalize(folder.uri.fsPath);
        }
    }

    return '';
}
