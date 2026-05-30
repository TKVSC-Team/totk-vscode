import { execFile, execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const MAX_BUFFER = 1024 * 1024 * 50;
export function runBridge(
    pythonExecutable: string,
    bridgePath: string,
    args: string[],
    stdin?: string,
    env?: NodeJS.ProcessEnv,
): string {
    return execFileSync(pythonExecutable, [bridgePath, ...args], {
        encoding: 'utf-8',
        maxBuffer: MAX_BUFFER,
        input: stdin,
        env: env ? { ...process.env, ...env } : process.env,
        cwd: path.dirname(bridgePath),
    });
}

export function runBridgeAsync(
    pythonExecutable: string,
    bridgePath: string,
    args: string[],
    stdin?: string,
    env?: NodeJS.ProcessEnv,
): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = execFile(
            pythonExecutable,
            [bridgePath, ...args],
            {
                encoding: 'utf-8',
                maxBuffer: MAX_BUFFER,
                env: env ? { ...process.env, ...env } : process.env,
                cwd: path.dirname(bridgePath),
            },
            (error, stdout) => {
                if (error) {
                    reject(error);
                    return;
                }
                resolve(stdout);
            },
        );

        if (stdin !== undefined) {
            child.stdin?.write(stdin);
            child.stdin?.end();
        }
    });
}

export function runBridgeJson<T>(
    pythonExecutable: string,
    bridgePath: string,
    args: string[],
    stdin?: string,
    env?: NodeJS.ProcessEnv,
): T {
    const output = runBridge(pythonExecutable, bridgePath, args, stdin, env);
    const result = JSON.parse(output) as T & { error?: string };
    if (result && typeof result === 'object' && 'error' in result && result.error) {
        throw new Error(result.error);
    }
    return result;
}

export async function runBridgeJsonAsync<T>(
    pythonExecutable: string,
    bridgePath: string,
    args: string[],
    stdin?: string,
    env?: NodeJS.ProcessEnv,
): Promise<T> {
    const output = await runBridgeAsync(pythonExecutable, bridgePath, args, stdin, env);
    const result = JSON.parse(output) as T & { error?: string };
    if (result && typeof result === 'object' && 'error' in result && result.error) {
        throw new Error(result.error);
    }
    return result;
}

type BridgeReadPayload = { content?: string; contentPath?: string; error?: string };

export interface BntxChannelInfo {
    red: string;
    green: string;
    blue: string;
    alpha: string;
}

export interface BntxImageInfo {
    width: number;
    height: number;
    mipCount: number;
    format: string;
    formatId: string;
    useSRGB: string;
    name: string;
    path: string;
    accessFlags: string;
}

export interface BntxMiscInfo {
    depth: number;
    tileMode: string;
    swizzle: number;
    alignment: number;
    pitch: number;
    dims: string;
    surfaceShape: string;
    flags: number;
    imageSize: number;
    sampleCount: number;
}

export interface BntxTextureResult {
    bntxTexture: true;
    error?: string;
    metadata?: {
        name: string;
        channels: BntxChannelInfo;
        imageInfo: BntxImageInfo;
        misc: BntxMiscInfo;
        width: number;
        height: number;
        format: string;
        formatId: string;
        mipCount: number;
        dataSize: number;
        tileMode: string;
        blockH: number;
        blockHLog2: number;
    };
    pngBase64?: string;
    pngPath?: string;
}

type BridgeReadResult = BridgeReadPayload | BntxTextureResult;

export function isBntxTextureResult(result: BridgeReadResult): result is BntxTextureResult {
    return 'bntxTexture' in result && result.bntxTexture === true;
}

/** Read file from bridge. Returns either text content or a BNTX texture result. */
export function runBridgeRead(
    pythonExecutable: string,
    bridgePath: string,
    args: string[],
    env?: NodeJS.ProcessEnv,
): BridgeReadResult {
    return runBridgeJson<BridgeReadResult>(pythonExecutable, bridgePath, args, undefined, env);
}

export async function runBridgeReadAsync(
    pythonExecutable: string,
    bridgePath: string,
    args: string[],
    env?: NodeJS.ProcessEnv,
): Promise<BridgeReadResult> {
    return runBridgeJsonAsync<BridgeReadResult>(pythonExecutable, bridgePath, args, undefined, env);
}

/** Read editable file text from the bridge (supports spill files for large XLNK YAML). */
export function runBridgeReadContent(
    pythonExecutable: string,
    bridgePath: string,
    args: string[],
    env?: NodeJS.ProcessEnv,
): string {
    const result = runBridgeJson<BridgeReadPayload>(pythonExecutable, bridgePath, args, undefined, env);
    if (result.contentPath) {
        try {
            return fs.readFileSync(result.contentPath, 'utf-8');
        } finally {
            try {
                fs.unlinkSync(result.contentPath);
            } catch {
                /* best-effort cleanup */
            }
        }
    }
    return result.content ?? '';
}

/** Async version of runBridgeReadContent. */
export async function runBridgeReadContentAsync(
    pythonExecutable: string,
    bridgePath: string,
    args: string[],
    env?: NodeJS.ProcessEnv,
): Promise<string> {
    const result = await runBridgeJsonAsync<BridgeReadPayload>(
        pythonExecutable,
        bridgePath,
        args,
        undefined,
        env,
    );
    if (result.contentPath) {
        try {
            return await fs.promises.readFile(result.contentPath, 'utf-8');
        } finally {
            try {
                await fs.promises.unlink(result.contentPath);
            } catch {
                /* best-effort cleanup */
            }
        }
    }
    return result.content ?? '';
}

export async function runBridgeUpdateBntxMetadataAsync(
    pythonExecutable: string,
    bridgePath: string,
    archivePath: string,
    internalPath: string,
    metadata: Record<string, any>,
    env?: NodeJS.ProcessEnv,
): Promise<void> {
    await runBridgeJsonAsync(
        pythonExecutable,
        bridgePath,
        ['update-bntx-metadata', archivePath, internalPath],
        JSON.stringify(metadata),
        env,
    );
}

export async function runBridgeUpdateTxtgMetadataAsync(
    pythonExecutable: string,
    bridgePath: string,
    archivePath: string,
    internalPath: string,
    metadata: Record<string, any>,
    env?: NodeJS.ProcessEnv,
): Promise<void> {
    await runBridgeJsonAsync(
        pythonExecutable,
        bridgePath,
        ['update-txtg-metadata', archivePath, internalPath],
        JSON.stringify(metadata),
        env,
    );
}

export async function runBridgeRenameBntxTextureAsync(
    pythonExecutable: string,
    bridgePath: string,
    archivePath: string,
    internalPath: string,
    newName: string,
    env?: NodeJS.ProcessEnv,
): Promise<void> {
    await runBridgeJsonAsync(
        pythonExecutable,
        bridgePath,
        ['rename-bntx-texture', archivePath, internalPath, newName],
        undefined,
        env,
    );
}

export async function runBridgeDeleteBntxTextureAsync(
    pythonExecutable: string,
    bridgePath: string,
    archivePath: string,
    internalPath: string,
    env?: NodeJS.ProcessEnv,
): Promise<void> {
    await runBridgeJsonAsync(
        pythonExecutable,
        bridgePath,
        ['delete-bntx-texture', archivePath, internalPath],
        undefined,
        env,
    );
}

export async function runBridgeReplaceBntxPayloadAsync(
    pythonExecutable: string,
    bridgePath: string,
    archivePath: string,
    internalPath: string,
    rawPayload: Buffer,
    env?: NodeJS.ProcessEnv,
): Promise<void> {
    await runBridgeJsonAsync(
        pythonExecutable,
        bridgePath,
        ['replace-bntx-payload', archivePath, internalPath],
        rawPayload.toString('base64'),
        env,
    );
}

export async function runBridgeReplaceTxtgPayloadAsync(
    pythonExecutable: string,
    bridgePath: string,
    archivePath: string,
    internalPath: string,
    rawPayload: Buffer,
    env?: NodeJS.ProcessEnv,
): Promise<void> {
    await runBridgeJsonAsync(
        pythonExecutable,
        bridgePath,
        ['replace-txtg-payload', archivePath, internalPath],
        rawPayload.toString('base64'),
        env,
    );
}
