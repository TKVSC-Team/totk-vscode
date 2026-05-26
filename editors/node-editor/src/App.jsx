import "./assets/styles.css";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow, MiniMap, Controls, Background,
  Handle, Position, getBezierPath, ReactFlowProvider,
  applyNodeChanges, useViewport,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

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
// *semantic key* — the value-type + param-name — stripped of direction prefix.
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

function pinColor(handleId) {
  return pinColorFromSemanticKey(pinSemanticKey(handleId));
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
// Gradient edge — color lerps from source handle color to target handle color.
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

  const srcRgb = parseColor(data?.srcColor ?? 'hsl(42,85%,68%)');
  const tgtRgb = parseColor(data?.tgtColor ?? 'hsl(42,85%,68%)');
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
// Zoom threshold below which nodes render as cheap LOD cards.
const NODE_LOD_ZOOM = 0.18;

const NODE_TYPES_FULL = { ainb: AinbNodeCard };
const NODE_TYPES_LOD  = { ainb: AinbNodeLod };
const edgeTypes         = { gradient: GradientEdge };
const DEFAULT_EDGE_OPTS = { type: 'gradient' };
const FIT_VIEW_OPTS     = { padding: 0.18 };

// Build edge gradient data. Source and target colors use the same semantic-key
// logic as the pin balls, so wires connecting matching param types are uniform
// and cross-type wires have a visible lerp.
function buildEdgeData(edge) {
  return {
    srcColor: pinColor(edge.sourceHandle),
    tgtColor: pinColor(edge.targetHandle),
  };
}

// ---------------------------------------------------------------------------
// FlowInner — owns ReactFlow state
// ---------------------------------------------------------------------------
function FlowInner({ model }) {
  const selectedEdgeIdRef = useRef('');
  const [selectedEdgeId, setSelectedEdgeId] = useState('');

  // Switch between full and LOD node renderers based on viewport zoom.
  // Memoize on the boolean crossing so nodeTypes identity is stable
  // between zoom events that don't cross the threshold.
  const { zoom } = useViewport();
  const nodeTypes = useMemo(
    () => (zoom >= NODE_LOD_ZOOM ? NODE_TYPES_FULL : NODE_TYPES_LOD),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [zoom >= NODE_LOD_ZOOM],
  );

  // ---- Nodes ---------------------------------------------------------------
  // ReactFlow must own node positions so drags write back into state.
  const initialNodes = useMemo(() => {
    if (!model?.nodes) return [];
    return model.nodes.map((node) => ({
      id:   String(node.id),
      position: { x: node.x, y: node.y },
      type: 'ainb',
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
  useEffect(() => { setNodes(initialNodes); }, [initialNodes]);
  const onNodesChange = useCallback(
    (changes) => setNodes((nds) => applyNodeChanges(changes, nds)),
    [],
  );

  // ---- Edges ---------------------------------------------------------------
  // baseEdges only rebuilds when model changes.
  // Selection is layered on top in a separate cheap memo.
  const baseEdges = useMemo(() => {
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

  const edges = useMemo(() => {
    if (!selectedEdgeId) return baseEdges;
    return baseEdges.map((edge) => {
      const sel = edge.id === selectedEdgeId;
      if (!sel && !edge.selected) return edge;
      return { ...edge, selected: sel, zIndex: sel ? 6 : 0 };
    });
  }, [baseEdges, selectedEdgeId]);

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
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      defaultEdgeOptions={DEFAULT_EDGE_OPTS}
      onNodesChange={onNodesChange}
      onEdgeClick={onEdgeClick}
      onPaneClick={onPaneClick}

      // Interaction
      nodesDraggable={true}
      nodesConnectable={false}
      elementsSelectable={true}
      zoomOnDoubleClick={false}
      panOnDrag={[1, 2]}        // middle + right mouse pan; left is for node drag
      panOnScroll={false}
      zoomOnScroll={true}
      selectionOnDrag={false}

      // Zoom range — minZoom 0.01 lets you zoom out to see all 800 nodes
      minZoom={0.01}
      maxZoom={4}

      // Only render nodes/edges in the viewport — critical for 800-node perf
      onlyRenderVisibleElements={true}

      fitView
      fitViewOptions={FIT_VIEW_OPTS}
    >
      <MiniMap pannable zoomable />
      <Controls />
      <Background gap={18} size={1} />
    </ReactFlow>
  );
}

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------
export default function App() {
  const [model, setModel] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const onMessage = ({ data }) => {
      const { type, payload } = data || {};
      if (type === 'init')  setModel(payload);
      if (type === 'error') setError(String(payload?.message || 'Unknown error'));
    };
    window.addEventListener('message', onMessage);
    vscode?.postMessage({ type: 'ready' });
    return () => window.removeEventListener('message', onMessage);
  }, []);

  return (
    <div className="node-editor-root">
      <div className="node-editor-toolbar">
        <button type="button"
          onClick={() => vscode?.postMessage({ type: 'requestSaveScaffold' })}>
          Validate Save Scaffold
        </button>
      </div>
      <div className="node-editor-title">
        {model?.fileName
          ? `${model.fileName} (${model.nodes?.length ?? 0} nodes)`
          : 'AINB Node Editor'}
      </div>
      {!model && !error && <div style={{ padding: 12 }}>Loading AINB graph…</div>}
      {error && <div style={{ padding: 12, color: '#d33' }}>{error}</div>}
      <ReactFlowProvider>
        <FlowInner model={model} />
      </ReactFlowProvider>
    </div>
  );
}