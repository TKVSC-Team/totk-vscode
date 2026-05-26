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

// --- STRICT AINB JSON TYPES ---
type AinbSource = { 'Node Index'?: number; 'Parameter Index'?: number; 'Output Index'?: number; 'Blackboard Index'?: number };
type AinbParam = { Name?: string; Value?: any; 'Default Value'?: any; 'Source Node Index'?: number; Source?: AinbSource; 'Blackboard Index'?: number };
type AinbPlug = { 'Node Index'?: number; Name?: string; 'Transition Type'?: number };
type AinbNode = { 'Node Index': number; Name?: string; 'Node Type'?: string; Flags?: string[]; Properties?: Record<string, any>; Parameters?: Record<string, AinbParam[]>; Plugs?: Record<string, AinbPlug[]> };
type AinbCommand = { Name: string; GUID?: string; 'Root Node Index'?: number };
type AinbJson = { Filename?: string; Commands?: AinbCommand[]; Nodes?: AinbNode[]; Blackboard?: any };

type AinbDef = { tags: string[]; eventColor?: NodeRoleColor | string };

export class AinbNodeFormatAdapter implements NodeFormatAdapter {
    public readonly id = 'ainb-json';

    constructor(
        private readonly extensionPath: string,
        private readonly getRuntimeDefs?: () => Map<string, AinbDef> | undefined
    ) {}

    private extractParamSources(param: AinbParam): AinbSource[] {
        // Newer ainb lib emits multi-links as `Sources`, single as `Source`.
        // Keep legacy fallback for `Source Node Index`.
        const p = param as AinbParam & { Sources?: AinbSource[] };
        if (Array.isArray(p.Sources) && p.Sources.length > 0) {
            return p.Sources;
        }
        if (p.Source) {
            return [p.Source];
        }
        if (typeof p['Source Node Index'] === 'number' && p['Source Node Index'] >= 0) {
            return [{ 'Node Index': p['Source Node Index'], 'Output Index': 0 }];
        }
        return [];
    }

    supports(filePath: string): boolean {
        const lowerPath = filePath.toLowerCase();
        // Support both .ainb.json and standard .ainb extensions
        return lowerPath.endsWith('.ainb.json') || lowerPath.endsWith('.ainb');
    }

    parse(filePath: string, rawText: string): AdapterParseResult {
        let data: AinbJson;
        try {
            data = JSON.parse(rawText);
        } catch (e) {
            throw new Error(`Failed to parse AINB JSON: ${(e as Error).message}`);
        }

        const ainbNodes = data.Nodes || [];
        const commands = data.Commands || [];
        const defs = this.getRuntimeDefs?.() || new Map<string, AinbDef>();

        // 1. Calculate Layout (Longest Path DAG)
        const nodeDepths = this.calculateDepths(commands, ainbNodes);
        
        // 2. Build Extracted Nodes
        const entryNodes = this.buildCommands(commands);
        const regularNodes = this.buildNodes(ainbNodes, defs, nodeDepths);
        
        // 3. Build Edges
        const edges = this.buildEdges(commands, ainbNodes, regularNodes);

        return {
            model: {
                formatId: this.id,
                fileName: path.basename(filePath),
                nodes: [...entryNodes, ...regularNodes],
                edges,
                commands, // NEW
                blackboard: data.Blackboard || {}, // NEW
                rawNodes: ainbNodes // NEW: so the inspector can see default values
            },
            originalText: rawText,
        };
    }

    // --- LAYOUT ENGINE ---
private calculateDepths(commands: AinbCommand[], nodes: AinbNode[]): Map<number, { x: number, y: number }> {
        const depths = new Map<number, number>();
        const adj = new Map<number, number[]>();
        const inDegree = new Map<number, number>();

        // 1. Map parent -> children and track incoming connections
        nodes.forEach(n => {
            const children: number[] = [];
            Object.values(n.Plugs || {}).flat().forEach(plug => {
                const targetIdx = plug['Node Index'];
                if (targetIdx !== undefined && targetIdx >= 0) {
                    children.push(targetIdx);
                    inDegree.set(targetIdx, (inDegree.get(targetIdx) || 0) + 1);
                }
            });
            adj.set(n['Node Index'], children);
        });

        const queue: { id: number; d: number }[] = [];
        
        // 2. Queue explicit root nodes (Commands)
        commands.forEach(cmd => {
            if (cmd['Root Node Index'] !== undefined && cmd['Root Node Index'] >= 0) {
                queue.push({ id: cmd['Root Node Index'], d: 1 });
            }
        });

        // 3. Queue implicitly orphaned nodes (nodes with 0 incoming connections)
        nodes.forEach(n => { 
            if (!inDegree.has(n['Node Index'])) {
                queue.push({ id: n['Node Index'], d: 1 });
            }
        });

        // 4. Safe Traversal with Cycle Breaking
        let head = 0;
        while (head < queue.length) {
            const { id, d } = queue[head++];
            
            // CYCLE BREAKER: Only process if we haven't assigned a depth yet
            if (!depths.has(id)) {
                depths.set(id, d);
                
                (adj.get(id) || []).forEach(childId => {
                    // Only push children we haven't locked in yet
                    if (!depths.has(childId)) {
                        queue.push({ id: childId, d: d + 1 });
                    }
                });
            }
        }

        // 5. Catch-all for isolated cyclic islands (nodes trapped in a circle with no root)
        nodes.forEach(n => {
            if (!depths.has(n['Node Index'])) {
                depths.set(n['Node Index'], 1);
            }
        });

        // 6. Assign X and Y based on the calculated depths
        const layout = new Map<number, { x: number, y: number }>();
        const depthCounts = new Map<number, number>();

        nodes.forEach(n => {
            const d = depths.get(n['Node Index']) || 1;
            const rowCount = depthCounts.get(d) || 0;
            layout.set(n['Node Index'], {
                x: d * 400,          // 400px horizontal spacing
                y: rowCount * 220,   // 220px vertical spacing
            });
            depthCounts.set(d, rowCount + 1);
        });

        return layout;
    }

    // --- NODE BUILDERS ---
    private buildCommands(commands: AinbCommand[]): NodeEditorNode[] {
        return commands.map((cmd, index) => ({
            id: `cmd-${index}`,
            label: cmd.Name || 'Entry Point',
            typeLabel: 'Command',
            x: 0,
            y: index * 200,
            tags: ['entry'],
            roleColor: 'purple',
            inputPins: [],
            outputPins: [{ id: 'flow-out', label: 'Start', linked: true }],
            sections: [],
        }));
    }

    private buildNodes(nodes: AinbNode[], defs: Map<string, AinbDef>, layout: Map<number, { x: number, y: number }>): NodeEditorNode[] {
        return nodes.map(node => {
            const idx = node['Node Index'];
            const def = defs.get(node.Name || '');
            const inputPins: NodeEditorPin[] = [{ id: 'flow-in', label: 'In', linked: false }];
            const outputPins: NodeEditorPin[] = [];
            const sections: { title: string; entries: string[] }[] = [];

            // 1. Process Plugs (Flow Outputs)
            Object.entries(node.Plugs || {}).forEach(([plugType, plugs]) => {
                plugs.forEach((plug, plugIndex) => {
                    outputPins.push({
                        id: `out-flow-${plugType}-${plugIndex}`,
                        label: plug.Name || plugType,
                        linked: plug['Node Index'] !== undefined && plug['Node Index'] >= 0
                    });
                });
            });

            // 2. Process Parameters (Data Pins & Static Display)
            Object.entries(node.Parameters || {}).forEach(([paramType, params]) => {
                if (!Array.isArray(params)) {return;} // <-- ADD THIS SAFEGUARD

                const isOutput = paramType.toLowerCase().includes('output');
                const cleanType = paramType.replace(/(Input|Output)/i, '').trim();
                const displayEntries: string[] = [];

                params.forEach((param, paramIndex) => {
                    const paramName = param.Name || 'Unk';
                    if (isOutput) {
                        outputPins.push({ 
                            id: `out-param-${cleanType}-${paramIndex}`, 
                            label: paramName, 
                            linked: false 
                        });
                    } else {
                        const sources = this.extractParamSources(param);
                        const hasNodeSource = sources.some((s) => (s['Node Index'] ?? -1) >= 0);
                        const hasBlackboardSource = sources.some((s) => (s['Blackboard Index'] ?? -1) >= 0)
                            || (param['Blackboard Index'] ?? -1) >= 0;

                        if (hasNodeSource) {
                            inputPins.push({ id: `in-param-${cleanType}-${paramIndex}`, label: paramName, linked: true });
                        } else if (hasBlackboardSource) {
                            const bb = sources.find((s) => (s['Blackboard Index'] ?? -1) >= 0)?.['Blackboard Index']
                                ?? param['Blackboard Index']
                                ?? -1;
                            displayEntries.push(`${paramName} (BB: ${bb})`);
                        } else {
                            displayEntries.push(`${paramName}: ${param.Value ?? param['Default Value'] ?? 'null'}`);
                        }
                    }
                });

                if (displayEntries.length > 0) {sections.push({ title: paramType, entries: displayEntries });}
            });

            // 3. Properties Section
            if (node.Properties && Object.keys(node.Properties).length > 0) {
                sections.push({
                    title: 'Properties',
                    entries: Object.entries(node.Properties).map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
                });
            }

            const pos = layout.get(idx) || { x: 400, y: 0 };

            return {
                id: `node-${idx}`,
                label: node.Name || `Node ${idx}`,
                typeLabel: node['Node Type'] || 'Unknown',
                x: pos.x,
                y: pos.y,
                tags: def?.tags || [],
                roleColor: def?.eventColor || 'blue',
                inputPins,
                outputPins,
                sections
            };
        });
    }

    // --- EDGE BUILDERS ---
    private buildEdges(commands: AinbCommand[], nodes: AinbNode[], uiNodes: NodeEditorNode[]): NodeEditorEdge[] {
        const edges: NodeEditorEdge[] = [];

        // 1. Command -> Root Node Edges
        commands.forEach((cmd, index) => {
            const rootIdx = cmd['Root Node Index'];
            if (rootIdx !== undefined && rootIdx >= 0) {
                edges.push({
                    id: `e-cmd${index}-root`,
                    source: `cmd-${index}`,
                    target: `node-${rootIdx}`,
                    label: 'Start',
                    sourceHandle: 'flow-out',
                    targetHandle: 'flow-in',
                    animated: false
                });
            }
        });

        // 2. Node -> Node Edges (Flow & Data)
        nodes.forEach(node => {
            const srcIdx = node['Node Index'];

            // Flow Edges
            Object.entries(node.Plugs || {}).forEach(([plugType, plugs]) => {
                plugs.forEach((plug, plugIndex) => {
                    const targetIdx = plug['Node Index'];
                    if (targetIdx !== undefined && targetIdx >= 0) {
                        edges.push({
                            id: `e-flow-${srcIdx}-${targetIdx}-${plugIndex}`,
                            source: `node-${srcIdx}`,
                            target: `node-${targetIdx}`,
                            label: plug.Name || '',
                            sourceHandle: `out-flow-${plugType}-${plugIndex}`,
                            targetHandle: 'flow-in',
                            animated: false
                        });
                    }
                });
            });

            // Data Edges (Target Node polling Source Node)
            Object.entries(node.Parameters || {}).forEach(([paramType, params]) => {
                if (!Array.isArray(params)) {return;} // <-- ADD THIS SAFEGUARD
                if (paramType.toLowerCase().includes('output')) {return;} // Outputs don't establish edges themselves
                
                const cleanType = paramType.replace(/(Input|Output)/i, '').trim();

                params.forEach((param, paramIndex) => {
                    const sources = this.extractParamSources(param);
                    for (const src of sources) {
                        const sourceNodeIdx = src['Node Index'] ?? -1;
                        const sourceParamIdx = src['Output Index'] ?? src['Parameter Index'] ?? 0;
                        if (sourceNodeIdx < 0) {
                            continue;
                        }
                        edges.push({
                            id: `e-data-${sourceNodeIdx}-${srcIdx}-${paramIndex}-${sourceParamIdx}`,
                            source: `node-${sourceNodeIdx}`,
                            target: `node-${srcIdx}`,
                            label: 'Data',
                            sourceHandle: `out-param-${cleanType}-${sourceParamIdx}`,
                            targetHandle: `in-param-${cleanType}-${paramIndex}`,
                            animated: true // Visual distinction for variable/data flow
                        });
                    }
                });
            });
        });

        return edges;
    }
}