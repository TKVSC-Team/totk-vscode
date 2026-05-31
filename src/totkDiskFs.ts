import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { logger } from './logger';
import { runBridgeJsonAsync, runBridgeReadContentAsync } from './bridge';
import { isArchiveFile } from './archives';
import { createDiskDirectory, deleteDiskPath, renameDiskPath } from './diskFsOps';
import { isEditableFile } from './editableFiles';

export interface DiskWriteNotification {
    diskPath: string;
    content: Uint8Array;
    textContent?: string;
}

export class TotkDiskFileSystemProvider implements vscode.FileSystemProvider {
    private readonly _onDidChangeFile = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
    readonly onDidChangeFile = this._onDidChangeFile.event;
    private readonly fileContentCache = new Map<string, string | Uint8Array>();

    constructor(
        private readonly bridgePath: string,
        private readonly getPython: () => string,
        private readonly getBridgeEnv: () => NodeJS.ProcessEnv,
        private readonly onDidWriteFile?: (info: DiskWriteNotification) => Promise<void>,
    ) {}

    private requirePython(): string {
        const python = this.getPython();
        if (!python) {
            throw new Error(
                'Python environment is not ready. Run "TKVSC: Set Up Python Environment" or install Python 3.10+.',
            );
        }
        return python;
    }

    watch(): vscode.Disposable {
        return new vscode.Disposable(() => undefined);
    }

    async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
        const diskPath = uri.fsPath;
        try {
            const stat = await fs.promises.stat(diskPath);
            return {
                type: stat.isDirectory() ? vscode.FileType.Directory : vscode.FileType.File,
                ctime: stat.ctimeMs,
                mtime: stat.mtimeMs,
                size: stat.size,
            };
        } catch (err: any) {
            if (err.code === 'ENOENT') {
                throw vscode.FileSystemError.FileNotFound(diskPath);
            }
            throw err;
        }
    }

    async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
        const diskPath = uri.fsPath;
        try {
            const entries = await fs.promises.readdir(diskPath, { withFileTypes: true });
            return entries.map((entry) => {
                const entryPath = path.join(diskPath, entry.name);
                if (entry.isDirectory()) {
                    return [entry.name, vscode.FileType.Directory];
                }
                if (isArchiveFile(entryPath)) {
                    return [entry.name, vscode.FileType.File];
                }
                return [entry.name, vscode.FileType.File];
            });
        } catch (err: any) {
            if (err.code === 'ENOENT') {
                return [];
            }
            throw err;
        }
    }

    async readFile(uri: vscode.Uri): Promise<Uint8Array> {
        const diskPath = uri.fsPath;
        logger.info(`totk-disk: Reading file: ${diskPath}`);

        if (!isEditableFile(diskPath)) {
            logger.debug(`totk-disk: Non-editable raw binary file. Reading directly from disk.`);
            const raw = await fs.promises.readFile(diskPath);
            this.fileContentCache.set(uri.toString(), raw);
            return raw;
        }

        logger.debug(`totk-disk: Editable file detected. Invoking Python bridge read-disk for processing...`);
        try {
            logger.showProcessingToast(diskPath);
            const content = await runBridgeReadContentAsync(
                this.requirePython(),
                this.bridgePath,
                ['read-disk', diskPath],
                this.getBridgeEnv(),
            );
            logger.debug(`totk-disk: Successfully read and processed file: ${diskPath}`);
            this.fileContentCache.set(uri.toString(), content);
            return new TextEncoder().encode(content);
        } catch (error) {
            logger.error(`totk-disk: Failed to read editable file: ${diskPath}`, error as Error);
            const message = error instanceof Error ? error.message : String(error);
            return new TextEncoder().encode(`Error reading file: ${message}`);
        }
    }

    async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
        const diskPath = uri.fsPath;
        const text = new TextDecoder().decode(content);
        logger.info(`totk-disk: Writing file: ${diskPath} (${content.length} bytes)`);

        if (!isEditableFile(diskPath)) {
            logger.debug(`totk-disk: Non-editable raw binary file. Writing directly to disk.`);
            const cached = this.fileContentCache.get(uri.toString());
            if (cached instanceof Uint8Array && cached.length === content.length && Buffer.compare(cached, content) === 0) {
                logger.info(`totk-disk: Skipping write and canonical sync for unchanged binary file: ${diskPath}`);
                return;
            }
            await fs.promises.writeFile(diskPath, content);
            logger.showSavedToast(diskPath);
            await this.onDidWriteFile?.({ diskPath, content });
            this.fileContentCache.set(uri.toString(), content);
            return;
        }

        try {
            await fs.promises.stat(diskPath);
        } catch (err: any) {
            if (err.code === 'ENOENT') {
                logger.debug(`totk-disk: File does not exist on disk. Writing directly first.`);
                await fs.promises.writeFile(diskPath, content);
                logger.showSavedToast(diskPath);
                await this.onDidWriteFile?.({ diskPath, content, textContent: text });
                this.fileContentCache.set(uri.toString(), text);
                return;
            }
        }

        const cached = this.fileContentCache.get(uri.toString());
        if (typeof cached === 'string' && cached === text) {
            logger.info(`totk-disk: Skipping write and canonical sync for unchanged file: ${diskPath}`);
            return;
        }

        logger.debug(`totk-disk: Editable file exists on disk. Invoking Python bridge write-disk...`);
        try {
            logger.showProcessingToast(diskPath);
            await runBridgeJsonAsync<{ success: boolean }>(
                this.requirePython(),
                this.bridgePath,
                ['write-disk', diskPath],
                text,
                this.getBridgeEnv(),
            );
            logger.info(`totk-disk: Successfully wrote and processed file: ${diskPath}`);
            logger.showSavedToast(diskPath);
            await this.onDidWriteFile?.({ diskPath, content, textContent: text });
            this.fileContentCache.set(uri.toString(), text);
        } catch (error) {
            logger.error(`totk-disk: Failed to write editable file: ${diskPath}`, error as Error);
            const message = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Failed to save: ${message}`);
            throw vscode.FileSystemError.Unavailable(message);
        }
    }

    async createDirectory(uri: vscode.Uri): Promise<void> {
        logger.info(`totk-disk: Creating directory: ${uri.fsPath}`);
        await createDiskDirectory(uri.fsPath);
        this._onDidChangeFile.fire([{ type: vscode.FileChangeType.Created, uri }]);
    }

    async delete(uri: vscode.Uri, options: { recursive: boolean }): Promise<void> {
        logger.info(`totk-disk: Deleting path (recursive=${options.recursive}): ${uri.fsPath}`);
        this.fileContentCache.delete(uri.toString());
        await deleteDiskPath(uri.fsPath, options.recursive);
        this._onDidChangeFile.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
    }

    async rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean }): Promise<void> {
        logger.info(`totk-disk: Renaming path (overwrite=${options.overwrite}) from: ${oldUri.fsPath} to: ${newUri.fsPath}`);
        const cached = this.fileContentCache.get(oldUri.toString());
        if (cached !== undefined) {
            this.fileContentCache.delete(oldUri.toString());
            this.fileContentCache.set(newUri.toString(), cached);
        }
        await renameDiskPath(oldUri.fsPath, newUri.fsPath, options.overwrite);
        this._onDidChangeFile.fire([
            { type: vscode.FileChangeType.Deleted, uri: oldUri },
            { type: vscode.FileChangeType.Created, uri: newUri },
        ]);
    }
}
