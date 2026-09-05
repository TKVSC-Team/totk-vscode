import { execFile, execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from './logger';

const MAX_BUFFER = 1024 * 1024 * 500;
export function runBridge(
    pythonExecutable: string,
    bridgePath: string,
    args: string[],
    stdin?: string,
    env?: NodeJS.ProcessEnv,
): string {
    const startTime = Date.now();
    logger.debug(`bridge: Running sync command [${args[0]}] with args: ${args.slice(1).join(' ')}`);
    try {
        const result = execFileSync(pythonExecutable, [bridgePath, ...args], {
            encoding: 'utf-8',
            maxBuffer: MAX_BUFFER,
            input: stdin,
            env: env ? { ...process.env, ...env } : process.env,
            cwd: path.dirname(bridgePath),
        });
        const elapsed = Date.now() - startTime;
        logger.debug(`bridge: Sync command [${args[0]}] finished successfully in ${elapsed}ms (output size: ${result.length} chars)`);
        return result;
    } catch (error) {
        const elapsed = Date.now() - startTime;
        logger.error(`bridge: Sync command [${args[0]}] failed after ${elapsed}ms. Error:`, error as Error);
        throw error;
    }
}

export function runBridgeAsync(
    pythonExecutable: string,
    bridgePath: string,
    args: string[],
    stdin?: string,
    env?: NodeJS.ProcessEnv,
): Promise<string> {
    const startTime = Date.now();
    logger.debug(`bridge: Running async command [${args[0]}] with args: ${args.slice(1).join(' ')}`);
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
                const elapsed = Date.now() - startTime;
                if (error) {
                    logger.error(`bridge: Async command [${args[0]}] failed after ${elapsed}ms. Error:`, error);
                    reject(error);
                    return;
                }
                logger.debug(`bridge: Async command [${args[0]}] finished successfully in ${elapsed}ms (output size: ${stdout.length} chars)`);
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

export interface BridgeResult {
    success?: boolean;
    error?: string;
    [key: string]: any;
}

export interface BwavAudioResult extends BridgeResult {
    wavPath?: string;
}

export interface BarsEntry {
    name: string;
    name_hash: number;
    amta_offset: number;
    bwav_offset: number;
    has_prefetch: boolean;
    has_romfs_bwav: boolean;
    metadata?: any;
}

export interface BarsListResult extends BridgeResult {
    entries?: BarsEntry[];
}

export interface BarsAudioResult extends BridgeResult {
    wavPath?: string;
    name?: string;
    isPrefetch?: boolean;
    loopStart?: number;
    loopEnd?: number;
}

export interface BarsReplaceResult extends BridgeResult {
    success?: boolean;
    name?: string;
    /** What was embedded into the BARS: 'prefetch', 'full', or null (stream-only entry). */
    embedded?: 'prefetch' | 'full' | null;
    /** True when the entry streams from romfs and the full BWAV must also be placed there. */
    needsStreamFile?: boolean;
    fullBwavTempPath?: string;
    numSamples?: number;
    channels?: number;
    loopStart?: number | null;
    loopEnd?: number | null;
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

/** Read editable file text from the bridge (supports spill files for large XLNK text). */
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

/** Loop specification for a BARS audio replacement:
 *  'auto' honors the source file's own loop metadata, 'none' strips loops,
 *  a number is an explicit sample position. */
export type BarsLoopSpec = 'auto' | 'none' | number;

export async function runBridgeReplaceBarsAudioAsync(
    pythonExecutable: string,
    bridgePath: string,
    archivePath: string,
    internalPath: string,
    entryIndex: number,
    audioPayload: Buffer,
    loopStart: BarsLoopSpec = 'auto',
    loopEnd: BarsLoopSpec = 'auto',
    sourceName = 'audio.bin',
    env?: NodeJS.ProcessEnv,
): Promise<BarsReplaceResult> {
    return runBridgeJsonAsync<BarsReplaceResult>(
        pythonExecutable,
        bridgePath,
        [
            'replace-bars-audio',
            archivePath,
            internalPath,
            entryIndex.toString(),
            loopStart.toString(),
            loopEnd.toString(),
            sourceName,
        ],
        audioPayload.toString('base64'),
        env,
    );
}

export async function runBridgePrepareFontReplacementAsync(
    pythonExecutable: string,
    bridgePath: string,
    importPath: string,
    targetPath: string,
    env?: NodeJS.ProcessEnv,
): Promise<Buffer> {
    const result = await runBridgeJsonAsync<{ path: string }>(
        pythonExecutable,
        bridgePath,
        ['prepare-font-replacement', importPath, targetPath],
        undefined,
        env,
    );
    const raw = await fs.promises.readFile(result.path);
    try {
        await fs.promises.unlink(result.path);
    } catch {
        // Best-effort temp cleanup.
    }
    return raw;
}
