import * as fs from 'fs';

export async function deleteDiskPath(diskPath: string, recursive: boolean): Promise<void> {
    try {
        const stat = await fs.promises.stat(diskPath);
        if (stat.isDirectory()) {
            if (recursive) {
                await fs.promises.rm(diskPath, { recursive: true, force: true });
            } else {
                await fs.promises.rmdir(diskPath);
            }
            return;
        }
        await fs.promises.unlink(diskPath);
    } catch (err: any) {
        if (err.code !== 'ENOENT') {
            throw err;
        }
    }
}

export async function renameDiskPath(oldPath: string, newPath: string, overwrite: boolean): Promise<void> {
    if (!overwrite) {
        try {
            await fs.promises.stat(newPath);
            throw new Error(`Destination already exists: ${newPath}`);
        } catch (err: any) {
            if (err.code !== 'ENOENT') {
                throw err;
            }
        }
    }

    const parent = newPath.replace(/[/\\][^/\\]+$/, '');
    if (parent) {
        try {
            await fs.promises.stat(parent);
        } catch (err: any) {
            if (err.code === 'ENOENT') {
                await fs.promises.mkdir(parent, { recursive: true });
            } else {
                throw err;
            }
        }
    }

    await fs.promises.rename(oldPath, newPath);
}

export async function createDiskDirectory(diskPath: string): Promise<void> {
    await fs.promises.mkdir(diskPath, { recursive: true });
}
