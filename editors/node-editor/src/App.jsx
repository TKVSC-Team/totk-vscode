import "./assets/styles.css";
import { useEffect, useMemo, useState } from 'react';
import { ReactFlow, MiniMap, Controls, Background, Handle, Position } from '@xyflow/react';
import '@xyflow/react/dist/style.css';

const vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : undefined;

function truncate(text, max = 42) {
  if (!text) return '';
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function AinbNodeCard({ data }) {
  const inputPins = Array.isArray(data.inputPins) ? data.inputPins : [];
  const outputPins = Array.isArray(data.outputPins) ? data.outputPins : [];
  const pinRows = Math.max(inputPins.length, outputPins.length);
  return (
    <div className={`ainb-node-card ainb-node-${data.roleColor || 'blue'}`}>
      <div className="ainb-node-id">#{data.nodeId}</div>
      <div className="ainb-node-title">{truncate(data.label, 52)}</div>
      <div className="ainb-node-type">{data.typeLabel}</div>
      {data.tagText ? <div className="ainb-node-tags">{data.tagText}</div> : null}
      {pinRows > 0 ? (
        <div className="ainb-pin-grid">
          <div className="ainb-pin-column">
            {inputPins.map((pin) => (
              <div className={`ainb-pin-row ainb-pin-row-left ${pin.linked ? 'ainb-pin-linked' : ''}`} key={`in-${pin.id}`}>
                <Handle id={pin.id} type="target" position={Position.Left} className="ainb-handle ainb-pin-handle-left" />
                <span className="ainb-pin-text">{truncate(pin.label, 44)}</span>
              </div>
            ))}
          </div>
          <div className="ainb-pin-column">
            {outputPins.map((pin) => (
              <div className={`ainb-pin-row ainb-pin-row-right ${pin.linked ? 'ainb-pin-linked' : ''}`} key={`out-${pin.id}`}>
                <span className="ainb-pin-text">{truncate(pin.label, 44)}</span>
                <Handle id={pin.id} type="source" position={Position.Right} className="ainb-handle ainb-pin-handle-right" />
              </div>
            ))}
          </div>
        </div>
      ) : null}
      {Array.isArray(data.sections) ? (
        <div className="ainb-sections">
          {data.sections.map((section) => (
            <div className="ainb-section" key={section.title}>
              <div className="ainb-section-title">{section.title}</div>
              {section.entries.slice(0, 10).map((entry, index) => (
                <div className="ainb-section-entry" key={`${section.title}-${index}`}>
                  {entry}
                </div>
              ))}
              {section.entries.length > 10 ? (
                <div className="ainb-section-entry">…{section.entries.length - 10} more</div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

const nodeTypes = {
  ainb: AinbNodeCard,
};

export default function App() {
  const [model, setModel] = useState(null);
  const [error, setError] = useState('');
  const [selectedEdgeId, setSelectedEdgeId] = useState('');

  useEffect(() => {
    const onMessage = (event) => {
      const { type, payload } = event.data || {};
      if (type === 'init') {
        setModel(payload);
      } else if (type === 'saveScaffoldResult') {
        // Phase 1: save scaffold is informational only.
      } else if (type === 'error') {
        setError(String(payload?.message || 'Unknown node editor error'));
      }
    };
    window.addEventListener('message', onMessage);
    vscode?.postMessage({ type: 'ready' });
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const nodes = useMemo(() => {
    if (!model?.nodes) {
      return [];
    }
    return model.nodes.map((node) => ({
      id: node.id,
      position: { x: node.x, y: node.y },
      type: 'ainb',
      data: {
        nodeId: node.id,
        label: node.label,
        typeLabel: node.typeLabel,
        tagText: node.tags?.slice(0, 3).join(' · '),
        roleColor: node.roleColor,
        inputPins: node.inputPins,
        outputPins: node.outputPins,
        sections: node.sections,
      },
      draggable: false,
      selectable: true,
    }));
  }, [model]);

  const edges = useMemo(() => {
    if (!model?.edges) {
      return [];
    }
    return model.edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      sourceHandle: edge.sourceHandle,
      targetHandle: edge.targetHandle,
      label: undefined,
      animated: false,
      type: 'bezier',
      selected: edge.id === selectedEdgeId,
      style: {
        strokeWidth: edge.id === selectedEdgeId ? 2.7 : 1.35,
        stroke: edge.id === selectedEdgeId ? 'rgba(255, 210, 86, 0.98)' : 'rgba(181, 194, 219, 0.55)',
        zIndex: 1,
      },
      interactionWidth: 28,
      zIndex: edge.id === selectedEdgeId ? 6 : 0,
    }));
  }, [model, selectedEdgeId]);

  return (
    <div className="node-editor-root">
      <div className="node-editor-toolbar">
        <button
          type="button"
          onClick={() => vscode?.postMessage({ type: 'requestSaveScaffold' })}
        >
          Validate Save Scaffold
        </button>
      </div>
      <div className="node-editor-title">
        {model?.fileName ? `${model.fileName} (${model.nodes?.length ?? 0} nodes)` : 'AINB Node Editor'}
      </div>
      {!model && !error && <div style={{ padding: 12 }}>Loading AINB graph...</div>}
      {error && <div style={{ padding: 12, color: '#d33' }}>{error}</div>}
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        defaultEdgeOptions={{ type: 'bezier' }}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={true}
        zoomOnDoubleClick={false}
        panOnScroll
        fitView
        fitViewOptions={{ padding: 0.25 }}
        onEdgeClick={(_event, edge) => setSelectedEdgeId(edge.id)}
        onPaneClick={() => setSelectedEdgeId('')}
      >
        <MiniMap pannable zoomable />
        <Controls />
        <Background gap={18} size={1} />
      </ReactFlow>
    </div>
  );
}