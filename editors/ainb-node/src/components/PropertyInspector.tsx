export function PropertyInspector({ selectedNode }: { selectedNode: any }) {
  if (!selectedNode) {
    return (
      <div style={{ padding: '10px', color: '#888', borderLeft: '1px solid #444', width: '250px', background: '#252526' }}>
        No node selected
      </div>
    );
  }

  const { data } = selectedNode;
  const { name, node_index, Parameters, Properties, nodeDef } = data;

  return (
    <div style={{
      width: '250px',
      background: '#252526',
      borderLeft: '1px solid #444',
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
    }}>
      <div style={{ padding: '10px', borderBottom: '1px solid #444', background: '#333' }}>
        <div style={{ fontWeight: 'bold', color: '#fff', fontSize: '14px' }}>{name}</div>
        <div style={{ fontSize: '11px', color: '#aaa', marginTop: '4px' }}>Index: {node_index}</div>
        {nodeDef?.Tags && (
          <div style={{ display: 'flex', gap: '4px', marginTop: '6px', flexWrap: 'wrap' }}>
            {nodeDef.Tags.map((t: string) => (
              <span key={t} style={{ background: '#444', color: '#ddd', fontSize: '9px', padding: '2px 6px', borderRadius: '8px' }}>
                {t}
              </span>
            ))}
          </div>
        )}
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '10px' }}>
        {/* Input Parameters */}
        {Parameters?.Inputs && Object.keys(Parameters.Inputs).map(type => (
          <div key={`in-${type}`} style={{ marginBottom: '12px' }}>
            <div style={{ fontSize: '11px', color: '#aaa', textTransform: 'uppercase', marginBottom: '4px' }}>Input {type}</div>
            {Parameters.Inputs[type].map((p: any) => (
              <div key={p.Name} style={{ background: '#333', padding: '6px', marginBottom: '4px', borderRadius: '3px', fontSize: '12px', borderLeft: '3px solid #ffaa00' }}>
                <div style={{ fontWeight: 'bold', color: '#fff' }}>{p.Name}</div>
                {p["Node Index"] !== undefined && p["Node Index"] !== -1 ? (
                  <div style={{ fontSize: '10px', color: '#88f', marginTop: '2px' }}>Linked to Node {p["Node Index"]}</div>
                ) : (
                  <div style={{ fontSize: '10px', marginTop: '2px', color: '#ccc' }}>Value: {p["Default Value"] !== undefined ? String(p["Default Value"]) : 'N/A'}</div>
                )}
              </div>
            ))}
          </div>
        ))}

        {/* Properties */}
        {Properties && Object.keys(Properties).map(type => (
          <div key={`prop-${type}`} style={{ marginBottom: '12px' }}>
            <div style={{ fontSize: '11px', color: '#aaa', textTransform: 'uppercase', marginBottom: '4px' }}>Property {type}</div>
            {Properties[type].map((p: any) => (
              <div key={p.Name} style={{ background: '#333', padding: '6px', marginBottom: '4px', borderRadius: '3px', fontSize: '12px', borderLeft: '3px solid #aaa' }}>
                <div style={{ fontWeight: 'bold', color: '#fff' }}>{p.Name}</div>
                <div style={{ fontSize: '10px', marginTop: '2px', color: '#ccc' }}>Value: {p.Value !== undefined ? String(p.Value) : 'N/A'}</div>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
