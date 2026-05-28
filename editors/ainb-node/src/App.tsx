import { useState, useCallback, useEffect, useMemo } from 'react';
import {
  ReactFlow,
  Controls,
  Background,
  applyNodeChanges,
  applyEdgeChanges,
  addEdge,
  BackgroundVariant,
  useReactFlow,
  ReactFlowProvider
} from '@xyflow/react';
import type { Node, Edge, NodeChange, EdgeChange, Connection } from '@xyflow/react';
import dagre from 'dagre';
import '@xyflow/react/dist/style.css';

import './App.css';
import { AinbNode } from './components/AinbNode';
import { NodePalette } from './components/NodePalette';
import { BlackboardEditor } from './components/BlackboardEditor';
import { PropertyInspector } from './components/PropertyInspector';

// @ts-ignore
const vscode = window.acquireVsCodeApi ? window.acquireVsCodeApi() : null;

const dagreGraph = new dagre.graphlib.Graph();
dagreGraph.setDefaultEdgeLabel(() => ({}));

const getLayoutedElements = (nodes: Node[], edges: Edge[], direction = 'TB') => {
  dagreGraph.setGraph({ rankdir: direction });

  nodes.forEach((node) => {
    dagreGraph.setNode(node.id, { width: 250, height: 150 });
  });

  edges.forEach((edge) => {
    dagreGraph.setEdge(edge.source, edge.target);
  });

  dagre.layout(dagreGraph);

  nodes.forEach((node) => {
    const nodeWithPosition = dagreGraph.node(node.id);
    node.position = {
      x: nodeWithPosition.x - 250 / 2,
      y: nodeWithPosition.y - 150 / 2,
    };
  });

  return { nodes, edges };
};

function FlowApp() {
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [graphData, setGraphData] = useState<any>(null);
  const [paletteData, setPaletteData] = useState<any>(null);
  
  const nodeTypes = useMemo(() => ({ ainbNode: AinbNode }), []);

  const { fitView } = useReactFlow();

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => setNodes((nds) => applyNodeChanges(changes, nds)),
    [],
  );
  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => setEdges((eds) => applyEdgeChanges(changes, eds)),
    [],
  );
  const onConnect = useCallback(
    (params: Connection) => setEdges((eds) => addEdge(params, eds)),
    [],
  );

  // isValidConnection Hook
  const isValidConnection = useCallback((connection: Edge | Connection) => {
    if (!connection.sourceHandle || !connection.targetHandle) return false;

    // 2. Flow-to-Flow only
    const isSourceFlow = connection.sourceHandle.startsWith('flow-');
    const isTargetFlow = connection.targetHandle.startsWith('flow-');
    if (isSourceFlow !== isTargetFlow) return false;

    // 3. Outbound Flow Singularity
    if (isSourceFlow) {
      const hasExistingEdge = edges.some(
        (edge) => edge.source === connection.source && edge.sourceHandle === connection.sourceHandle
      );
      if (hasExistingEdge) return false;
      return true;
    }

    // 4. Data-to-Data only and Type Safety Check
    const isSourceData = connection.sourceHandle.startsWith('data-out-');
    const isTargetData = connection.targetHandle.startsWith('data-in-');
    if (!isSourceData || !isTargetData) return false;

    // Extract Types
    const sourceParts = connection.sourceHandle.split('-');
    const targetParts = connection.targetHandle.split('-');
    if (sourceParts.length >= 3 && targetParts.length >= 3) {
      const sourceType = sourceParts[2];
      const targetType = targetParts[2];
      if (sourceType !== targetType) return false;
    }

    // 5. Inbound Data Singularity
    const hasExistingDataEdge = edges.some(
      (edge) => edge.target === connection.target && edge.targetHandle === connection.targetHandle
    );
    if (hasExistingDataEdge) return false;

    return true;
  }, [edges]);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const message = event.data;
      if (message.type === 'load') {
        setGraphData(message.data);
        
        if (message.data?.nodes) {
          const newNodes: Node[] = [];
          const newEdges: Edge[] = [];
          const outputTypesMap: { [nodeIndex: number]: { [outputIndex: number]: string } } = {};

          // First Pass: Build Output Types Map
          message.data.nodes.forEach((n: any) => {
            outputTypesMap[n["Node Index"]] = {};
            let outIdx = 0;
            if (n.Parameters?.Outputs) {
              Object.keys(n.Parameters.Outputs).forEach(type => {
                n.Parameters.Outputs[type].forEach(() => {
                  outputTypesMap[n["Node Index"]][outIdx] = type;
                  outIdx++;
                });
              });
            }
          });

          message.data.nodes.forEach((n: any) => {
            // Find def if we have palette
            let def = null;
            if (paletteData && paletteData[n.Name]) {
              def = paletteData[n.Name];
            }

            newNodes.push({
              id: n["Node Index"].toString(),
              type: 'ainbNode',
              position: { x: 0, y: 0 },
              data: { ...n, name: n.Name, node_index: n["Node Index"], nodeDef: def }
            });

            // Flow Edges (Child & Transition)
            if (n.Plugs) {
              if (n.Plugs.Child) {
                n.Plugs.Child.forEach((c: any) => {
                  newEdges.push({
                    id: `e_flow_${n["Node Index"]}_${c["Node Index"]}_${c.Name}`,
                    source: n["Node Index"].toString(),
                    target: c["Node Index"].toString(),
                    sourceHandle: `flow-out-${c.Name}`,
                    targetHandle: 'flow-in',
                    type: 'smoothstep',
                    animated: true,
                    style: { stroke: '#55aaff', strokeWidth: 2 }
                  });
                });
              }
              if (n.Plugs.Transition) {
                n.Plugs.Transition.forEach((c: any) => {
                  newEdges.push({
                    id: `e_flow_${n["Node Index"]}_${c["Node Index"]}_${c.Name}`,
                    source: n["Node Index"].toString(),
                    target: c["Node Index"].toString(),
                    sourceHandle: `flow-out-${c.Name}`,
                    targetHandle: 'flow-in',
                    type: 'smoothstep',
                    animated: true,
                    style: { stroke: '#55aaff', strokeWidth: 2 }
                  });
                });
              }
            }

            // Data Edges
            if (n.Parameters?.Inputs) {
              Object.keys(n.Parameters.Inputs).forEach(type => {
                n.Parameters.Inputs[type].forEach((param: any) => {
                  if (param["Node Index"] !== undefined && param["Node Index"] >= 0) {
                    const sourceType = outputTypesMap[param["Node Index"]]?.[param["Output Index"] || 0] || type;
                    newEdges.push({
                      id: `e_data_${param["Node Index"]}_${n["Node Index"]}_${param.Name}`,
                      source: param["Node Index"].toString(),
                      target: n["Node Index"].toString(),
                      sourceHandle: `data-out-${sourceType}-${param["Output Index"] || 0}`,
                      targetHandle: `data-in-${type}-${param.Name}`,
                      type: 'straight',
                      style: { stroke: '#aaff55', strokeWidth: 2, strokeDasharray: '5,5' }
                    });
                  }
                });
              });
            }
          });

          // Apply Layout
          const { nodes: layoutedNodes, edges: layoutedEdges } = getLayoutedElements(newNodes, newEdges, 'LR');
          setNodes(layoutedNodes);
          setEdges(layoutedEdges);
          
          setTimeout(() => fitView(), 100);
        }
      } else if (message.type === 'palette') {
        setPaletteData(message.data);
      }
    };
    
    window.addEventListener('message', handleMessage);
    
    if (vscode) {
      vscode.postMessage({ type: 'ready' });
      vscode.postMessage({ type: 'get-palette' });
    }
    
    return () => window.removeEventListener('message', handleMessage);
  }, [paletteData, fitView]);

  const onAddNode = (type: string) => {
    const newNode: Node = {
      id: `new_${nodes.length}`,
      type: 'ainbNode',
      position: { x: 250, y: 150 },
      data: { name: type, node_index: nodes.length, nodeDef: paletteData?.[type] }
    };
    setNodes(nds => [...nds, newNode]);
  };

  const selectedNode = nodes.find(n => n.selected);

  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '8px', background: '#333', color: '#fff', fontSize: '12px', borderBottom: '1px solid #444', display: 'flex', justifyContent: 'space-between' }}>
        <div>{graphData ? `AINB Loaded: ${graphData.filename || 'Unknown'} (${graphData.category || 'No Category'})` : 'Waiting for data...'}</div>
        <button onClick={() => vscode?.postMessage({ type: 'save', data: { nodes, edges } })} style={{ background: '#0e639c', color: 'white', border: 'none', borderRadius: '3px', padding: '2px 8px', cursor: 'pointer' }}>
          Save
        </button>
      </div>
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        <BlackboardEditor blackboardData={graphData?.blackboard} />
        <div style={{ flex: 1, position: 'relative' }}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            isValidConnection={isValidConnection}
            colorMode="dark"
            fitView
          >
            <Controls />
            <Background variant={BackgroundVariant.Dots} gap={12} size={1} />
          </ReactFlow>
        </div>
        <PropertyInspector selectedNode={selectedNode} />
        <NodePalette paletteData={paletteData} onAddNode={onAddNode} />
      </div>
    </div>
  );
}

export default function App() {
  return (
    <ReactFlowProvider>
      <FlowApp />
    </ReactFlowProvider>
  );
}
