import { Handle, Position } from '@xyflow/react';

export function AinbNode({ data, isConnectable }: { data: any; isConnectable: boolean }) {
  const { node_index, name, Parameters, Plugs, nodeDef } = data;

  // Determine tag color
  let headerColor = '#333';
  if (nodeDef && nodeDef.Tags) {
    const tags = nodeDef.Tags as string[];
    if (tags.includes('Selector')) headerColor = 'hsl(280, 50%, 40%)';
    else if (tags.includes('Query')) headerColor = 'hsl(120, 50%, 30%)';
    else if (tags.includes('OneShot')) headerColor = 'hsl(200, 50%, 40%)';
    else if (tags.includes('BSA')) headerColor = 'hsl(0, 50%, 40%)';
    else if (tags.includes('EventNode')) headerColor = 'hsl(40, 70%, 40%)';
  }

  // Gather Input Params
  const inputParams: any[] = [];
  if (Parameters?.Inputs) {
    Object.keys(Parameters.Inputs).forEach(type => {
      Parameters.Inputs[type].forEach((p: any) => inputParams.push({ type, ...p }));
    });
  }

  // Gather Output Params
  const outputParams: any[] = [];
  if (Parameters?.Outputs) {
    Object.keys(Parameters.Outputs).forEach(type => {
      Parameters.Outputs[type].forEach((p: any, idx: number) => outputParams.push({ type, idx, ...p }));
    });
  }

  // Gather Flow Outs (Child / Transition)
  const flowOuts: any[] = [];
  if (Plugs) {
    if (Plugs.Child) Plugs.Child.forEach((p: any) => flowOuts.push({ type: 'Child', ...p }));
    if (Plugs.Transition) Plugs.Transition.forEach((p: any) => flowOuts.push({ type: 'Transition', ...p }));
  }

  const getTypeColor = (type: string) => {
    switch (type) {
      case 'Int': return '#ffaa00';
      case 'Float': return '#ffff00';
      case 'Bool': return '#00ffaa';
      case 'String': return '#aa55ff';
      case 'Vector3F': return '#ff5500';
      case 'Pointer': return '#ff0055';
      default: return '#aaa';
    }
  };

  // Determine root status, query status, oneshot status
  const isRoot = data.Flags?.["Is Root Node"] || data["Is Root Node"] || false;
  let isQuery = false;
  let isOneShot = false;
  if (nodeDef && nodeDef.Tags) {
    const tags = nodeDef.Tags as string[];
    isQuery = tags.includes('Query');
    isOneShot = tags.includes('OneShot');
  }

  // Visual border configurations
  let nodeBorder = '1px solid #444';
  let nodeShadow = '0 4px 6px rgba(0,0,0,0.3)';
  if (isRoot) {
    nodeBorder = '2px solid #55ff55';
    nodeShadow = '0 0 12px rgba(85, 255, 85, 0.4)';
  } else if (isQuery) {
    nodeBorder = '1.5px dashed hsl(120, 50%, 45%)';
  } else if (isOneShot) {
    nodeBorder = '1.5px dashed hsl(200, 50%, 45%)';
  }

  return (
    <div style={{
      background: '#252526',
      border: nodeBorder,
      borderRadius: '6px',
      minWidth: '240px',
      color: '#eee',
      fontSize: '12px',
      boxShadow: nodeShadow,
      overflow: 'visible', // allow handles to overflow nicely
      position: 'relative'
    }}>
      {/* Header Container */}
      <div style={{
        position: 'relative',
        background: headerColor,
        padding: '6px 12px 6px 18px', // extra left padding for flow-in handle
        fontWeight: 'bold',
        borderBottom: '1px solid #444',
        borderTopLeftRadius: '5px',
        borderTopRightRadius: '5px',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center'
      }}>
        {/* Left Flow Input Handle */}
        <Handle
          type="target"
          position={Position.Left}
          id="flow-in"
          isConnectable={isConnectable}
          style={{
            background: '#55aaff',
            width: '12px',
            height: '12px',
            left: '-6px',
            top: '50%',
            transform: 'translateY(-50%)',
            border: '2px solid #252526',
            borderRadius: '3px'
          }}
        />
        <span>{name}</span>
        <span style={{ fontSize: '10px', opacity: 0.7 }}>#{node_index}</span>
      </div>

      {/* Node Body */}
      <div style={{ display: 'flex', flexDirection: 'column', padding: '6px 0' }}>
        
        {/* Data Inputs (Left Side) */}
        {inputParams.length > 0 && (
          <div style={{ borderBottom: flowOuts.length > 0 || outputParams.length > 0 ? '1px solid #333' : 'none', paddingBottom: '4px' }}>
            {inputParams.map(p => (
              <div key={p.Name} style={{ position: 'relative', padding: '4px 12px', display: 'flex', alignItems: 'center' }}>
                <Handle
                  type="target"
                  position={Position.Left}
                  id={`data-in-${p.type}-${p.Name}`}
                  isConnectable={isConnectable}
                  style={{
                    background: getTypeColor(p.type),
                    width: '10px',
                    height: '10px',
                    left: '-5px',
                    border: '1.5px solid #252526'
                  }}
                />
                <span style={{ fontSize: '11px', color: '#ccc' }}>{p.Name} <span style={{ opacity: 0.5, fontSize: '9px' }}>({p.type})</span></span>
              </div>
            ))}
          </div>
        )}

        {/* Data Outputs (Right Side) */}
        {outputParams.length > 0 && (
          <div style={{ borderBottom: flowOuts.length > 0 ? '1px solid #333' : 'none', paddingBottom: '4px', paddingTop: inputParams.length > 0 ? '4px' : '0' }}>
            {outputParams.map(p => (
              <div key={p.Name} style={{ position: 'relative', padding: '4px 12px', display: 'flex', alignItems: 'center', justifyContent: 'flex-end' }}>
                <span style={{ fontSize: '11px', color: '#ccc' }}>{p.Name} <span style={{ opacity: 0.5, fontSize: '9px' }}>({p.type})</span></span>
                <Handle
                  type="source"
                  position={Position.Right}
                  id={`data-out-${p.type}-${p.idx}`}
                  isConnectable={isConnectable}
                  style={{
                    background: getTypeColor(p.type),
                    width: '10px',
                    height: '10px',
                    right: '-5px',
                    border: '1.5px solid #252526'
                  }}
                />
              </div>
            ))}
          </div>
        )}

        {/* Flow Outputs (Right Side - Cyan color-coded) */}
        {flowOuts.length > 0 && (
          <div style={{ paddingTop: '4px' }}>
            <div style={{ padding: '2px 12px', fontSize: '9px', color: '#55aaff', opacity: 0.8, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Execution Out</div>
            {flowOuts.map(p => (
              <div key={`${p.type}-${p.Name}`} style={{ position: 'relative', padding: '4px 12px', display: 'flex', alignItems: 'center', justifyContent: 'flex-end' }}>
                <span style={{ fontSize: '11px', color: '#55aaff', fontWeight: 'bold' }}>{p.Name}</span>
                <Handle
                  type="source"
                  position={Position.Right}
                  id={`flow-out-${p.Name}`}
                  isConnectable={isConnectable}
                  style={{
                    background: '#55aaff',
                    width: '12px',
                    height: '12px',
                    right: '-6px',
                    border: '2px solid #252526',
                    borderRadius: '3px'
                  }}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
