import { execFileSync } from 'child_process';
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

