import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { logger } from './logger';
import { resolveRomfsPath } from './romfs';
import { isWithinRoot, resolveProjectRomfsMount } from './projectPaths';

export interface ProjectRoot {
    fsPath: string;
    label: string;
}

interface TkvscConfig {
    canonicalSyncBlacklistPrefixes?: string[];
    canonicalSyncFileExtensionBlacklist?: string[];
}

export async function configureFilteringRules(
    uri: vscode.Uri,
    projectRoots: ProjectRoot[]
): Promise<void> {
    const fsPath = uri.fsPath;
    const romfsPath = resolveRomfsPath();

    let relativePath = '';
    const fileName = path.basename(fsPath);

    if (romfsPath && isWithinRoot(romfsPath, fsPath)) {
        relativePath = path.relative(romfsPath, fsPath).replace(/\\/g, '/');
    } else {
        let matched = false;
        for (const project of projectRoots) {
            if (isWithinRoot(project.fsPath, fsPath)) {
                const projectRomfs = resolveProjectRomfsMount(project.fsPath, romfsPath || project.fsPath);
                if (isWithinRoot(projectRomfs, fsPath)) {
                    relativePath = path.relative(projectRomfs, fsPath).replace(/\\/g, '/');
                    matched = true;
                    break;
                }
            }
        }
        if (!matched) {
            relativePath = fileName;
        }
    }

    let isProjectSpecific = false;
    if (uri.scheme !== 'totk-dump') {
        const scopePick = await vscode.window.showQuickPick(
            [
                { label: 'Global Rules', description: 'Applies to all workspaces/projects (Global Settings)' },
                { label: 'Project-Specific Rules', description: 'Applies to this specific project (writes to .tkvsc)' }
            ],
            {
                placeHolder: 'Select target rule scope',
                title: 'Blacklist (Filter Rules)'
            }
        );

        if (!scopePick) {
            return;
        }
        isProjectSpecific = scopePick.label === 'Project-Specific Rules';
    }

    const typePick = await vscode.window.showQuickPick(
        [
            { label: 'Specific File', description: `Exclude just this file (${fileName})` },
            { label: 'Part of the File Extension', description: 'Pick a compound/nested extension suffix' },
            { label: 'Folder Prefix / Path', description: 'Exclude everything under a specific folder path' }
        ],
        {
            placeHolder: 'What would you like to blacklist?',
            title: 'Add Exclude Rule'
        }
    );

    if (!typePick) {
        return;
    }

    let ruleValue = '';
    let configSetting: 'canonicalSyncFileExtensionBlacklist' | 'canonicalSyncBlacklistPrefixes';

    if (typePick.label === 'Specific File') {
        ruleValue = fileName;
        configSetting = 'canonicalSyncFileExtensionBlacklist';
    } else if (typePick.label === 'Part of the File Extension') {
        const variations = getExtensionVariations(fileName);
        if (variations.length === 0) {
            void vscode.window.showWarningMessage('This file does not have any extension variations to pick from.');
            return;
        }
        const varPick = await vscode.window.showQuickPick(
            variations.map(v => ({ label: v })),
            {
                placeHolder: 'Select the file extension suffix variation',
                title: 'Excluding Extension Suffix'
            }
        );
        if (!varPick) {
            return;
        }
        ruleValue = varPick.label;
        configSetting = 'canonicalSyncFileExtensionBlacklist';
    } else {
        const prefixes = getFolderPrefixes(relativePath);
        if (prefixes.length === 0) {
            void vscode.window.showWarningMessage('This file is at the root and has no parent folders.');
            return;
        }
        const prefixPick = await vscode.window.showQuickPick(
            prefixes.map(p => ({ label: p })),
            {
                placeHolder: 'Select the folder prefix to blacklist',
                title: 'Excluding Folder Prefix'
            }
        );
        if (!prefixPick) {
            return;
        }
        ruleValue = prefixPick.label;
        configSetting = 'canonicalSyncBlacklistPrefixes';
    }

    let targetProjectPath: string | undefined;
    if (isProjectSpecific) {
        const containingProject = projectRoots.find(p => isWithinRoot(p.fsPath, fsPath));
        if (containingProject) {
            targetProjectPath = containingProject.fsPath;
        } else {
            if (projectRoots.length === 0) {
                void vscode.window.showWarningMessage('No open projects. Add a project to TOTK Archives first.');
                return;
            }
            if (projectRoots.length === 1) {
                targetProjectPath = projectRoots[0]!.fsPath;
            } else {
                const projPick = await vscode.window.showQuickPick(
                    projectRoots.map(p => ({ label: p.label, description: p.fsPath, project: p })),
                    {
                        placeHolder: 'Which project does this rule apply to?',
                        title: 'Select Project'
                    }
                );
                if (!projPick) {
                    return;
                }
                targetProjectPath = projPick.project.fsPath;
            }
        }
    }

    if (isProjectSpecific && targetProjectPath) {
        await updateTkvscConfigArray(targetProjectPath, configSetting, ruleValue);
    } else {
        await updateGlobalConfigArray(configSetting, (current) => {
            if (current.includes(ruleValue)) {
                void vscode.window.showInformationMessage(`Rule '${ruleValue}' is already in the global blacklist.`);
                return current;
            }
            void vscode.window.showInformationMessage(`Successfully added global exclusion: '${ruleValue}'`);
            return [...current, ruleValue];
        });
    }
}

function getExtensionVariations(fileName: string): string[] {
    const parts = fileName.split('.');
    if (parts.length <= 1) {
        return [];
    }
    const variations: string[] = [];
    for (let i = parts.length - 1; i >= 1; i--) {
        variations.push('.' + parts.slice(i).join('.'));
    }
    return variations;
}

function getFolderPrefixes(relativePath: string): string[] {
    const dir = path.dirname(relativePath).replace(/\\/g, '/');
    if (dir === '.' || !dir) {
        return [];
    }
    const segments = dir.split('/');
    const prefixes: string[] = [];
    let current = '';
    for (const segment of segments) {
        if (current) {
            current = `${current}/${segment}`;
        } else {
            current = segment;
        }
        prefixes.push(current);
    }
    return prefixes;
}

async function updateTkvscConfigArray(
    projectPath: string,
    settingName: 'canonicalSyncBlacklistPrefixes' | 'canonicalSyncFileExtensionBlacklist',
    ruleValue: string
): Promise<void> {
    const configPath = path.join(projectPath, '.tkvsc');
    let config: TkvscConfig = {};
    try {
        if (fs.existsSync(configPath)) {
            const raw = fs.readFileSync(configPath, 'utf8');
            config = JSON.parse(raw) as TkvscConfig;
        }
    } catch (e) {
        logger.error('Failed to parse existing .tkvsc:', e as Error);
    }

    if (!config.canonicalSyncBlacklistPrefixes) {
        config.canonicalSyncBlacklistPrefixes = [];
    }
    if (!config.canonicalSyncFileExtensionBlacklist) {
        config.canonicalSyncFileExtensionBlacklist = [];
    }

    const targetArray = config[settingName]!;
    if (targetArray.includes(ruleValue)) {
        void vscode.window.showInformationMessage(`Rule '${ruleValue}' is already in this project's blacklist.`);
        return;
    }

    targetArray.push(ruleValue);

    // Write back
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
    void vscode.window.showInformationMessage(`Successfully added project exclusion: '${ruleValue}' to .tkvsc`);
}

async function updateGlobalConfigArray(
    settingName: string,
    updater: (current: string[]) => string[]
): Promise<void> {
    const config = vscode.workspace.getConfiguration('TKVSC');
    const inspection = config.inspect<string[]>(settingName);
    const currentList = inspection?.globalValue ?? inspection?.defaultValue ?? [];
    const updatedList = updater(currentList);
    await config.update(settingName, updatedList, vscode.ConfigurationTarget.Global);
}
