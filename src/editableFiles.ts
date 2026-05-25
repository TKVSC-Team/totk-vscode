import * as vscode from 'vscode';
import { isAampExtension } from './aampExtensions';
import { isCoreExtension } from './coreFsExtensions';

/** TOTK file types that the Python bridge can convert to/from editor text. */

export function isEditableFile(filePath: string): boolean {
    return isCoreExtension(filePath) || isAampExtension(filePath);
}

export function toTotkDiskUri(fileUri: vscode.Uri): vscode.Uri {
    return fileUri.with({ scheme: 'totk-disk' });
}
