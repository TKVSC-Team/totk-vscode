import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
    findRomfsFolderUnder,
    normalizePath,
    resolveAddToCopyPaths,
    resolveProjectDestination,
} from './projectPaths';
import { resolveRomfsPath } from './romfs';

export interface ProjectRoot {
    fsPath: string;
    label: string;
}

async function ensureParentDirectory(filePath: string): Promise<void> {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
}

async function confirmOverwrite(destination: string): Promise<boolean> {
    if (!fs.existsSync(destination)) {
        return true;
    }

    const choice = await vscode.window.showWarningMessage(
        `Overwrite existing file?\n${destination}`,
        { modal: true },
        'Overwrite',
    );
    return choice === 'Overwrite';
}

export function resolveRomfsForProject(projectRoot: string): string {
    const configured = resolveRomfsPath();
    if (configured) {
        return normalizePath(configured);
    }
    const underProject = findRomfsFolderUnder(normalizePath(projectRoot));
    return underProject ?? normalizePath(projectRoot);
}

export async function addDumpEntryToProject(
    sourceFsPath: string,
    projectRoot: string,
    romfsRoot?: string,
    options?: { suppressSuccessMessage?: boolean },
    tkmmOption?: { group: string; option: string },
): Promise<boolean> {
    const dumpRoot = romfsRoot?.trim()
        ? normalizePath(romfsRoot)
        : resolveRomfsPath() || resolveRomfsForProject(projectRoot);
    if (!dumpRoot) {
        void vscode.window.showErrorMessage(
            'TKVSC: Set **totk-editor.romfsPath** to your game dump folder first.',
        );
        return false;
    }

    let copyPaths: { source: string; destination: string };
    try {
        copyPaths = resolveAddToCopyPaths(sourceFsPath, projectRoot, dumpRoot, tkmmOption);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(`Add to project: ${message}`);
        return false;
    }

    if (!(await confirmOverwrite(copyPaths.destination))) {
        return false;
    }

    try {
        await ensureParentDirectory(copyPaths.destination);
        await fs.promises.copyFile(copyPaths.source, copyPaths.destination);
        try {
            await fs.promises.chmod(copyPaths.destination, 0o666);
        } catch (e) {
            // Ignore chmod errors
        }
        if (!options?.suppressSuccessMessage) {
            void vscode.window.showInformationMessage(
                `Added to project: ${path.relative(normalizePath(projectRoot), copyPaths.destination)}`,
            );
        }
        return true;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(`Add to project failed: ${message}`);
        return false;
    }
}

export async function pickProjectRoot(projects: ProjectRoot[]): Promise<string | undefined> {
    if (projects.length === 0) {
        void vscode.window.showWarningMessage(
            'No archive projects open. Add a project in **TOTK Archives** first.',
        );
        return undefined;
    }

    if (projects.length === 1) {
        return projects[0]!.fsPath;
    }

    const pick = await vscode.window.showQuickPick(
        projects.map((project) => ({
            label: project.label,
            description: project.fsPath,
            fsPath: project.fsPath,
        })),
        {
            placeHolder: 'Choose an archive project',
            title: 'Add to Project',
        },
    );

    return pick?.fsPath;
}

export { resolveProjectDestination, resolveAddToCopyPaths };
