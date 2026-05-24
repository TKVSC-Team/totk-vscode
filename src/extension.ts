import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { execFileSync } from 'child_process';

const PACK_FILE_PATTERN = /\.pack(\.zs)?$/i;

function isPackFile(filePath: string): boolean {
    return PACK_FILE_PATTERN.test(filePath);
}

function pathContainsPack(filePath: string): boolean {
    return /\.pack(\.zs)?/i.test(filePath);
}

function toSarcUri(fileUri: vscode.Uri): vscode.Uri {
    return fileUri.with({ scheme: 'sarc' });
}

let isConvertingWorkspace = false;

function convertFileWorkspaceFolders(): void {
    if (isConvertingWorkspace) {
        return;
    }

    const folders = vscode.workspace.workspaceFolders;
    if (!folders) {
        return;
    }

    const toConvert: { index: number; uri: vscode.Uri; name: string }[] = [];
    for (let i = 0; i < folders.length; i++) {
        const folder = folders[i]!;
        if (folder.uri.scheme === 'file') {
            toConvert.push({
                index: i,
                uri: toSarcUri(folder.uri),
                name: folder.name,
            });
        }
    }

    if (toConvert.length === 0) {
        return;
    }

    isConvertingWorkspace = true;
    try {
        for (let i = toConvert.length - 1; i >= 0; i--) {
            const entry = toConvert[i]!;
            vscode.workspace.updateWorkspaceFolders(entry.index, 1, {
                uri: entry.uri,
                name: entry.name,
            });
        }
    } finally {
        isConvertingWorkspace = false;
    }
}

class SarcProvider implements vscode.FileSystemProvider {
    private _onDidChangeFile = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
    readonly onDidChangeFile = this._onDidChangeFile.event;

    private fileCache = new Map<string, string[]>();

    watch(uri: vscode.Uri): vscode.Disposable {
        return new vscode.Disposable(() => { });
    }

    private getPhysicalPath(fsPath: string): string {
        const match = fsPath.match(/(.*\.pack(\.zs)?)/i);
        return match ? match[1] : fsPath;
    }

    private getInternalPath(fsPath: string, physicalPath: string): string {
        let internal = fsPath.substring(physicalPath.length);
        internal = internal.replace(/\\/g, '/');
        if (internal.startsWith('/')) {
            internal = internal.substring(1);
        }
        return internal;
    }

    private isOnDisk(fsPath: string): boolean {
        return !pathContainsPack(fsPath);
    }

    private listDiskDirectory(dirPath: string): [string, vscode.FileType][] {
        if (!fs.existsSync(dirPath)) {
            return [];
        }

        return fs.readdirSync(dirPath, { withFileTypes: true }).map((entry) => {
            const entryPath = path.join(dirPath, entry.name);
            if (entry.isDirectory()) {
                return [entry.name, vscode.FileType.Directory] as [string, vscode.FileType];
            }
            if (isPackFile(entryPath)) {
                return [entry.name, vscode.FileType.Directory] as [string, vscode.FileType];
            }
            return [entry.name, vscode.FileType.File] as [string, vscode.FileType];
        });
    }

    private statDiskPath(diskPath: string): vscode.FileStat {
        if (!fs.existsSync(diskPath)) {
            throw vscode.FileSystemError.FileNotFound(diskPath);
        }

        const stat = fs.statSync(diskPath);
        if (stat.isDirectory()) {
            return {
                type: vscode.FileType.Directory,
                ctime: stat.ctimeMs,
                mtime: stat.mtimeMs,
                size: 0,
            };
        }

        if (isPackFile(diskPath)) {
            return {
                type: vscode.FileType.Directory,
                ctime: stat.ctimeMs,
                mtime: stat.mtimeMs,
                size: 0,
            };
        }

        return {
            type: vscode.FileType.File,
            ctime: stat.ctimeMs,
            mtime: stat.mtimeMs,
            size: stat.size,
        };
    }

    stat(uri: vscode.Uri): vscode.FileStat {
        const fsPath = uri.fsPath;

        if (this.isOnDisk(fsPath)) {
            return this.statDiskPath(fsPath);
        }

        const physicalPath = this.getPhysicalPath(fsPath);
        const internalPath = this.getInternalPath(fsPath, physicalPath);

        if (!internalPath) {
            return { type: vscode.FileType.Directory, ctime: 0, mtime: 0, size: 0 };
        }

        const files = this.fileCache.get(physicalPath);
        if (files) {
            if (files.includes(internalPath)) {
                return { type: vscode.FileType.File, ctime: 0, mtime: 0, size: 100 };
            }
            const isDir = files.some((f) => f.startsWith(internalPath + '/'));
            if (isDir) {
                return { type: vscode.FileType.Directory, ctime: 0, mtime: 0, size: 0 };
            }
        }

        return { type: vscode.FileType.File, ctime: 0, mtime: 0, size: 0 };
    }

    readDirectory(uri: vscode.Uri): [string, vscode.FileType][] {
        const fsPath = uri.fsPath;

        if (this.isOnDisk(fsPath)) {
            return this.listDiskDirectory(fsPath);
        }

        const physicalPath = this.getPhysicalPath(fsPath);
        const internalPath = this.getInternalPath(fsPath, physicalPath);

        if (
            fsPath !== physicalPath &&
            fsPath !== physicalPath + '\\' &&
            fsPath !== physicalPath + '/' &&
            !this.fileCache.has(physicalPath)
        ) {
            return [];
        }

        let files = this.fileCache.get(physicalPath);

        if (!files) {
            console.log(`Loading SARC into memory: ${physicalPath}`);
            const bridgePath = path.join(__dirname, '..', 'totk_bridge.py');
            const output = execFileSync('py', ['-3.12', bridgePath, 'list', physicalPath], {
                encoding: 'utf-8',
                maxBuffer: 1024 * 1024 * 50,
            });

            const parsed = JSON.parse(output);
            if (parsed.error) {
                throw new Error(parsed.error);
            }
            files = parsed;
            this.fileCache.set(physicalPath, files!);
            console.log(`Successfully mapped ${files!.length} internal files.`);
        }

        const result = new Map<string, vscode.FileType>();
        const prefix = internalPath ? internalPath + '/' : '';

        for (const f of files!) {
            if (f.startsWith(prefix)) {
                const remainder = f.substring(prefix.length);
                const parts = remainder.split('/');
                if (parts.length === 1) {
                    result.set(parts[0], vscode.FileType.File);
                } else {
                    result.set(parts[0], vscode.FileType.Directory);
                }
            }
        }

        return Array.from(result.entries());
    }

    readFile(uri: vscode.Uri): Uint8Array {
        const fsPath = uri.fsPath;

        if (this.isOnDisk(fsPath)) {
            return fs.readFileSync(fsPath);
        }

        const physicalPath = this.getPhysicalPath(fsPath);
        const internalPath = this.getInternalPath(fsPath, physicalPath);

        try {
            console.log(`Reading: ${internalPath}`);
            const bridgePath = path.join(__dirname, '..', 'totk_bridge.py');
            const output = execFileSync('py', ['-3.12', bridgePath, 'read', physicalPath, internalPath], {
                encoding: 'utf-8',
                maxBuffer: 1024 * 1024 * 50,
            });

            const result = JSON.parse(output);
            if (result.error) {
                throw new Error(result.error);
            }

            return new TextEncoder().encode(result.content);
        } catch (error) {
            console.error('Python Read Error:', error);
            return new TextEncoder().encode(`Error reading file: ${error}`);
        }
    }

    createDirectory(uri: vscode.Uri): void { }

    writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean }): void {
        const fsPath = uri.fsPath;

        if (this.isOnDisk(fsPath)) {
            fs.writeFileSync(fsPath, content);
            return;
        }

        const physicalPath = this.getPhysicalPath(fsPath);
        const internalPath = this.getInternalPath(fsPath, physicalPath);

        try {
            console.log(`Writing back to: ${internalPath}`);
            const bridgePath = path.join(__dirname, '..', 'totk_bridge.py');
            const yamlContent = new TextDecoder().decode(content);

            const output = execFileSync('py', ['-3.12', bridgePath, 'write', physicalPath, internalPath], {
                encoding: 'utf-8',
                maxBuffer: 1024 * 1024 * 50,
                input: yamlContent,
            });

            const result = JSON.parse(output);
            if (result.error) {
                throw new Error(result.error);
            }

            this.fileCache.delete(physicalPath);
            console.log('Successfully saved and repacked SARC!');
        } catch (error) {
            console.error('Python Write Error:', error);
            vscode.window.showErrorMessage(`Failed to save: ${error}`);
            throw vscode.FileSystemError.Unavailable(error as string);
        }
    }

    delete(uri: vscode.Uri, options: { recursive: boolean }): void { }
    rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean }): void { }
}

export function activate(context: vscode.ExtensionContext) {
    console.log('TOTK Editor is now active!');

    const sarcProvider = new SarcProvider();
    context.subscriptions.push(
        vscode.workspace.registerFileSystemProvider('sarc', sarcProvider, {
            isCaseSensitive: true,
            isReadonly: false,
        }),
    );

    convertFileWorkspaceFolders();
    context.subscriptions.push(
        vscode.workspace.onDidChangeWorkspaceFolders((event) => {
            if (isConvertingWorkspace) {
                return;
            }
            for (const folder of event.added) {
                if (folder.uri.scheme === 'file') {
                    convertFileWorkspaceFolders();
                    break;
                }
            }
        }),
    );

    const openPack = vscode.commands.registerCommand('totk-editor.openPack', async () => {
        const fileUri = await vscode.window.showOpenDialog({
            canSelectMany: false,
            filters: { 'Pack Files': ['pack', 'zs'] },
        });

        if (fileUri && fileUri[0]) {
            const packPath = fileUri[0].fsPath;
            const sarcUri = toSarcUri(vscode.Uri.file(packPath));

            vscode.workspace.updateWorkspaceFolders(
                vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders.length : 0,
                null,
                { uri: sarcUri, name: path.basename(packPath) },
            );
        }
    });

    context.subscriptions.push(openPack);
}

export function deactivate() { }
