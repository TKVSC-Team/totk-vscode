#pragma array_limit 1000000
#pragma pattern_limit 10000000

struct Vector3f {
    float x, y, z;
};

struct Mat34 {
    float m11, m12, m13, m14;
    float m21, m22, m23, m24;
    float m31, m32, m33, m34;
};

struct BoundBox3f {
    Vector3f min, max;
};

struct ResChunk {
    // these coordinates are in terms of how many chunks of the same size it's offset by
    // represents the center of the chunk
    u16 x;
    u16 y;
    u16 z;
    u16 lod_level; // how many subdivisions down is this chunk (0 would be the root, 1 would be a child of the root node, etc.)

    // defines a single chunk (node) in the octree
};

struct Section2 {
    u32 reserve0;
    u32 reserve1;
};

struct ResChunkRelation {
    u16 child_start;
    u16 child_end;
};

struct Section3Quad {
    u32 reserve0;
    u32 reserve1;
};

struct ResChunkBounds {
    BoundBox3f bounds;
};

struct Section4 {
    u8 reserve;
};

struct ResIndexInfo {
    u32 base_vertex_stream_index;
    u16 base_material_palette_index;
    u8 vertex_stream_count;
    u8 reserve1;
    u32 reserve2;
    u32 reserve3;
};

struct Section5 {
    u32 reserve;
};

struct ResIgnoreChunks {
    u32 mask;
};

struct ResChunkVertexStream {
    u32 base_index; // first index is at index_buffer + base_index * stride
    u32 triangle_count; // index count / 3
    u16 flags;
    u16 index; // page file index? aka the chunk/quad file index?
};

struct ResMaterialPalette {
    Vector3f u_bias; // u = (pos.x * u_bias.x + pos.y * u_bias.y + pos.z * u_bias.z) * uv_scale
    float array_layer; // material texture is an array texture, this is just the index
    Vector3f v_bias; // v = (pos.x * v_bias.x + pos.y * v_bias.y + pos.z * v_bias.z) * uv_scale
    float uv_scale;
};

struct Section8Quad {
    u8 reserve[6];
};

struct ResPageFile {
    u32 reserve; // lines up with offset 0xc of the chunk file
    u32 file_index;
};

struct Offset<T> {
    u32 offset;
    u32 count;
    
    T entries[count] @ offset;
};

struct ResChunkMeshData {
    Offset<ResChunk> chunks;
    Offset<Section2> section_2;
    Offset<ResChunkRelation> chunk_relations;
    Offset<ResChunkBounds> chunk_bounds;
    Offset<ResIndexInfo> index_info;
    Offset<ResIgnoreChunks> no_blend_chunks; // adjacent chunks to ignore when blending
    Offset<ResChunkVertexStream> vertex_streams;
    Offset<ResMaterialPalette> material_palette_data;
    Offset<ResPageFile> chunk_files;
    u32 _48;
    u32 num_root_chunks;
    Vector3f base_pos;
    float min_sidelength;
    u32 subdivisions;
    BoundBox3f bounds; // for the centers of chunks I believe?
};

struct SectionsQuad {
    Offset<ResChunk> chunks;
    Offset<Section2> section_2;
    Offset<Section3Quad> section_3;
    Offset<Section4> section_4;
    Offset<Section5> section_5;
    Offset<ResIgnoreChunks> no_blend_chunks;
    Offset<ResChunkBounds> vertex_data;
    Offset<Section8Quad> section_8;
    Offset<ResPageFile> quads;
};

struct Header {
    char magic[8]; // cave017\x00
    u32 file_size;
    u32 reserve0; // version?
    u32 crbin_id;
    Mat34 transform;
    Offset<u8> reserve14[4];
    u32 reserve15;
    ResChunkMeshData chunk_mesh;
    u32 reserve29[4];
    SectionsQuad quad_sections;
    float reserve31[12];
    u8 resreve32[112];
};

Header file @ 0x00;

/*

// chunk vertex format

bitfield MatInfo {
    adjacent_chunk : 5;
    // index into the MaterialPaletteUBO the data for which is copied directly from the crbin file
    index0 : 9;
    index1 : 9;
    index2 : 9;
};

bitfield PosInfo {
    _00 : 6; // used for out_attr8

    // pos = x * sidelength / 4096 + chunk_base_pos
    x : 13;
    y : 13;
    z : 13;
    
    // used for out_attr5
    _13 : 5;
    _18 : 5;
    
    _23 : 6; // used for out_attr7
    maybe_padding : 3;
};

bitfield BlendInfoMaybe {
    _00 : 7;
    _07 : 7;
    
    // used for out_attr6
    _14 : 6;
    _20 : 6;
    _26 : 6;
};

struct Vertex {
    MatInfo mat_info;
    PosInfo low_lod;
    BlendInfoMaybe _08;
    PosInfo normal_lod;
    BlendInfoMaybe _18;
};

*/