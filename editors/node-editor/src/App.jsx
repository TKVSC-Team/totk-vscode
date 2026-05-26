import "./assets/styles.css";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow, MiniMap, Controls, Background,
  Handle, Position, getBezierPath, ReactFlowProvider,
  applyNodeChanges, useViewport,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useOnSelectionChange } from '@xyflow/react';

const vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : undefined;

// ---------------------------------------------------------------------------
// Pin color system
//
// Handle IDs from the adapter follow these patterns:
//   flow-in
//   out-flow-{plugtype}-{plugname}
//   in-param-{valuetype}-{paramname}
//   out-param-{valuetype}-{paramname}
//
// For connected pins to share a color, we derive the color from the
// *semantic key* - the value-type + param-name - stripped of direction prefix.
// Flow pins get a fixed gold color so they're visually distinct from data pins.
// ---------------------------------------------------------------------------

const FLOW_PIN_COLOR = 'hsl(42, 85%, 68%)'; // gold

function pinSemanticKey(handleId) {
  if (!handleId) return '';
  // flow-in  → ''  (use FLOW_PIN_COLOR)
  if (handleId === 'flow-in') return '__flow__';
  // out-flow-* → ''
  if (handleId.startsWith('out-flow-') || handleId.startsWith('in-flow-')) return '__flow__';
  // in-param-float-speed  → 'float-speed'
  // out-param-float-speed → 'float-speed'
  const paramMatch = handleId.match(/^(?:in|out)-param-(.+)$/);
  if (paramMatch) return paramMatch[1];
  return handleId;
}

// djb2-style hash → pastel HSL. Same semantic key → same color on both ends.
function pinColorFromSemanticKey(key) {
  if (!key || key === '__flow__') return FLOW_PIN_COLOR;
  let h = 0;
  for (let i = 0; i < key.length; i++) {
    h = (Math.imul(31, h) + key.charCodeAt(i)) | 0;
  }
  const hue = ((h >>> 0) % 300) + 30; // 30–330° avoids pure red
  return `hsl(${hue}, 58%, 70%)`;
}

// Module-level cache - pin IDs are static strings, so this never needs
// clearing. Eliminates the hash loop + regex on every node render.
const _pinColorCache = new Map();
function pinColor(handleId) {
  let color = _pinColorCache.get(handleId);
  if (color === undefined) {
    color = pinColorFromSemanticKey(pinSemanticKey(handleId));
    _pinColorCache.set(handleId, color);
  }
  return color;
}

// ---------------------------------------------------------------------------
// Color parsing / lerp (for gradient edges)
// ---------------------------------------------------------------------------

function parseHsl(str) {
  const m = str.match(/hsl\((\d+),\s*([\d.]+)%,\s*([\d.]+)%/);
  if (!m) return null;
  const h = +m[1] / 360, s = +m[2] / 100, l = +m[3] / 100;
  if (s === 0) { const v = Math.round(l * 255); return [v, v, v]; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const c = (t) => {
    const tt = ((t % 1) + 1) % 1;
    if (tt < 1/6) return p + (q - p) * 6 * tt;
    if (tt < 1/2) return q;
    if (tt < 2/3) return p + (q - p) * (2/3 - tt) * 6;
    return p;
  };
  return [Math.round(c(h + 1/3) * 255), Math.round(c(h) * 255), Math.round(c(h - 1/3) * 255)];
}

function parseColor(str) {
  if (!str) return [168, 184, 216];
  const hex = str.match(/^#([0-9a-f]{6})$/i);
  if (hex) { const n = parseInt(hex[1], 16); return [(n>>16)&255,(n>>8)&255,n&255]; }
  const rgb = str.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (rgb) return [+rgb[1], +rgb[2], +rgb[3]];
  return parseHsl(str) ?? [168, 184, 216];
}

function lerpRgb(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

function toRgba([r, g, b], a) { return `rgba(${r},${g},${b},${a})`; }

// ---------------------------------------------------------------------------
// Gradient edge - color lerps from source handle color to target handle color.
// When both ends share the same semantic key (connected param pair), the wire
// is a uniform color. When they differ (cross-type or flow→param), it lerps.
// ---------------------------------------------------------------------------
const GradientEdge = memo(function GradientEdge({
  id, sourceX, sourceY, targetX, targetY,
  sourcePosition, targetPosition,
  data, selected,
}) {
  const [edgePath] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  const gradId = `eg-${id}`;

  // srcRgb/tgtRgb are pre-parsed in buildEdgeData - no color work on render.
  const srcRgb = data?.srcRgb ?? [255, 196, 87];
  const tgtRgb = data?.tgtRgb ?? [255, 196, 87];
  const midRgb = lerpRgb(srcRgb, tgtRgb, 0.5);
  const alpha  = selected ? 0.92 : 0.5;
  const width  = selected ? 2.7  : 1.35;

  return (
    <>
      <defs>
        <linearGradient id={gradId} gradientUnits="userSpaceOnUse"
          x1={sourceX} y1={sourceY} x2={targetX} y2={targetY}>
          <stop offset="0%"   stopColor={toRgba(srcRgb, alpha)} />
          <stop offset="35%"  stopColor={toRgba(midRgb, alpha * 0.8)} />
          <stop offset="65%"  stopColor={toRgba(midRgb, alpha * 0.8)} />
          <stop offset="100%" stopColor={toRgba(tgtRgb, alpha)} />
        </linearGradient>
      </defs>
      <path d={edgePath} fill="none" stroke={`url(#${gradId})`} strokeWidth={width}
        style={{ transition: 'stroke-width 100ms ease' }} />
      {selected && (
        <path d={edgePath} fill="none"
          stroke="rgba(255,210,86,0.5)" strokeWidth={width + 2}
          style={{ filter: 'drop-shadow(0 0 3px rgba(255,210,86,0.45))' }} />
      )}
    </>
  );
});

// ---------------------------------------------------------------------------
// Node card
// ---------------------------------------------------------------------------
function truncate(text, max = 42) {
  if (!text) return '';
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

const AinbNodeCard = memo(function AinbNodeCard({ data }) {
  const inputPins  = Array.isArray(data.inputPins)  ? data.inputPins  : [];
  const outputPins = Array.isArray(data.outputPins) ? data.outputPins : [];

  return (
    <div className={`ainb-node-card ainb-node-${data.roleColor || 'blue'}`}>
      <div className="ainb-node-id">#{data.nodeId}</div>
      <div className="ainb-node-title">{truncate(data.label, 52)}</div>
      <div className="ainb-node-type">{data.typeLabel}</div>
      {data.tagText ? <div className="ainb-node-tags">{data.tagText}</div> : null}

      {(inputPins.length > 0 || outputPins.length > 0) && (
        <div className="ainb-pin-grid">
          <div className="ainb-pin-column">
            {inputPins.map((pin) => (
              <div
                className={`ainb-pin-row ainb-pin-row-left${pin.linked ? ' ainb-pin-linked' : ''}`}
                key={`in-${pin.id}`}
              >
                <Handle
                  id={pin.id}
                  type="target"
                  position={Position.Left}
                  className="ainb-handle ainb-pin-handle-left"
                  style={{ '--pin-color': pinColor(pin.id) }}
                />
                <span className="ainb-pin-text">{truncate(pin.label, 44)}</span>
              </div>
            ))}
          </div>
          <div className="ainb-pin-column">
            {outputPins.map((pin) => (
              <div
                className={`ainb-pin-row ainb-pin-row-right${pin.linked ? ' ainb-pin-linked' : ''}`}
                key={`out-${pin.id}`}
              >
                <span className="ainb-pin-text">{truncate(pin.label, 44)}</span>
                <Handle
                  id={pin.id}
                  type="source"
                  position={Position.Right}
                  className="ainb-handle ainb-pin-handle-right"
                  style={{ '--pin-color': pinColor(pin.id) }}
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {Array.isArray(data.sections) && data.sections.length > 0 && (
        <div className="ainb-sections">
          {data.sections.map((section) => (
            <div className="ainb-section" key={section.title}>
              <div className="ainb-section-title">{section.title}</div>
              {section.entries.slice(0, 10).map((entry, i) => (
                <div className="ainb-section-entry" key={i}>{entry}</div>
              ))}
              {section.entries.length > 10 && (
                <div className="ainb-section-entry ainb-section-more">
                  +{section.entries.length - 10} more
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
});

// ---------------------------------------------------------------------------
// Low-detail node card -- rendered when zoomed out past NODE_LOD_ZOOM.
// Just the title bar: #id + label. No pins, no sections, no DOM cost.
// ---------------------------------------------------------------------------
const AinbNodeLod = memo(function AinbNodeLod({ data }) {
  return (
    <div className={`ainb-node-card ainb-node-lod ainb-node-${data.roleColor || 'blue'}`}>
      <div className="ainb-node-id">#{data.nodeId}</div>
      <div className="ainb-node-title">{truncate(data.label, 52)}</div>
    </div>
  );
});

// ---------------------------------------------------------------------------
// Module-level stable constants
// ---------------------------------------------------------------------------
const NODE_LOD_ZOOM = 0.18;

const NODE_TYPES_FULL = { ainb: AinbNodeCard };
const NODE_TYPES_LOD  = { ainb: AinbNodeLod };
const edgeTypes         = { gradient: GradientEdge };
const DEFAULT_EDGE_OPTS = { type: 'gradient' };
const FIT_VIEW_OPTS     = { padding: 0.18 };

function buildEdgeData(edge) {
  // Parse RGB once here so GradientEdge never calls parseColor on render.
  const srcColor = pinColor(edge.sourceHandle);
  const tgtColor = pinColor(edge.targetHandle);
  return {
    srcColor,
    tgtColor,
    srcRgb: parseColor(srcColor),
    tgtRgb: parseColor(tgtColor),
  };
}

// ---------------------------------------------------------------------------
// Spatial grid - world-space bucketing for frustum culling
//
// The canvas layout uses columnGap=520, rowGap=34, nodes ~220-340px wide,
// height varies. 1500 nodes across ~30 depth columns → up to ~15k × ~50k
// world units worst case.
//
// Strategy:
//   - Divide world into CELL_SIZE × CELL_SIZE cells
//   - Each node is bucketed into the cell containing its position
//   - On viewport change, compute the world-space AABB of the screen,
//     expand by CELL_PAD cells, collect all intersecting cell keys
//   - Visible nodes = nodes in visible cells
//   - Visible edges = edges where source OR target node is visible
//     (catches long cross-graph connections without AABB math per edge)
// ---------------------------------------------------------------------------
const CELL_SIZE = 3000;   // world units per cell side
const CELL_PAD  = 1;      // extra cells of margin to prevent pop-in

// Integer cell key - Map/Set lookups on integers are faster than strings in V8.
// Multiplier is a large prime; coords realistically stay well within ±100 000.
function cellKey(cx, cy) { return cx * 1_000_003 + cy; }

function nodeToCell(x, y) {
  return [Math.floor(x / CELL_SIZE), Math.floor(y / CELL_SIZE)];
}

// Build grid: Map<cellKey, Set<nodeId>>  +  Map<nodeId, cellKey>
function buildSpatialGrid(rfNodes) {
  const grid    = new Map(); // cellKey → Set<rfNode>
  const nodeCell = new Map(); // nodeId  → cellKey
  for (const n of rfNodes) {
    const [cx, cy] = nodeToCell(n.position.x, n.position.y);
    const key = cellKey(cx, cy);
    if (!grid.has(key)) grid.set(key, new Set());
    grid.get(key).add(n.id);
    nodeCell.set(n.id, key);
  }
  return { grid, nodeCell };
}

// Given ReactFlow viewport {x, y, zoom} and container size {w, h},
// return Set<cellKey> of all cells that intersect the visible world AABB.
function visibleCellKeys(viewport, w, h) {
  // ReactFlow viewport: world origin is at (vx, vy) in screen space.
  // screen point (sx, sy) → world = ((sx - vx) / zoom, (sy - vy) / zoom)
  const { x: vx, y: vy, zoom } = viewport;
  const wxMin = (0    - vx) / zoom;
  const wyMin = (0    - vy) / zoom;
  const wxMax = (w    - vx) / zoom;
  const wyMax = (h    - vy) / zoom;

  const cxMin = Math.floor(wxMin / CELL_SIZE) - CELL_PAD;
  const cyMin = Math.floor(wyMin / CELL_SIZE) - CELL_PAD;
  const cxMax = Math.floor(wxMax / CELL_SIZE) + CELL_PAD;
  const cyMax = Math.floor(wyMax / CELL_SIZE) + CELL_PAD;

  const keys = new Set();
  for (let cx = cxMin; cx <= cxMax; cx++) {
    for (let cy = cyMin; cy <= cyMax; cy++) {
      keys.add(cellKey(cx, cy));
    }
  }
  return keys;
}

// ---------------------------------------------------------------------------
// FlowInner - owns ReactFlow state + incremental spatial culling
// ---------------------------------------------------------------------------
function FlowInner({ model }) {
  const selectedEdgeIdRef = useRef('');
  const [selectedEdgeId, setSelectedEdgeId] = useState('');
  const containerRef = useRef(null);
  const [containerSize, setContainerSize] = useState({ w: 1920, h: 1080 });

  // Track container size for accurate frustum AABB
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setContainerSize({ w: width, h: height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);


  
  const onConnect = useCallback((connection) => {
    // Flow handles look like 'out-flow-Child-0' or 'flow-in'
    // Data handles look like 'out-param-F32-0' or 'in-param-F32-1'
    const isFlow = connection.sourceHandle.startsWith('out-flow') || connection.targetHandle === 'flow-in';
    
    const sourceParts = connection.sourceHandle.split('-'); 
    const targetParts = connection.targetHandle.split('-');
    
    vscode?.postMessage({
      type: 'rpc_edit',
      payload: {
        action: isFlow ? 'link_flow_plugs' : 'link_node_params',
        payload: {
          sourceId: parseInt(connection.source.replace('node-', ''), 10),
          targetId: parseInt(connection.target.replace('node-', ''), 10),
          
          // Flow: Extract type and index from the source handle
          plugType: isFlow ? sourceParts[2] : undefined,
          plugIndex: isFlow ? parseInt(sourceParts[3] || '0', 10) : undefined,
          
          // Data: Extract type, source index, and target index
          paramType: !isFlow ? targetParts[2] : undefined,
          sourceIdx: !isFlow ? parseInt(sourceParts[3] || '0', 10) : undefined,
          targetIdx: !isFlow ? parseInt(targetParts[3] || '0', 10) : undefined
        }
      }
    });
  }, []);

  // 2. Handle Node Deletion (Backspace / Delete key)
  const onNodesDelete = useCallback((deletedNodes) => {
    deletedNodes.forEach(node => {
      vscode?.postMessage({
        type: 'rpc_edit',
        payload: {
          action: 'remove_node',
          payload: { nodeId: node.id }
        }
      });
    });
  }, []);

  const viewport = useViewport();
  const { zoom } = viewport;

  const isFullDetail = zoom >= NODE_LOD_ZOOM;
  const nodeTypes = useMemo(
    () => (isFullDetail ? NODE_TYPES_FULL : NODE_TYPES_LOD),
    [isFullDetail],
  );

  // ---- All nodes (full set, owned by ReactFlow for drag state) -------------
  const allRfNodes = useMemo(() => {
    if (!model?.nodes) return [];
    return model.nodes.map((node) => ({
      id:       String(node.id),
      position: { x: node.x, y: node.y },
      type:     'ainb',
      data: {
        nodeId:     node.id,
        label:      node.label,
        typeLabel:  node.typeLabel,
        tagText:    node.tags?.slice(0, 3).join(' · '),
        roleColor:  node.roleColor,
        inputPins:  node.inputPins,
        outputPins: node.outputPins,
        sections:   node.sections,
      },
      draggable:  true,
      selectable: true,
    }));
  }, [model]);

  const [nodes, setNodes] = useState([]);
  useEffect(() => { setNodes(allRfNodes); }, [allRfNodes]);

  // ---- Spatial grid - ref so patches don't trigger re-renders --------------
  // gridRef.current = { grid: Map<cellKey, Set<nodeId>>, nodeCell: Map<nodeId, cellKey> }
  // gridVersion increments only when a node crosses a cell boundary, which is
  // what the cull memos depend on - not every pixel of drag.
  const gridRef = useRef({ grid: new Map(), nodeCell: new Map() });
  const [gridVersion, setGridVersion] = useState(0);

  // Full rebuild when model loads (allRfNodes identity changes)
  useEffect(() => {
    gridRef.current = buildSpatialGrid(allRfNodes);
    setGridVersion((v) => v + 1);
  }, [allRfNodes]);

  // Incremental patch on drag - only touches moved nodes, only bumps version
  // when a node actually crosses into a new cell.
  const onNodesChange = useCallback((changes) => {
    setNodes((nds) => {
      const updated = applyNodeChanges(changes, nds);
      const { grid, nodeCell } = gridRef.current;
      let cellCrossed = false;
      for (const change of changes) {
        if (change.type !== 'position' || !change.position) continue;
        const { x, y } = change.position;
        const oldKey = nodeCell.get(change.id);
        const [cx, cy] = nodeToCell(x, y);
        const newKey = cellKey(cx, cy);
        if (newKey === oldKey) continue; // same cell - no work needed
        // Remove from old cell
        if (oldKey !== undefined) {
          const oldSet = grid.get(oldKey);
          if (oldSet) {
            oldSet.delete(change.id);
            if (oldSet.size === 0) grid.delete(oldKey);
          }
        }
        // Insert into new cell
        if (!grid.has(newKey)) grid.set(newKey, new Set());
        grid.get(newKey).add(change.id);
        nodeCell.set(change.id, newKey);
        cellCrossed = true;
      }
      if (cellCrossed) setGridVersion((v) => v + 1);
      return updated;
    });
  }, []);

  // ---- Visible cell keys - recomputed on viewport/size change --------------
  const visCells = useMemo(
    () => visibleCellKeys(viewport, containerSize.w, containerSize.h),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [viewport.x, viewport.y, viewport.zoom, containerSize.w, containerSize.h],
  );

  // ---- Cull nodes via hidden prop - NOT by filtering the array --------------
  // ReactFlow must receive every node to resolve handle positions for edges.
  // Filtering the array breaks connections to off-screen nodes (known RF bug).
  // Instead, set hidden:true on off-screen nodes - RF skips their DOM subtree
  // but keeps them in its internal store so edge anchoring still works.
  const culledNodes = useMemo(() => {
    if (nodes.length === 0) return nodes;
    const { nodeCell } = gridRef.current;
    return nodes.map((n) => {
      const inView = visCells.has(nodeCell.get(n.id));
      // Keep object identity when nothing changed - avoids unnecessary RF re-renders
      if (n.hidden === !inView) return n;
      return { ...n, hidden: !inView };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, gridVersion, visCells]);

  // ---- All edges (base, never culled source-of-truth) ----------------------
  const allBaseEdges = useMemo(() => {
    if (!model?.edges) return [];
    return model.edges.map((edge) => ({
      id:           edge.id,
      source:       String(edge.source),
      target:       String(edge.target),
      sourceHandle: edge.sourceHandle,
      targetHandle: edge.targetHandle,
      type:         'gradient',
      data:         buildEdgeData(edge),
      interactionWidth: 24,
      zIndex:       0,
    }));
  }, [model]);

  // ---- Edges - no culling, just selection state layered on top ------------
  // Edges are SVG <path> elements and are cheap at any count.
  // Culling them causes broken/missing connections with no meaningful perf gain.
  const visibleEdges = useMemo(() => {
    if (!selectedEdgeId) return allBaseEdges;
    return allBaseEdges.map((edge) => {
      if (edge.id !== selectedEdgeId) return edge;
      return { ...edge, selected: true, zIndex: 6 };
    });
  }, [allBaseEdges, selectedEdgeId]);

  // ---- Handlers ------------------------------------------------------------
  const onEdgeClick = useCallback((_evt, edge) => {
    if (selectedEdgeIdRef.current === edge.id) return;
    selectedEdgeIdRef.current = edge.id;
    setSelectedEdgeId(edge.id);
  }, []);

  const onPaneClick = useCallback(() => {
    if (!selectedEdgeIdRef.current) return;
    selectedEdgeIdRef.current = '';
    setSelectedEdgeId('');
  }, []);

  return (
    <div ref={containerRef} style={{ flex: 1, minHeight: 0 }}>
    <ReactFlow
        nodes={culledNodes}
        edges={visibleEdges}
        onConnect={onConnect}             // NEW
        onNodesDelete={onNodesDelete}     // NEW
        nodesConnectable={true}           // CHANGED: allow drawing edges
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        defaultEdgeOptions={DEFAULT_EDGE_OPTS}
        onNodesChange={onNodesChange}
        onEdgeClick={onEdgeClick}
        onPaneClick={onPaneClick}

        nodesDraggable={true}
        elementsSelectable={true}
        zoomOnDoubleClick={false}
        panOnDrag={[1, 2]}
        panOnScroll={false}
        zoomOnScroll={true}
        selectionOnDrag={false}

        minZoom={0.01}
        maxZoom={4}

        elevateEdgesOnSelect={true}

        fitView
        fitViewOptions={FIT_VIEW_OPTS}
      >
        <MiniMap pannable zoomable />
        <Controls />
        <Background gap={18} size={1} />
      </ReactFlow>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------
// App.jsx
export default function App() {
  const [model, setModel] = useState(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('Initializing Editor...');
  const [progress, setProgress] = useState(0); // <-- NEW STATE
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const onMessage = ({ data }) => {
      const { type, payload } = data || {};
      if (type === 'init') {
        setModel(payload);
        setIsLoading(false);
      }
      if (type === 'error') {
        setError(String(payload?.message || 'Unknown error'));
        setIsLoading(false);
      }
      if (type === 'status') {
        // Update to handle object payloads with progress
        setStatus(payload.text || payload);
        if (payload.progress) setProgress(payload.progress);
      }
    };
    window.addEventListener('message', onMessage);
    vscode?.postMessage({ type: 'ready' });
    return () => window.removeEventListener('message', onMessage);
  }, []);

  if (error) {
    return (
      <div className="fullscreen-overlay error-overlay">
        <h2>Failed to Load Graph</h2>
        <p>{error}</p>
      </div>
    );
  }

  // --- UPDATED: Loading Screen with Bar ---
  if (isLoading) {
    return (
      <div className="fullscreen-overlay loading-overlay">
        <div className="spinner"></div>
        <h3 style={{ marginTop: '20px' }}>{status}</h3>
        
        {/* NEW PROGRESS BAR */}
        <div style={{ 
          width: '300px', 
          height: '6px', 
          background: '#222', 
          borderRadius: '4px', 
          marginTop: '15px', 
          overflow: 'hidden',
          boxShadow: 'inset 0 1px 3px rgba(0,0,0,0.5)'
        }}>
          <div style={{ 
            width: `${progress}%`, 
            height: '100%', 
            background: 'hsl(42, 85%, 68%)', // Matching your FLOW_PIN_COLOR
            transition: 'width 0.2s ease-out' 
          }}></div>
        </div>

      </div>
    );
  }

  return (
    <div className="node-editor-root">
      <div className="node-editor-toolbar">...</div>
      <div className="node-editor-title">...</div>
      
      <div className="node-editor-main">
        <ReactFlowProvider style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <FlowInner model={model} />
          <InspectorPanel model={model} />
        </ReactFlowProvider>
      </div>
    </div>
  );
}

// --- INSPECTOR PANEL ---
const InspectorPanel = memo(function InspectorPanel({ model }) {
  const [selectedNodes, setSelectedNodes] = useState([]);
  
  useOnSelectionChange({
    onChange: ({ nodes }) => setSelectedNodes(nodes),
  });

  const selectedNode = selectedNodes.length > 0 ? selectedNodes[0] : null;

  // Handle Input Changes and dispatch to Python
  const handleNodeParamChange = (nodeId, paramType, paramName, newValue) => {
    vscode?.postMessage({
      type: 'rpc_edit',
      payload: {
        action: 'edit_node_param',
        payload: { nodeId, paramType, paramName, newValue }
      }
    });
  };

  const renderNodeInspector = () => {
    const rawNode = model?.rawNodes?.find(n => `node-${n['Node Index']}` === selectedNode.id);
    if (!rawNode) return <div style={{color: '#8b949e'}}>Entry Command Selected.</div>;

    return (
      <>
        <div className="inspector-section">
          <div className="inspector-section-title">Node Info</div>
          <div className="inspector-row"><label>ID:</label> {rawNode['Node Index']}</div>
          <div className="inspector-row"><label>Name:</label> {rawNode.Name}</div>
          <div className="inspector-row"><label>Type:</label> {rawNode['Node Type']}</div>
        </div>

        {Object.entries(rawNode.Parameters || {}).map(([paramGroup, params]) => {
           // <-- ADD THIS SAFEGUARD
           if (!Array.isArray(params)) return null; 

           // We only want to edit Inputs that are not linked
           if (paramGroup.toLowerCase().includes('output')) return null;
           
           return (
             <div className="inspector-section" key={paramGroup}>
               <div className="inspector-section-title">{paramGroup}</div>
               {params.map((p, i) => {
                 const isLinked = p['Source Node Index'] >= 0;
                 return (
                   <div className="inspector-row" key={i}>
                     <label>{p.Name} {isLinked ? '(Linked)' : ''}</label>
                     <input 
                        type="text" 
                        defaultValue={p.Value ?? p['Default Value'] ?? ''}
                        disabled={isLinked}
                        onBlur={(e) => handleNodeParamChange(rawNode['Node Index'], paramGroup, p.Name, e.target.value)}
                     />
                   </div>
                 );
               })}
             </div>
           );
        })}
      </>
    );
  };

  const renderGlobalInspector = () => {
    return (
      <>
        <div className="inspector-section">
          <div className="inspector-section-title">Commands (Entry Points)</div>
          {model?.commands?.map((cmd, i) => (
            <div className="inspector-row" key={i}>
              <label>{cmd.Name || 'Unnamed'}</label>
              <input type="text" readOnly value={`Root Node: ${cmd['Root Node Index']}`} />
            </div>
          ))}
        </div>

        <div className="inspector-section">
          <div className="inspector-section-title">Blackboard Parameters</div>
          {Object.entries(model?.blackboard || {}).map(([type, params]) => {
            if (!Array.isArray(params)) return null;
            return params.map((bb, i) => (
              <div className="inspector-row" key={`${type}-${i}`}>
                <label>[{type.replace(' Parameters', '')}] {bb.Name}</label>
                <input type="text" readOnly defaultValue={bb.Value ?? bb['Default Value'] ?? ''} />
              </div>
            ));
          })}
        </div>
      </>
    );
  };

  return (
    <div className="node-editor-inspector">
      <div className="inspector-header">
        {selectedNode ? `Editing: ${selectedNode.data?.label}` : 'Global Settings'}
      </div>
      <div className="inspector-content">
        {selectedNode ? renderNodeInspector() : renderGlobalInspector()}
      </div>
    </div>
  );
});