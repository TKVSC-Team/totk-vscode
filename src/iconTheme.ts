import * as vscode from 'vscode';

const TOTK_ICON_THEME_ID = 'totk-icons';
const PREVIOUS_ICON_THEME_KEY = 'totk.previousIconTheme';

export async function migrateOffStandaloneIconTheme(
    context: vscode.ExtensionContext,
): Promise<void> {
    const workbench = vscode.workspace.getConfiguration('workbench');
    const current = workbench.get<string>('iconTheme');
    if (current !== TOTK_ICON_THEME_ID) {
        return;
    }

    const previous = context.globalState.get<string>(PREVIOUS_ICON_THEME_KEY);
    await workbench.update('iconTheme', previous ?? null, true);
    void vscode.window.showInformationMessage(
        'TKVSC: Switched you off the partial TOTK icon theme. Pick your preferred File Icon Theme again - TOTK file icons still apply via language icons.',
    );
}

export function registerIconThemeCommands(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.commands.registerCommand('totk-editor.useTotkIcons', async () => {
            const choice = await vscode.window.showInformationMessage(
                'TOTK file icons are applied via language icons on top of your current File Icon Theme. Do not select "TOTK File Icons" as your main theme, this will override all installed icons.',
                'Open File Icon Theme Picker',
            );
            if (choice === 'Open File Icon Theme Picker') {
                await vscode.commands.executeCommand('workbench.action.selectIconTheme');
            }
        }),
    );
}
