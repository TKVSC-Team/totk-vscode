import * as fs from 'fs';
import * as path from 'path';
import type {
    AdapterParseResult,
    NodeEditorEdge,
    NodeEditorModel,
    NodeEditorNode,
    NodeEditorPin,
    NodeFormatAdapter,
    NodeRoleColor,
} from './types';

type AinbPlug = {
    'Node Index'?: number;
    Name?: string;
};

type AinbNode = {
    'Node Index'?: number;
    Name?: string;
    'Node Type'?: string;
    GUID?: string;
    Flags?: string[];
    Queries?: unknown[];
    Attachments?: unknown[];
    Properties?: Record<string, unknown>;
    Parameters?: Record<string, unknown>;
    'XLink Actions'?: unknown[];
    Plugs?: Record<string, AinbPlug[]>;
};

type AinbCommand = {
    Name?: string;
    GUID?: string;
    'Root Node Index'?: number;
    'Secondary Root Node Index'?: number;
};

type AinbJson = {
    Filename?: string;
    Commands?: AinbCommand[];
    Nodes?: AinbNode[];
};

type AinbDef = {
    tags: string[];
    eventColor?: NodeRoleColor;
};

type TypedParameterEntry = {
    valueType: string;
    name: string;
    raw: unknown;
};

const FLOW_IN_HANDLE_ID = 'flow-in';

function sanitizeHandlePart(raw: string): string {
    return raw.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'unnamed';
}

function formatParamType(valueType: string): string {
    const normalized = valueType.trim();
    if (!normalized) {
        return 'Unknown';
    }
    return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function makeFlowOutHandleId(plugType: string, plugName: string): string {
    return `out-flow-${sanitizeHandlePart(plugType)}-${sanitizeHandlePart(plugName || 'default')}`;
}

function makeParamHandleId(direction: 'in' | 'out', valueType: string, paramName: string): string {
    return `${direction}-param-${sanitizeHandlePart(valueType)}-${sanitizeHandlePart(paramName)}`;
}

function collectTypedParameterEntries(
    node: AinbNode,
    directionPattern: RegExp,
): TypedParameterEntry[] {
    const entries: TypedParameterEntry[] = [];
    const parameters = node.Parameters ?? {};
    for (const [direction, typedValues] of Object.entries(parameters)) {
        if (!directionPattern.test(direction) || !typedValues || typeof typedValues !== 'object') {
            continue;
        }
        for (const [valueType, values] of Object.entries(typedValues as Record<string, unknown>)) {
            const add = (name: string, raw: unknown) => {
                entries.push({ valueType, name: name.trim() || '(unnamed)', raw });
            };
            if (Array.isArray(values)) {
                for (let i = 0; i < values.length; i++) {
                    const item = values[i];
                    if (item && typeof item === 'object') {
                        const obj = item as Record<string, unknown>;
                        add(typeof obj.Name === 'string' ? obj.Name : String(i), obj);
                    } else {
                        add(String(i), item);
                    }
                }
                continue;
            }
            if (!values || typeof values !== 'object') {
                add(valueType, values);
                continue;
            }
            const valueObject = values as Record<string, unknown>;
            const objectValues = Object.values(valueObject);
            const looksLikeArrayCollection =
                objectValues.length > 0 && objectValues.every((candidate) => Array.isArray(candidate));
            if (looksLikeArrayCollection) {
                for (const nested of objectValues as unknown[][]) {
                    for (let i = 0; i < nested.length; i++) {
                        const item = nested[i];
                        if (item && typeof item === 'object') {
                            const obj = item as Record<string, unknown>;
                            add(typeof obj.Name === 'string' ? obj.Name : String(i), obj);
                        } else {
                            add(String(i), item);
                        }
                    }
                }
                continue;
            }
            for (const [paramName, rawValue] of Object.entries(valueObject)) {
                if (Array.isArray(rawValue)) {
                    for (let i = 0; i < rawValue.length; i++) {
                        const item = rawValue[i];
                        if (item && typeof item === 'object') {
                            const obj = item as Record<string, unknown>;
                            add(typeof obj.Name === 'string' ? obj.Name : `${paramName}_${i}`, obj);
                        } else {
                            add(`${paramName}_${i}`, item);
                        }
                    }
                } else {
                    add(paramName, rawValue);
                }
            }
        }
    }
    return entries;
}

function parseEventColorTag(tags: string[]): NodeRoleColor | undefined {
    const match = tags
        .map((tag) => tag.match(/^EventColor_([A-Za-z]+)$/))
        .find((value) => Boolean(value));
    const raw = match?.[1]?.toLowerCase();
    switch (raw) {
        case 'blue':
        case 'red':
        case 'green':
        case 'brown':
        case 'purple':
        case 'gray':
            return raw;
        case 'notimplemented':
            return 'notimplemented';
        default:
            return undefined;
    }
}

function parseAinbDefs(defText: string): Map<string, AinbDef> {
    const defs = new Map<string, AinbDef>();
    let currentName: string | undefined;

    for (const line of defText.split(/\r?\n/)) {
        const top = line.match(/^([A-Za-z0-9_.-]+):\s*$/);
        if (top) {
            currentName = top[1]!;
            if (!defs.has(currentName)) {
                defs.set(currentName, { tags: [], eventColor: undefined });
            }
            continue;
        }
        if (!currentName) {
            continue;
        }
        const tagLine = line.match(/^\s{2}Tags:\s*\[(.*)\]\s*$/);
        if (tagLine) {
            const tags = tagLine[1]!
                .split(',')
                .map((tag) => tag.trim())
                .filter(Boolean);
            defs.set(currentName, {
                tags,
                eventColor: parseEventColorTag(tags),
            });
        }
    }

    return defs;
}

function computeDepthByNode(
    nodes: AinbNode[],
    edges: NodeEditorEdge[],
): Map<string, number> {
    const nodeIds = nodes.map((node, index) =>
        String(typeof node['Node Index'] === 'number' ? node['Node Index'] : index),
    );
    const indegree = new Map<string, number>();
    const outgoing = new Map<string, string[]>();
    for (const id of nodeIds) {
        indegree.set(id, 0);
        outgoing.set(id, []);
    }

    for (const edge of edges) {
        if (!indegree.has(edge.source) || !indegree.has(edge.target)) {
            continue;
        }
        indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
        outgoing.get(edge.source)!.push(edge.target);
    }

    const depth = new Map<string, number>();
    const queue: string[] = [];
    for (const [id, value] of indegree.entries()) {
        if (value === 0) {
            queue.push(id);
            depth.set(id, 0);
        }
    }

    // Handles DAG-like graphs well; cycles fall back to depth 0 / relaxed propagation.
    while (queue.length > 0) {
        const current = queue.shift()!;
        const currentDepth = depth.get(current) ?? 0;
        for (const target of outgoing.get(current) ?? []) {
            const nextDepth = Math.max(depth.get(target) ?? 0, currentDepth + 1);
            depth.set(target, nextDepth);
            indegree.set(target, (indegree.get(target) ?? 1) - 1);
            if ((indegree.get(target) ?? 0) <= 0) {
                queue.push(target);
            }
        }
    }

    return depth;
}

function buildNodes(
    nodes: AinbNode[],
    defs: Map<string, AinbDef>,
    edges: NodeEditorEdge[],
): NodeEditorNode[] {
    const STARLIGHT_RED_NODE_TYPES = new Set([
        'Element_SplitTiming',
        'Element_Simultaneous',
        'Element_Sequential',
        'Element_BoolSelector',
        'Element_S32Selector',
        'Element_F32Selector',
    ]);

    const depthMap = computeDepthByNode(nodes, edges);
    const incomingFlowCount = new Map<string, number>();
    for (const edge of edges) {
        incomingFlowCount.set(edge.target, (incomingFlowCount.get(edge.target) ?? 0) + 1);
    }
    const nodesByDepth = new Map<number, string[]>();
    const nodeDepth = new Map<string, number>();

    for (let index = 0; index < nodes.length; index++) {
        const nodeIndex = typeof nodes[index]!['Node Index'] === 'number' ? nodes[index]!['Node Index'] : index;
        const id = String(nodeIndex);
        const depth = depthMap.get(id) ?? 0;
        nodeDepth.set(id, depth);
        if (!nodesByDepth.has(depth)) {
            nodesByDepth.set(depth, []);
        }
        nodesByDepth.get(depth)!.push(id);
    }

    for (const ids of nodesByDepth.values()) {
        ids.sort((a, b) => Number(a) - Number(b));
    }

    const precomputed = new Map<string, {
        nodeType: string;
        nodeName: string;
        tags: string[];
        inputPins: NodeEditorPin[];
        outputPins: NodeEditorPin[];
        sections: Array<{ title: string; entries: string[] }>;
        roleColor: NodeRoleColor;
    }>();

    const estimateNodeHeight = (
        sections: Array<{ title: string; entries: string[] }>,
        inputPins: NodeEditorPin[],
        outputPins: NodeEditorPin[],
    ): number => {
        // Header + per-section title + visible entries (viewer truncates to 10)
        let height = 96;
        const pinRows = Math.max(inputPins.length, outputPins.length);
        if (pinRows > 0) {
            height += 8; // top gap
            height += pinRows * 20; // row height
            height += 6; // bottom gap
        }
        for (const section of sections) {
            const visibleEntries = Math.min(section.entries.length, 10);
            height += 18; // section title + spacing
            height += visibleEntries * 14;
            if (section.entries.length > 10) {
                height += 14;
            }
            height += 6;
        }
        return height;
    };

    for (let index = 0; index < nodes.length; index++) {
        const node = nodes[index]!;
        const nodeIndex = typeof node['Node Index'] === 'number' ? node['Node Index'] : index;
        const nodeType = node['Node Type'] ?? 'Unknown';
        const nodeName = node.Name?.trim() || nodeType;
        const def = defs.get(nodeName) ?? defs.get(nodeType);
        const tags = def?.tags ?? [];
        const id = String(nodeIndex);
        const depth = depthMap.get(id) ?? 0;
        const lane = nodesByDepth.get(depth)?.indexOf(id) ?? 0;

        const sections: Array<{ title: string; entries: string[] }> = [];
        const addSection = (title: string, entries: string[]) => {
            if (entries.length > 0) {
                sections.push({ title, entries });
            }
        };

        const stringify = (value: unknown): string => {
            if (typeof value === 'string') {
                return value;
            }
            if (typeof value === 'number' || typeof value === 'boolean') {
                return String(value);
            }
            if (value === null || value === undefined) {
                return String(value);
            }
            try {
                return JSON.stringify(value);
            } catch {
                return String(value);
            }
        };

        const pickInlineValue = (rawValue: unknown): string | undefined => {
            if (
                typeof rawValue === 'string' ||
                typeof rawValue === 'number' ||
                typeof rawValue === 'boolean' ||
                rawValue === null
            ) {
                return stringify(rawValue);
            }
            if (!rawValue || typeof rawValue !== 'object') {
                return undefined;
            }
            const obj = rawValue as Record<string, unknown>;
            for (const key of ['Value', 'Default Value', 'Immediate Value']) {
                if (key in obj) {
                    return stringify(obj[key]);
                }
            }
            return undefined;
        };

        const isConnectedParam = (rawValue: unknown): boolean => {
            if (!rawValue || typeof rawValue !== 'object') {
                return false;
            }
            const obj = rawValue as Record<string, unknown>;
            const nodeIndex = obj['Node Index'];
            if (typeof nodeIndex === 'number' && nodeIndex >= 0) {
                return true;
            }
            const sources = obj.Sources;
            if (Array.isArray(sources) && sources.length > 0) {
                return true;
            }
            return false;
        };

        addSection(
            'Metadata',
            [
                node.GUID ? `GUID: ${node.GUID}` : '',
                node.Flags?.length ? `Flags: ${node.Flags.join(', ')}` : '',
                `Queries: ${(node.Queries ?? []).length}`,
                `Attachments: ${(node.Attachments ?? []).length}`,
                `XLink Actions: ${(node['XLink Actions'] ?? []).length}`,
            ].filter(Boolean),
        );

        const propertyEntries: string[] = [];
        for (const [propType, rawItems] of Object.entries(node.Properties ?? {})) {
            if (!Array.isArray(rawItems)) {
                propertyEntries.push(`${propType}: ${stringify(rawItems)}`);
                continue;
            }
            for (const rawItem of rawItems) {
                if (!rawItem || typeof rawItem !== 'object') {
                    propertyEntries.push(`${propType}: ${stringify(rawItem)}`);
                    continue;
                }
                const item = rawItem as Record<string, unknown>;
                const name = typeof item.Name === 'string' ? item.Name : '(unnamed)';
                const defaultValue =
                    'Default Value' in item ? stringify(item['Default Value']) : '(none)';
                propertyEntries.push(`${propType}.${name} = ${defaultValue}`);
            }
        }
        addSection('Properties', propertyEntries);

        const inputPins: NodeEditorPin[] = [];
        const outputPins: NodeEditorPin[] = [];
        const outputPinIds = new Set<string>();

        if ((incomingFlowCount.get(id) ?? 0) > 0) {
            inputPins.push({
                id: FLOW_IN_HANDLE_ID,
                label: 'Flow In',
                linked: true,
            });
        }

        const inputParameterEntries: string[] = [];
        const outputParameterEntries: string[] = [];
        const flowOutputPins: NodeEditorPin[] = [];
        const flowOutputPinIds = new Set<string>();
        const inputParamEntries = collectTypedParameterEntries(node, /input/i);
        const outputParamEntries = collectTypedParameterEntries(node, /output/i);

        for (const entry of inputParamEntries) {
            const connected = isConnectedParam(entry.raw);
            const value = pickInlineValue(entry.raw);
            inputParameterEntries.push(
                connected
                    ? `${entry.name} (${formatParamType(entry.valueType)}) [linked]`
                    : value !== undefined
                        ? `${entry.name} (${formatParamType(entry.valueType)}) = ${value}`
                        : `${entry.name} (${formatParamType(entry.valueType)})`,
            );
            inputPins.push({
                id: makeParamHandleId('in', entry.valueType, entry.name),
                label:
                    value !== undefined && !connected
                        ? `${entry.name} (${formatParamType(entry.valueType)}) = ${value}`
                        : `${entry.name} (${formatParamType(entry.valueType)})`,
                linked: connected,
            });
        }

        for (const entry of outputParamEntries) {
            const connected = isConnectedParam(entry.raw);
            outputParameterEntries.push(`${entry.name} (${formatParamType(entry.valueType)})`);
            const pinId = makeParamHandleId('out', entry.valueType, entry.name);
            if (!outputPinIds.has(pinId)) {
                outputPins.push({
                    id: pinId,
                    label: `${entry.name} (${formatParamType(entry.valueType)})`,
                    linked: connected,
                });
                outputPinIds.add(pinId);
            }
        }
        if (inputParameterEntries.length > 0) {
            addSection('Input Parameters', inputParameterEntries);
        }
        if (outputParameterEntries.length > 0) {
            addSection('Output Parameters', outputParameterEntries);
        }

        for (const [plugType, links] of Object.entries(node.Plugs ?? {})) {
            // Generic plugs are data-input references, not flow outputs — skip.
            if (plugType === 'Generic') {
                continue;
            }
            for (const link of links) {
                const flowName = (link.Name?.trim() || plugType).trim();
                const pinId = makeFlowOutHandleId(plugType, flowName);
                if (!flowOutputPinIds.has(pinId)) {
                    flowOutputPins.push({
                        id: pinId,
                        label: flowName ? `${flowName} (Flow)` : `${plugType} (Flow)`,
                        linked: true,
                    });
                    flowOutputPinIds.add(pinId);
                }
            }
        }
        const nonGenericPlugCount = Object.entries(node.Plugs ?? {})
            .filter(([pt]) => pt !== 'Generic')
            .reduce((sum, [, links]) => sum + links.length, 0);
        if (flowOutputPins.length === 0 && nonGenericPlugCount > 0) {
            flowOutputPins.push({
                id: makeFlowOutHandleId('flow', 'default'),
                label: 'Flow Out',
                linked: true,
            });
        }
        outputPins.unshift(...flowOutputPins);

        // Mirror Starlight-Dev behavior:
        // - Module nodes are green.
        // - Specific built-in Element_* nodes are red.
        // - All other/default nodes are blue.
        const isModuleNode =
            (node.Flags ?? []).some((flag) => /module/i.test(flag)) ||
            /\.module/i.test(nodeName) ||
            tags.some((tag) => /module/i.test(tag));
        const isStarlightRedNode =
            STARLIGHT_RED_NODE_TYPES.has(nodeType) ||
            /^Element_(?:.*Selector|Sequential|Simultaneous|SplitTiming)$/i.test(nodeType);
        const roleColor: NodeRoleColor = isModuleNode
            ? 'green'
            : isStarlightRedNode
                ? 'red'
                : 'blue';

        precomputed.set(id, {
            nodeType,
            nodeName,
            tags,
            inputPins,
            outputPins,
            sections,
            roleColor,
        });
    }

    const yById = new Map<string, number>();
    const xById = new Map<string, number>();
    const columnGap = 520;
    const rowGap = 34;
    const sortedDepths = [...nodesByDepth.keys()].sort((a, b) => a - b);
    for (const depth of sortedDepths) {
        const ids = nodesByDepth.get(depth) ?? [];
        let y = 0;
        for (const id of ids) {
            const data = precomputed.get(id);
            const height = estimateNodeHeight(
                data?.sections ?? [],
                data?.inputPins ?? [],
                data?.outputPins ?? [],
            );
            xById.set(id, depth * columnGap);
            yById.set(id, y);
            y += height + rowGap;
        }
    }

    return nodes.map((node, index) => {
        const nodeIndex = typeof node['Node Index'] === 'number' ? node['Node Index'] : index;
        const id = String(nodeIndex);
        const computed = precomputed.get(id);
        const depth = nodeDepth.get(id) ?? 0;
        const lane = nodesByDepth.get(depth)?.indexOf(id) ?? 0;
        return {
            id,
            label: computed?.nodeName ?? `(Node ${id})`,
            typeLabel: computed?.nodeType ?? 'Unknown',
            x: xById.get(id) ?? depth * columnGap,
            y: yById.get(id) ?? lane * 240,
            tags: computed?.tags ?? [],
            roleColor: computed?.roleColor ?? 'blue',
            inputPins: computed?.inputPins ?? [],
            outputPins: computed?.outputPins ?? [],
            sections: computed?.sections ?? [],
        };
    });
}

function buildEdges(nodes: AinbNode[]): NodeEditorEdge[] {
    const edges: NodeEditorEdge[] = [];
    const outputParamIndexMap = new Map<string, Map<string, string>>();

    for (let nodeIdx = 0; nodeIdx < nodes.length; nodeIdx++) {
        const node = nodes[nodeIdx]!;
        const nodeId = String(typeof node['Node Index'] === 'number' ? node['Node Index'] : nodeIdx);
        const map = new Map<string, string>();
        const outputEntries = collectTypedParameterEntries(node, /output/i);
        const typeCounters = new Map<string, number>();
        for (const entry of outputEntries) {
            const typeKey = sanitizeHandlePart(entry.valueType);
            const i = typeCounters.get(typeKey) ?? 0;
            map.set(`${typeKey}:${i}`, entry.name);
            typeCounters.set(typeKey, i + 1);
        }
        outputParamIndexMap.set(nodeId, map);
    }

    for (const node of nodes) {
        const sourceId = String(node['Node Index'] ?? '');
        if (!sourceId) {
            continue;
        }
        const plugs = node.Plugs ?? {};
        for (const [plugType, links] of Object.entries(plugs)) {
            // Generic plugs are backwards data-input references (used by BoolSelector,
            // F32Selector, Expression). They are not flow-control outputs — handle them
            // separately below.
            if (plugType === 'Generic') {
                continue;
            }
            for (let i = 0; i < links.length; i++) {
                const link = links[i]!;
                const targetIndex = link['Node Index'];
                if (typeof targetIndex !== 'number') {
                    continue;
                }
                const targetId = String(targetIndex);
                const plugName = link.Name?.trim() ?? '';
                const flowName = plugName || plugType;
                edges.push({
                    id: `${sourceId}-${targetId}-${plugType}-${i}`,
                    source: sourceId,
                    target: targetId,
                    label: plugName ? `${plugType}: ${plugName}` : plugType,
                    sourceHandle: makeFlowOutHandleId(plugType, flowName),
                    targetHandle: FLOW_IN_HANDLE_ID,
                });
            }
        }

        // Generic plugs: each one is a backwards pointer from this node to the upstream
        // node whose output provides this node's condition/input value.
        // Edge direction: upstream source node -> this node (consumer).
        const genericLinks = (plugs['Generic'] ?? []) as AinbPlug[];
        for (let i = 0; i < genericLinks.length; i++) {
            const link = genericLinks[i]!;
            const upstreamIndex = link['Node Index'];
            if (typeof upstreamIndex !== 'number' || upstreamIndex < 0) {
                continue;
            }
            const upstreamId = String(upstreamIndex);
            // The plug Name is the output param name on the upstream node.
            const outputParamName = link.Name?.trim() ?? '';
            // Find a matching output pin on the upstream node to get the value type.
            const upstreamOutputNames = outputParamIndexMap.get(upstreamId);
            let sourceHandle: string | undefined;
            if (upstreamOutputNames && outputParamName) {
                for (const [key, name] of upstreamOutputNames.entries()) {
                    if (name === outputParamName) {
                        const valueType = key.split(':')[0] ?? '';
                        sourceHandle = makeParamHandleId('out', valueType, outputParamName);
                        break;
                    }
                }
            }
            // Infer the target input pin type from node type.
            const nodeType = node['Node Type'] ?? '';
            const defaultType = nodeType === 'Element_F32Selector' ? 'float' : 'bool';
            const targetParamName = outputParamName || 'input';
            const targetHandle = makeParamHandleId('in', defaultType, targetParamName);
            edges.push({
                id: `${upstreamId}-${sourceId}-generic-${i}`,
                source: upstreamId,
                target: sourceId,
                label: outputParamName || 'Generic',
                sourceHandle,
                targetHandle,
            });
        }

        const inputEntries = collectTypedParameterEntries(node, /input/i);
        for (let i = 0; i < inputEntries.length; i++) {
            const inputEntry = inputEntries[i]!;
            if (!inputEntry.raw || typeof inputEntry.raw !== 'object') {
                continue;
            }
            const rawObj = inputEntry.raw as Record<string, unknown>;
            const sourceNodeIndex = rawObj['Node Index'];
            if (typeof sourceNodeIndex !== 'number' || sourceNodeIndex < 0) {
                continue;
            }
            const sourceNodeId = String(sourceNodeIndex);
            const parameterIndex = rawObj['Output Index'];
            let sourceHandle: string | undefined;
            if (typeof parameterIndex === 'number' && parameterIndex >= 0) {
                const outputNames = outputParamIndexMap.get(sourceNodeId);
                const sourceName = outputNames?.get(
                    `${sanitizeHandlePart(inputEntry.valueType)}:${parameterIndex}`,
                );
                if (sourceName) {
                    sourceHandle = makeParamHandleId('out', inputEntry.valueType, sourceName);
                }
            }

            edges.push({
                id: `${sourceNodeId}-${sourceId}-param-${sanitizeHandlePart(inputEntry.valueType)}-${i}`,
                source: sourceNodeId,
                target: sourceId,
                label: `${inputEntry.name}`,
                sourceHandle,
                targetHandle: makeParamHandleId('in', inputEntry.valueType, inputEntry.name),
            });
        }
    }
    return edges;
}

// Entry-point ID space: negative integers so they never clash with real node indices.
const ENTRY_NODE_ID_BASE = -1;

function buildEntryPointNodes(
    commands: AinbCommand[],
): { nodes: NodeEditorNode[]; edges: NodeEditorEdge[] } {
    const nodes: NodeEditorNode[] = [];
    const edges: NodeEditorEdge[] = [];

    for (let i = 0; i < commands.length; i++) {
        const cmd = commands[i]!;
        const entryId = String(ENTRY_NODE_ID_BASE - i);
        const cmdName = cmd.Name?.trim() || `Command ${i}`;

        // Collect which real nodes this entry point fires into.
        const rootIndices: number[] = [];
        if (typeof cmd['Root Node Index'] === 'number') {
            rootIndices.push(cmd['Root Node Index']);
        }
        if (typeof cmd['Secondary Root Node Index'] === 'number') {
            rootIndices.push(cmd['Secondary Root Node Index']);
        }

        // One output pin per root, labeled by slot role.
        const outputPins: NodeEditorPin[] = rootIndices.map((_, slotIdx) => ({
            id: makeFlowOutHandleId('entry', slotIdx === 0 ? 'root' : 'secondary_root'),
            label: slotIdx === 0 ? 'Root' : 'Secondary Root',
            linked: true,
        }));

        nodes.push({
            id: entryId,
            label: cmdName,
            typeLabel: 'Entry Point',
            x: 0,   // will be repositioned in buildNodes layout
            y: 0,
            tags: [],
            roleColor: 'purple',
            inputPins: [],
            outputPins,
            sections: [],
        });

        for (let slotIdx = 0; slotIdx < rootIndices.length; slotIdx++) {
            const rootNodeIndex = rootIndices[slotIdx]!;
            edges.push({
                id: `entry-${i}-slot${slotIdx}-to-${rootNodeIndex}`,
                source: entryId,
                target: String(rootNodeIndex),
                label: slotIdx === 0 ? 'Root' : 'Secondary Root',
                sourceHandle: makeFlowOutHandleId('entry', slotIdx === 0 ? 'root' : 'secondary_root'),
                targetHandle: FLOW_IN_HANDLE_ID,
            });
        }
    }

    return { nodes, edges };
}

export class AinbNodeFormatAdapter implements NodeFormatAdapter {
    readonly id = 'ainb';
    private defs: Map<string, AinbDef> | undefined;

    constructor(
        private readonly extensionPath: string,
        private readonly getRuntimeDefs?: () => Map<string, AinbDef> | undefined,
    ) {}

    supports(filePath: string): boolean {
        const lower = filePath.toLowerCase().replace(/\\/g, '/');
        return lower.endsWith('.ainb') || lower.endsWith('.ainb.zs');
    }

    private getDefs(): Map<string, AinbDef> {
        const runtimeDefs = this.getRuntimeDefs?.();
        if (runtimeDefs && runtimeDefs.size > 0) {
            return runtimeDefs;
        }
        if (!this.defs) {
            const defsPath = path.join(
                this.extensionPath,
                'editors',
                'node-editor',
                'context',
                'aidef.txt',
            );
            const text = fs.readFileSync(defsPath, 'utf-8');
            this.defs = parseAinbDefs(text);
        }
        return this.defs;
    }

    parse(filePath: string, rawText: string): AdapterParseResult {
        const parsed = JSON.parse(rawText) as AinbJson;
        const ainbNodes = parsed.Nodes ?? [];
        const commands = parsed.Commands ?? [];
        const defs = this.getDefs();

        // Build entry-point nodes/edges first so buildEdges can account for them
        // in incomingFlowCount (root nodes will correctly show a flow-in pin).
        const { nodes: entryNodes, edges: entryEdges } = buildEntryPointNodes(commands);
        const dataEdges = buildEdges(ainbNodes);
        const allEdges = [...entryEdges, ...dataEdges];

        const regularNodes = buildNodes(ainbNodes, defs, allEdges);

        // Position entry-point nodes to the left of column 0 (depth -1).
        // Spread them vertically to line up roughly with their root targets.
        const columnGap = 520;
        for (let i = 0; i < entryNodes.length; i++) {
            const node = entryNodes[i]!;
            // Find the y-position of the root target node, if present.
            const rootEdge = allEdges.find((e) => e.source === node.id);
            const rootTarget = rootEdge
                ? regularNodes.find((n) => n.id === rootEdge.target)
                : undefined;
            node.x = -columnGap;
            node.y = rootTarget ? rootTarget.y : i * 160;
        }

        const model: NodeEditorModel = {
            formatId: this.id,
            fileName: path.basename(filePath),
            nodes: [...entryNodes, ...regularNodes],
            edges: allEdges,
        };

        return {
            model,
            originalText: rawText,
        };
    }

    serializeNoop(result: AdapterParseResult): string {
        return result.originalText;
    }
}