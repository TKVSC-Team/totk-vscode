import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import * as vscode from 'vscode';
import { runBridgeJson, runBridgeJsonAsync } from './bridge';
import {
    getDiskArchivePath,
    getLocatorInsideDiskArchive,
    isArchiveBrowsePath,
} from './archives';

const PROMPT_MARKER = 'TOTK_EXTERNAL_TOOL_PROMPT';

type ExternalTool = {
    id: string;
    name: string;
    executable: string;
    args?: string[];
    passFilePath?: boolean;
};

type ExternalToolConfig = {
    tools: ExternalTool[];
    associations: Record<string, string>;
};

type RegisterExternalToolOptions = {
    bridgePath: string;
    getPython: () => string;
    getBridgeEnv: () => NodeJS.ProcessEnv;
};

type ToolPick =
    | { kind: 'tool'; tool: ExternalTool }
    | { kind: 'add' };

const defaultConfig = (): ExternalToolConfig => ({
    tools: [],
    associations: {},
});

export function formatExternalToolPrompt(filePath: string, reason: string): string {
    return [
        PROMPT_MARKER,
        `File: ${filePath}`,
        '',
        reason,
        '',
        'Use the CodeLens buttons above to open this file in an external tool.',
    ].join('\n');
}

function isExternalToolPromptDocument(document: vscode.TextDocument): boolean {
    return document.getText().startsWith(PROMPT_MARKER);
}

function extensionAssociationKey(filePath: string): string {
    const normalized = filePath.toLowerCase().replace(/\\/g, '/');
    const multi = normalized.match(/(\.[^./\\]+\.zs)$/);
    if (multi) {
        return multi[1]!;
    }
    const ext = path.extname(normalized);
    return ext || path.basename(normalized);
}

function sanitizeFileName(name: string): string {
    return name.replace(/[^\w.-]/g, '_');
}

export function registerExternalToolSupport(
    context: vscode.ExtensionContext,
    options: RegisterExternalToolOptions,
): void {
    const resolveCommandUri = (uri?: vscode.Uri): vscode.Uri | undefined => {
        return uri ?? vscode.window.activeTextEditor?.document.uri;
    };

    const onDidChangeCodeLenses = new vscode.EventEmitter<void>();
    const storagePath = path.join(context.globalStorageUri.fsPath, 'external-tools.json');

    const readConfig = (): ExternalToolConfig => {
        try {
            if (!fs.existsSync(storagePath)) {
                return defaultConfig();
            }
            const parsed = JSON.parse(fs.readFileSync(storagePath, 'utf-8')) as ExternalToolConfig;
            return {
                tools: Array.isArray(parsed.tools) ? parsed.tools : [],
                associations:
                    parsed.associations && typeof parsed.associations === 'object'
                        ? parsed.associations
                        : {},
            };
        } catch {
            return defaultConfig();
        }
    };

    const writeConfig = (config: ExternalToolConfig): void => {
        fs.mkdirSync(path.dirname(storagePath), { recursive: true });
        fs.writeFileSync(storagePath, JSON.stringify(config, null, 2), 'utf-8');
        onDidChangeCodeLenses.fire();
    };

    const findToolForUri = (uri: vscode.Uri): ExternalTool | undefined => {
        const config = readConfig();
        const key = extensionAssociationKey(uri.fsPath);
        const toolId = config.associations[key];
        if (!toolId) {
            return undefined;
        }
        return config.tools.find((tool) => tool.id === toolId);
    };

    const resolveToolLaunchPath = async (uri: vscode.Uri): Promise<string> => {
        if (!isArchiveBrowsePath(uri.fsPath)) {
            return uri.fsPath;
        }

        const python = options.getPython();
        if (!python) {
            throw new Error(
                'Python environment is not ready. Run "TOTK: Set Up Python Environment" first.',
            );
        }

        const diskArchive = getDiskArchivePath(uri.fsPath);
        const locator = getLocatorInsideDiskArchive(uri.fsPath, diskArchive);
        if (!locator) {
            throw new Error('Cannot export archive root to an external tool.');
        }

        const result = await runBridgeJsonAsync<{ path: string }>(
            python,
            options.bridgePath,
            ['export-temp', diskArchive, locator],
            undefined,
            options.getBridgeEnv(),
        );
        return result.path;
    };

    const launchTool = (tool: ExternalTool, targetPath: string, forcePassFilePath = false): void => {
        const hasPlaceholder = (tool.args ?? []).some((arg) => arg.includes('${file}'));
        const shouldPassFile = forcePassFilePath || tool.passFilePath === true;
        const args =
            tool.args && tool.args.length > 0
                ? tool.args.map((arg) => arg.replaceAll('${file}', targetPath))
                : shouldPassFile
                    ? [targetPath]
                    : [];
        if (!hasPlaceholder && tool.args && tool.args.length > 0 && shouldPassFile) {
            args.push(targetPath);
        }

        spawn(tool.executable, args, {
            stdio: 'ignore',
            windowsHide: false,
        });
    };

    const addToolInteractively = async (): Promise<ExternalTool | undefined> => {
        const picked = await vscode.window.showOpenDialog({
            canSelectMany: false,
            canSelectFolders: false,
            canSelectFiles: true,
            title: 'Pick external tool executable',
            filters: process.platform === 'win32' ? { Executables: ['exe', 'bat', 'cmd'] } : undefined,
        });
        const executable = picked?.[0]?.fsPath;
        if (!executable) {
            return undefined;
        }

        const defaultName = sanitizeFileName(path.parse(executable).name || 'Tool');
        const name = await vscode.window.showInputBox({
            title: 'External tool name',
            value: defaultName,
            prompt: 'Name shown in "Open in ..."',
            ignoreFocusOut: true,
        });
        if (!name?.trim()) {
            return undefined;
        }

        const launchMode = await vscode.window.showQuickPick(
            [
                {
                    label: 'Open tool only',
                    description: 'Recommended for app launchers like Switch Toolbox',
                    passFilePath: false,
                },
                {
                    label: 'Open tool and pass selected file path',
                    description: 'Use for tools that accept a file path argument',
                    passFilePath: true,
                },
            ],
            {
                title: 'How should this tool launch?',
            },
        );
        if (!launchMode) {
            return undefined;
        }

        const config = readConfig();
        const tool: ExternalTool = {
            id: `tool-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
            name: name.trim(),
            executable,
            passFilePath: launchMode.passFilePath,
        };
        config.tools.push(tool);
        writeConfig(config);
        return tool;
    };

    const chooseToolForUri = async (uri: vscode.Uri): Promise<ExternalTool | undefined> => {
        const key = extensionAssociationKey(uri.fsPath);
        const config = readConfig();

        const picks: vscode.QuickPickItem[] = config.tools.map((tool) => ({
            label: tool.name,
            description: tool.executable,
        }));
        picks.push({
            label: 'Add tool executable...',
            description: 'Browse and add a new external tool',
        });

        const selected = await vscode.window.showQuickPick(picks, {
            title: `Choose external tool for ${key}`,
            placeHolder: 'Select a tool for this file type, or add a new one',
        });
        if (!selected) {
            return undefined;
        }

        let tool: ExternalTool | undefined;
        const pick: ToolPick =
            selected.label === 'Add tool executable...'
                ? { kind: 'add' }
                : {
                    kind: 'tool',
                    tool: config.tools.find((entry) => entry.name === selected.label)!,
                };

        if (pick.kind === 'add') {
            tool = await addToolInteractively();
            if (!tool) {
                return undefined;
            }
        } else {
            tool = pick.tool;
        }

        const updated = readConfig();
        updated.associations[key] = tool.id;
        writeConfig(updated);
        return tool;
    };

    const openWithTool = async (uri: vscode.Uri): Promise<void> => {
        try {
            const tool = findToolForUri(uri) ?? (await chooseToolForUri(uri));
            if (!tool) {
                return;
            }
            const targetPath = await resolveToolLaunchPath(uri);
            // Default action always opens the selected file in the associated tool.
            launchTool(tool, targetPath, true);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            void vscode.window.showErrorMessage(`Failed to open external tool: ${message}`);
        }
    };

    context.subscriptions.push(
        onDidChangeCodeLenses,
        vscode.commands.registerCommand('totk-editor.externalTools.open', async (uri?: vscode.Uri) => {
            const targetUri = resolveCommandUri(uri);
            if (!targetUri) {
                return;
            }
            await openWithTool(targetUri);
        }),
        vscode.commands.registerCommand('totk-editor.externalTools.choose', async (uri?: vscode.Uri) => {
            const targetUri = resolveCommandUri(uri);
            if (!targetUri) {
                return;
            }
            const tool = await chooseToolForUri(targetUri);
            if (!tool) {
                return;
            }
            await openWithTool(targetUri);
        }),
        vscode.languages.registerCodeLensProvider(
            [{ scheme: 'sarc' }, { scheme: 'totk-dump' }],
            {
                onDidChangeCodeLenses: onDidChangeCodeLenses.event,
                provideCodeLenses(document: vscode.TextDocument) {
                    if (!isExternalToolPromptDocument(document)) {
                        return [];
                    }

                    const tool = findToolForUri(document.uri);
                    const range = new vscode.Range(0, 0, 0, 0);
                    return [
                        new vscode.CodeLens(range, {
                            title: tool ? `Open in ${tool.name}` : 'Open in External Tool...',
                            command: 'totk-editor.externalTools.open',
                            arguments: [document.uri],
                        }),
                        new vscode.CodeLens(range, {
                            title: 'Choose / Add Tool...',
                            command: 'totk-editor.externalTools.choose',
                            arguments: [document.uri],
                        }),
                    ];
                },
            },
        ),
    );
}
