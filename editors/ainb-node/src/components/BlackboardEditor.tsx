export function BlackboardEditor({ blackboardData }: { blackboardData: any }) {
  if (!blackboardData) {
    return <div style={{ padding: '10px', color: '#888' }}>No Blackboard</div>;
  }

  // Blackboard has multiple arrays depending on type, e.g., strings, ints, floats, bools
  const sections = ['strings', 'ints', 'floats', 'bools', 'vec3s', 'pointers'];
  
  return (
    <div style={{
      width: '250px',
      background: '#252526',
      borderRight: '1px solid #444',
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
    }}>
      <div style={{ padding: '10px', borderBottom: '1px solid #444', fontWeight: 'bold', color: '#eee' }}>
        Blackboard
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '10px' }}>
        {sections.map(sec => {
          const items = blackboardData[sec];
          if (!items || items.length === 0) return null;
          return (
            <div key={sec} style={{ marginBottom: '12px' }}>
              <div style={{ fontSize: '11px', color: '#aaa', textTransform: 'uppercase', marginBottom: '4px' }}>{sec}</div>
              {items.map((item: any, i: number) => (
                <div key={i} style={{ 
                  background: '#333', 
                  padding: '6px', 
                  marginBottom: '4px', 
                  borderRadius: '3px',
                  fontSize: '12px',
                  color: '#ccc',
                  borderLeft: '3px solid #55aaff'
                }}>
                  <div style={{ fontWeight: 'bold', color: '#fff' }}>{item.Name || 'Unnamed'}</div>
                  <div style={{ fontSize: '10px', marginTop: '2px' }}>Value: {item.Value !== undefined ? String(item.Value) : 'N/A'}</div>
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
