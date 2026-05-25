export type NodeRoleColor =
    | 'blue'
    | 'red'
    | 'green'
    | 'brown'
    | 'purple'
    | 'gray'
    | 'notimplemented';

export type NodeEditorPin = {
    id: string;
    label: string;
    linked: boolean;
};

export type NodeEditorNode = {
    id: string;
    label: string;
    typeLabel: string;
    x: number;
    y: number;
    tags: string[];
    roleColor: NodeRoleColor;
    inputPins: NodeEditorPin[];
    outputPins: NodeEditorPin[];
    sections: Array<{
        title: string;
        entries: string[];
    }>;
};

export type NodeEditorEdge = {
    id: string;
    source: string;
    target: string;
    label: string;
    sourceHandle?: string;
    targetHandle?: string;
};

export type NodeEditorModel = {
    formatId: string;
    fileName: string;
    nodes: NodeEditorNode[];
    edges: NodeEditorEdge[];
};

export type AdapterParseResult = {
    model: NodeEditorModel;
    originalText: string;
};

export interface NodeFormatAdapter {
    readonly id: string;
    supports(filePath: string): boolean;
    parse(filePath: string, rawText: string): AdapterParseResult;
    serializeNoop(result: AdapterParseResult): string;
}
