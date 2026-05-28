import { useState } from 'react';

export function NodePalette({ paletteData, onAddNode }: { paletteData: any, onAddNode: (type: string) => void }) {
  const [search, setSearch] = useState('');

  if (!paletteData) {
    return <div style={{ padding: '10px', color: '#888' }}>Loading palette...</div>;
  }

  // Assuming paletteData is an array of node definitions or an object mapping names to defs
  const nodes = Array.isArray(paletteData) ? paletteData : Object.keys(paletteData).map(k => ({ name: k, ...paletteData[k] }));
  
  const filtered = nodes.filter(n => n.name && n.name.toLowerCase().includes(search.toLowerCase())).slice(0, 50);

  return (
    <div style={{
      width: '250px',
      background: '#252526',
      borderLeft: '1px solid #444',
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
    }}>
      <div style={{ padding: '10px', borderBottom: '1px solid #444' }}>
        <input 
          type="text" 
          placeholder="Search nodes..." 
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ width: '100%', padding: '6px', background: '#3c3c3c', border: '1px solid #555', color: '#ccc', borderRadius: '4px' }}
        />
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '10px' }}>
        {filtered.map(n => (
          <div 
            key={n.name}
            onClick={() => onAddNode(n.name)}
            style={{
              padding: '8px',
              background: '#333',
              marginBottom: '6px',
              borderRadius: '4px',
              cursor: 'pointer',
              fontSize: '12px',
              color: '#eee',
              userSelect: 'none'
            }}
            onMouseEnter={e => (e.currentTarget.style.background = '#444')}
            onMouseLeave={e => (e.currentTarget.style.background = '#333')}
          >
            {n.name}
          </div>
        ))}
      </div>
    </div>
  );
}
