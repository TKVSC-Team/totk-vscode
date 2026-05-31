import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { normalizePath } from './projectPaths';

const ACTIVE_OPTIONS_KEY = 'totk-editor.activeTkmmOptions';

export interface TkmmOptionRef {
    group: string;
    option: string;
}

export function getActiveTkmmOption(context: vscode.ExtensionContext, projectRoot: string): TkmmOptionRef | undefined {
    const activeOptions = context.workspaceState.get<Record<string, TkmmOptionRef>>(ACTIVE_OPTIONS_KEY, {});
    return activeOptions[normalizePath(projectRoot)];
}

export async function setActiveTkmmOption(
    context: vscode.ExtensionContext,
    projectRoot: string,
    group?: string,
    option?: string
): Promise<void> {
    const activeOptions = { ...context.workspaceState.get<Record<string, TkmmOptionRef>>(ACTIVE_OPTIONS_KEY, {}) };
    const key = normalizePath(projectRoot);
    
    if (group && option) {
        activeOptions[key] = { group, option };
    } else {
        delete activeOptions[key];
    }
    
    await context.workspaceState.update(ACTIVE_OPTIONS_KEY, activeOptions);
}

export async function listTkmmOptionGroups(projectRoot: string): Promise<string[]> {
    const optionsDir = path.join(projectRoot, 'options');
    if (!fs.existsSync(optionsDir)) {
        return [];
    }
    
    try {
        const entries = await fs.promises.readdir(optionsDir, { withFileTypes: true });
        return entries
            .filter(entry => entry.isDirectory())
            .map(entry => entry.name);
    } catch {
        return [];
    }
}

export async function listTkmmOptions(projectRoot: string, group: string): Promise<string[]> {
    const groupDir = path.join(projectRoot, 'options', group);
    if (!fs.existsSync(groupDir)) {
        return [];
    }
    
    try {
        const entries = await fs.promises.readdir(groupDir, { withFileTypes: true });
        return entries
            .filter(entry => entry.isDirectory())
            .map(entry => entry.name);
    } catch {
        return [];
    }
}

export async function createTkmmOptionGroup(projectRoot: string, groupName: string): Promise<string> {
    const groupDir = path.join(projectRoot, 'options', groupName);
    await fs.promises.mkdir(groupDir, { recursive: true });
    
    // Create info.json for the option group
    const infoJsonPath = path.join(groupDir, 'info.json');
    if (!fs.existsSync(infoJsonPath)) {
        await fs.promises.writeFile(infoJsonPath, JSON.stringify({
            Dependencies: [],
            Type: 0,
            IconName: null,
            Priority: -1,
            IsEditing: false,
            Name: groupName,
            Description: "",
            Thumbnail: null
        }));
    }
    
    return groupDir;
}

export async function createTkmmOption(projectRoot: string, groupName: string, optionName: string): Promise<string> {
    const optionDir = path.join(projectRoot, 'options', groupName, optionName);
    await fs.promises.mkdir(optionDir, { recursive: true });
    
    const romfsDir = path.join(optionDir, 'romfs');
    await fs.promises.mkdir(romfsDir, { recursive: true });
    
    // Create info.json for the option
    const infoJsonPath = path.join(optionDir, 'info.json');
    if (!fs.existsSync(infoJsonPath)) {
        await fs.promises.writeFile(infoJsonPath, JSON.stringify({
            Dependencies: [],
            Type: 0,
            IconName: null,
            Priority: -1,
            IsEditing: false,
            Name: optionName,
            Description: "",
            Thumbnail: null
        }));
    }
    
    return optionDir;
}

export async function askForTkmmOption(projectRoot: string): Promise<TkmmOptionRef | 'BASE_PROJECT' | 'BACK' | undefined> {
    while (true) {
        const groups = await listTkmmOptionGroups(projectRoot);
        const groupItems: vscode.QuickPickItem[] = [
            { label: '$(folder) Base Project', description: 'Add to the root project romfs' },
            ...groups.map(g => ({ label: `$(folder) ${g}` })),
            { label: '$(add) Create New Option Group...' },
            { label: '$(arrow-left) Back' }
        ];

        const pickedGroup = await vscode.window.showQuickPick(groupItems, {
            title: 'Select Option Group',
            placeHolder: 'Choose an option group, Base Project, or create a new one'
        });

        if (!pickedGroup) {return undefined;}

        if (pickedGroup.label === '$(arrow-left) Back') {
            return 'BACK';
        }

        if (pickedGroup.label === '$(folder) Base Project') {
            return 'BASE_PROJECT';
        }

        let selectedGroupName = pickedGroup.label.replace('$(folder) ', '');
        if (pickedGroup.label === '$(add) Create New Option Group...') {
            const newName = await vscode.window.showInputBox({ prompt: 'Enter new Option Group name' });
            if (!newName) {continue;}
            await createTkmmOptionGroup(projectRoot, newName);
            selectedGroupName = newName;
        }

        while (true) {
            const options = await listTkmmOptions(projectRoot, selectedGroupName);
            const optionItems: vscode.QuickPickItem[] = [
                { label: '$(arrow-left) Back to Option Groups' },
                ...options.map(o => ({ label: `$(folder) ${o}` })),
                { label: '$(add) Create New Option...' }
            ];

            const pickedOption = await vscode.window.showQuickPick(optionItems, {
                title: `Select Option in '${selectedGroupName}'`,
                placeHolder: 'Choose an option or create a new one'
            });

            if (!pickedOption) {return undefined;}

            if (pickedOption.label === '$(arrow-left) Back to Option Groups') {
                break; // Break inner loop, goes back to group selection
            }

            let selectedOptionName = pickedOption.label.replace('$(folder) ', '');
            if (pickedOption.label === '$(add) Create New Option...') {
                const newName = await vscode.window.showInputBox({ prompt: `Enter new Option name for '${selectedGroupName}'` });
                if (!newName) {continue;}
                await createTkmmOption(projectRoot, selectedGroupName, newName);
                selectedOptionName = newName;
            }

            return { group: selectedGroupName, option: selectedOptionName };
        }
    }
}
