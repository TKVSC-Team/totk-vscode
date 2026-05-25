import type { NodeRoleColor } from './types';
import * as vscode from 'vscode';
import { AinbNodeFormatAdapter } from './ainbAdapter';
import type { NodeFormatAdapter } from './types';

type AinbDef = {
    tags: string[];
    eventColor?: NodeRoleColor;
};

export class NodeEditorAdapterRegistry {
    private readonly adapters: NodeFormatAdapter[];

    constructor(
        extensionPath: string,
        getRuntimeAinbDefs?: () => Map<string, AinbDef> | undefined,
    ) {
        this.adapters = [new AinbNodeFormatAdapter(extensionPath, getRuntimeAinbDefs)];
    }

    getForUri(uri: vscode.Uri): NodeFormatAdapter | undefined {
        return this.adapters.find((adapter) => adapter.supports(uri.fsPath));
    }
}
