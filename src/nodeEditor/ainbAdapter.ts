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

// ---------------------------------------------------------------------------
// Command-aware layout helpers
// ---------------------------------------------------------------------------

function buildNodes(
    nodes: AinbNode[],
    defs: Map<string, AinbDef>,
    edges: NodeEditorEdge[],
    commands: AinbCommand[],
): NodeEditorNode[] {
    const STARLIGHT_RED_NODE_TYPES = new Set([
        'Element_SplitTiming',
        'Element_Simultaneous',
        'Element_Sequential',
        'Element_BoolSelector',
        'Element_S32Selector',
        'Element_F32Selector',
    ]);

    const incomingFlowCount = new Map<string, number>();
    for (const edge of edges) {
        incomingFlowCount.set(edge.target, (incomingFlowCount.get(edge.target) ?? 0) + 1);
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

    for (let index = 0; index < nodes.length; index++) {
        const node = nodes[index]!;
        const nodeIndex = typeof node['Node Index'] === 'number' ? node['Node Index'] : index;
        const nodeType = node['Node Type'] ?? 'Unknown';
        const nodeName = node.Name?.trim() || nodeType;
        const def = defs.get(nodeName) ?? defs.get(nodeType);
        const tags = def?.tags ?? [];
        const id = String(nodeIndex);

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

    // -----------------------------------------------------------------------
    // Layout — column-based placement for dual-flow (execution + data) graphs
    //
    // The recursive relY approach breaks on shared nodes (one provider feeding
    // multiple consumers) because relY is a single value but the correct offset
    // depends on which consumer is asking. Instead we:
    //
    //   1. Walk the graph from each root via BFS, assigning every node a column:
    //      - flow children  → column + 1  (rightward)
    //      - data providers → column - 1  (leftward)
    //      A node's final column is the extreme value seen across all visits so
    //      providers always end up left of every consumer and children always
    //      right of every parent.
    //
    //   2. Within each column, sort nodes by the order they were first discovered
    //      (BFS order ≈ tree order) and stack them top-to-bottom with NODE_SEP.
    //
    //   3. Run per-command: each command root seeds its own BFS. After all roots
    //      are placed, orphans (no flow-parent, no data-consumer) get their own
    //      subtree below, separated by GROUP_PAD.
    //
    // This is O(n) after adjacency is built, handles shared nodes cleanly, and
    // never places a provider to the right of its consumer.
    // -----------------------------------------------------------------------

    const NODE_SEP  = 20;   // vertical gap between nodes in the same column
    const RANK_SEP  = 820;  // horizontal distance per column step
    const GROUP_PAD = 160;  // vertical gap between command groups / orphan blocks
    const START_X   = 100;
    const START_Y   = 100;

    // ---- adjacency --------------------------------------------------------
    const childrenOf  = new Map<string, string[]>();   // flow → right
    const providersOf = new Map<string, string[]>();   // data → left
    const parentsOf   = new Map<string, Set<string>>();
    const consumersOf = new Map<string, Set<string>>();

    for (let index = 0; index < nodes.length; index++) {
        const node = nodes[index]!;
        const nodeIndex = typeof node['Node Index'] === 'number' ? node['Node Index'] : index;
        const id = String(nodeIndex);
        childrenOf.set(id, []);
        providersOf.set(id, []);
        parentsOf.set(id, new Set());
        consumersOf.set(id, new Set());
    }

    for (let index = 0; index < nodes.length; index++) {
        const node = nodes[index]!;
        const nodeIndex = typeof node['Node Index'] === 'number' ? node['Node Index'] : index;
        const id = String(nodeIndex);

        for (const [plugType, links] of Object.entries(node.Plugs ?? {})) {
            if (plugType === 'Generic') {continue;}
            for (const link of links) {
                const ti = link['Node Index'];
                if (typeof ti !== 'number') {continue;}
                const tid = String(ti);
                if (!childrenOf.has(tid)) {continue;}
                childrenOf.get(id)!.push(tid);
                parentsOf.get(tid)!.add(id);
            }
        }

        const addProvider = (id: string, provIdxRaw: unknown) => {
            if (typeof provIdxRaw !== 'number' || provIdxRaw < 0) {return;}
            const pid = String(provIdxRaw);
            if (!providersOf.has(id)) {return;}
            providersOf.get(id)!.push(pid);
            consumersOf.get(pid)!.add(id);
        };

        const inputEntries = collectTypedParameterEntries(node, /input/i);
        for (const entry of inputEntries) {
            if (!entry.raw || typeof entry.raw !== 'object') {continue;}
            const rawObj = entry.raw as Record<string, unknown>;
            addProvider(id, rawObj['Node Index']);
            const sources = rawObj.Sources;
            if (Array.isArray(sources)) {
                for (const src of sources) {
                    if (src && typeof src === 'object')
                        {addProvider(id, (src as Record<string, unknown>)['Node Index']);}
                }
            }
        }

        const genericLinks = (node.Plugs?.['Generic'] ?? []) as AinbPlug[];
        for (const link of genericLinks) {
            addProvider(id, link['Node Index']);
        }
    }

    // Deduplicate provider lists
    for (const [id, provs] of providersOf.entries()) {
        const seen = new Set<string>();
        providersOf.set(id, provs.filter((p) => { if (seen.has(p)) {return false;} seen.add(p); return true; }));
    }

    // ---- height estimation ------------------------------------------------
    const estimateNodeHeight = (id: string): number => {
        const computed = precomputed.get(id);
        let height = 96;
        const pinRows = Math.max(
            computed?.inputPins.length ?? 0,
            computed?.outputPins.length ?? 0,
        );
        if (pinRows > 0) { height += 8 + pinRows * 20 + 6; }
        for (const section of computed?.sections ?? []) {
            const vis = Math.min(section.entries.length, 10);
            height += 18 + vis * 14 + (section.entries.length > 10 ? 14 : 0) + 6;
        }
        return height;
    };

    const calcNodeWidth = (name: string): number =>
        Math.max(320, Math.min(600, name.length * 8 + 80));

    // ---- layout state -----------------------------------------------------
    type LayoutState = { x: number; y: number; w: number; h: number };
    const layoutState = new Map<string, LayoutState>();

    for (let index = 0; index < nodes.length; index++) {
        const node = nodes[index]!;
        const nodeIndex = typeof node['Node Index'] === 'number' ? node['Node Index'] : index;
        const id = String(nodeIndex);
        const computed = precomputed.get(id);
        layoutState.set(id, {
            x: 0, y: 0,
            w: calcNodeWidth(computed?.nodeName ?? ''),
            h: estimateNodeHeight(id),
        });
    }

    // ---- BFS column assignment + placement --------------------------------
    // columnOf: relative column index from root (root = 0, children = +1, providers = -1)
    // discovery: BFS order within each column (used for vertical stacking)

    const placed = new Set<string>();

    /**
     * Place a group of nodes rooted at `rootId`, starting at canvas position
     * (groupStartX, groupStartY). Returns the bottom Y of the placed group.
     */
    function placeGroup(rootId: string, groupStartX: number, groupStartY: number): number {
        if (!layoutState.has(rootId) || placed.has(rootId)) {return groupStartY;}

        // BFS to assign columns and discovery order
        const columnOf  = new Map<string, number>();
        const orderOf   = new Map<string, number>();
        const bfsQueue: string[] = [rootId];
        columnOf.set(rootId, 0);
        let orderCounter = 0;

        while (bfsQueue.length > 0) {
            const cur = bfsQueue.shift()!;
            if (orderOf.has(cur)) {continue;}
            orderOf.set(cur, orderCounter++);

            const curCol = columnOf.get(cur) ?? 0;

            // providers go left
            for (const pid of providersOf.get(cur) ?? []) {
                if (placed.has(pid)) {continue;}
                const existing = columnOf.get(pid);
                const desired  = curCol - 1;
                // Take the most-left column seen (min) so a shared provider
                // always ends up left of all its consumers.
                if (existing === undefined || desired < existing) {
                    columnOf.set(pid, desired);
                    bfsQueue.push(pid);
                }
            }

            // children go right
            for (const cid of childrenOf.get(cur) ?? []) {
                if (placed.has(cid)) {continue;}
                const existing = columnOf.get(cid);
                const desired  = curCol + 1;
                // Take the most-right column (max) so a shared child stays
                // right of all its parents.
                if (existing === undefined || desired > existing) {
                    columnOf.set(cid, desired);
                    bfsQueue.push(cid);
                }
            }
        }

        // Sort nodes into columns
        const columns = new Map<number, string[]>();
        for (const [id, col] of columnOf.entries()) {
            if (!columns.has(col)) {columns.set(col, []);}
            columns.get(col)!.push(id);
        }

        // Sort within each column by BFS discovery order
        for (const ids of columns.values()) {
            ids.sort((a, b) => (orderOf.get(a) ?? 0) - (orderOf.get(b) ?? 0));
        }

        // Normalise column indices so minimum column = 0
        const colNums = [...columns.keys()].sort((a, b) => a - b);
        const minCol  = colNums[0] ?? 0;

        // Place nodes: x = groupStartX + (col - minCol) * RANK_SEP
        // y = stack top-to-bottom within each column, starting at groupStartY
        let groupMaxY = groupStartY;

        for (const col of colNums) {
            const ids = columns.get(col) ?? [];
            let y = groupStartY;
            for (const id of ids) {
                if (placed.has(id)) {continue;}
                const state = layoutState.get(id)!;
                state.x = groupStartX + (col - minCol) * RANK_SEP;
                state.y = y;
                placed.add(id);
                y += state.h + NODE_SEP;
            }
            groupMaxY = Math.max(groupMaxY, y);
        }

        return groupMaxY;
    }

    // ---- root selection ---------------------------------------------------
    const roots: string[] = [];

    for (let index = 0; index < nodes.length; index++) {
        const node = nodes[index]!;
        if ((node.Flags ?? []).some((f) => /IsResidentNode|Is Root Node/i.test(f))) {
            const nodeIndex = typeof node['Node Index'] === 'number' ? node['Node Index'] : index;
            roots.push(String(nodeIndex));
        }
    }

    if (roots.length === 0) {
        for (const cmd of commands) {
            if (typeof cmd['Root Node Index'] === 'number')
                {roots.push(String(cmd['Root Node Index']));}
            if (typeof cmd['Secondary Root Node Index'] === 'number')
                {roots.push(String(cmd['Secondary Root Node Index']));}
        }
    }

    if (roots.length === 0 && nodes.length > 0) {
        roots.push(String(typeof nodes[0]!['Node Index'] === 'number' ? nodes[0]!['Node Index'] : 0));
    }

    const rootsSeen = new Set<string>();
    const uniqueRoots = roots.filter((r) => { if (rootsSeen.has(r)) {return false;} rootsSeen.add(r); return true; });

    // ---- place command groups --------------------------------------------
    let nextGroupTop = START_Y;
    for (const rootId of uniqueRoots) {
        const bottom = placeGroup(rootId, START_X, nextGroupTop);
        if (bottom > nextGroupTop) {nextGroupTop = bottom + GROUP_PAD;}
    }

    // ---- orphan pass -----------------------------------------------------
    for (let index = 0; index < nodes.length; index++) {
        const node = nodes[index]!;
        const nodeIndex = typeof node['Node Index'] === 'number' ? node['Node Index'] : index;
        const id = String(nodeIndex);
        if (placed.has(id)) {continue;}
        if ((parentsOf.get(id)?.size ?? 0) > 0) {continue;}
        if ((consumersOf.get(id)?.size ?? 0) > 0) {continue;}
        const bottom = placeGroup(id, START_X, nextGroupTop);
        if (bottom > nextGroupTop) {nextGroupTop = bottom + GROUP_PAD;}
    }

    return nodes.map((node, index) => {
        const nodeIndex = typeof node['Node Index'] === 'number' ? node['Node Index'] : index;
        const id = String(nodeIndex);
        const computed = precomputed.get(id);
        const state = layoutState.get(id);
        return {
            id,
            label: computed?.nodeName ?? `(Node ${id})`,
            typeLabel: computed?.nodeType ?? 'Unknown',
            x: state?.x ?? START_X,
            y: state?.y ?? START_Y,
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

        const regularNodes = buildNodes(ainbNodes, defs, allEdges, commands);

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