#pragma eval_depth 0x1000
#pragma pattern_limit 0x100000

#include <std/array.pat>
#include <std/io.pat>
#include <std/mem.pat>
#include <std/sys.pat>

namespace nn {

namespace gfx {

enum ComparisonFunction : u8 {
    Never = 0,
    Less = 1,
    Equal = 2,
    LessEqual = 3,
    Greater = 4,
    NotEqual = 5,
    GreaterEqual = 6,
    Always = 7,
    End = 8,
};

} // namespace gfx

namespace util {

struct Float4 {
    float x;
    float y;
    float z;
    float w;
};

struct Float3 {
    float x;
    float y;
    float z;
};

struct Color4 {
    float r;
    float g;
    float b;
    float a;
};

struct BinaryFileHeader {
    char magic[8];
    u8 micro_ver;
    u8 minor_ver; // gfx api version in this case - 4
    u16 major_ver; // resource ver in this case - 0x33
    u16 byte_order_mark;
    u8 packed_alignment;
    u8 reserve;
    u32 filename_offset;
    u16 is_relocated; // particle files do not get relocated at runtime
    u16 first_block_offset;
    u32 relocation_table_offset;
    u32 file_size;
    
    char filename[] @ addressof(this) + filename_offset;
};

} // namespace util

namespace vfx2::detail {

struct ResPrimitive {
    u64 id;
    u32 vertex_count;
    u32 unknown[11];
    u32 index_count;
    u32 vertex_offset_0;
    u32 vertex_offset_1;
    u32 vertex_offset_2;
    u32 vertex_offset_3;
    u32 vertex_offset_4;
    u32 index_offset;
    
    if (vertex_offset_0) {
        util::Float4 vertex_buffer_0[vertex_count] @ addressof(this) + vertex_offset_0;
    }
    if (vertex_offset_1) {
        util::Float4 vertex_buffer_1[vertex_count] @ addressof(this) + vertex_offset_1;
    }
    if (vertex_offset_2) {
        util::Float4 vertex_buffer_2[vertex_count] @ addressof(this) + vertex_offset_2;
    }
    if (vertex_offset_3) {
        util::Float4 vertex_buffer_3[vertex_count] @ addressof(this) + vertex_offset_3;
    }
    if (vertex_offset_4) {
        util::Float4 vertex_buffer_4[vertex_count] @ addressof(this) + vertex_offset_4;
    }
    
    if (index_offset) {
        u32 index_buffer[index_count] @ addressof(this) + index_offset;
    }
};

struct ResG3dPrimitiveTableRecord {
    u64 id;
    u32 reserve0;
    u32 reserve1;
    u32 reserve2;
    u8 reserve3;
    u8 reserve4;
    u8 reserve5;
    u8 reserve6;
};

struct ResShaderInfo {
    u32 shader_count;
    u32 shader_size;
    std::Array<u8, shader_size> shaders[shader_count];;
};

struct ResEmitterSet {
    u8 reserve0;
    char emitter_set_name[0x60];
    u8 reserve1[0x44];
};

struct ShaderFlag {
    u32 reserve0;
    u32 reserve1;
    u32 field_flags; // presence of different behavior fields
};

struct ResTextureShaderFlags {
    float reserve0; // array layers from the corresponding texture get written here at runtime or something I think
    float reserve1;
    float reserve2;
    float reserve3;
    s32 reserve4[0x20];
};

struct ResTextureParams {
    u8 reserve0[0x20];
    float resereve1;
    float reserve2;
    u8 reserve3[0x18];
    float reserve4; // written to at runtime
    float reserve5; // written to at runtime
    float reserve6;
    float reserve7;
};

struct ResAnim8KeyParam {
    // the data here varies depending on the animation type
    // for color anims, these would be RGB
    // for alpha anims, x would be the alpha value and the rest would be empty
    float x;
    float y;
    float z;
    
    float key_frame;
};

struct ResParticleAnim {
    ResAnim8KeyParam base;
    ResAnim8KeyParam key_frames[7]; // seems that except for color/alpha anims, the first key is index 4 in this array
};

// taken from Splatoon 2 but it seems to match
enum ParticleType : u8 {
    Point                       = 0x0,
    Circle                      = 0x1,
    CircleEquallyDivided    = 0x2,
    CircleFile                  = 0x3,
    Sphere                      = 0x4,
    SphereEqually32Divided = 0x5,
    SphereEqually64Divided = 0x6,
    SphereFile                  = 0x7,
    Cylinder                    = 0x8,
    CylinderFill                = 0x9,
    Box                          = 0xA,
    BoxFill                      = 0xB,
    Line                          = 0xC,
    LineEquallyDivided        = 0xD,
    Rectangle                   = 0xE,
    Primitive                    = 0xF,
};

enum Sphere32DivideType : u8 {
    Two = 0x0,
    Three = 0x1,
    Four = 0x2,
    Six = 0x3,
    Eight = 0x4,
    Twelve = 0x5,
};

enum Sphere64DivideType : u8 {
    Twenty = 0x0,
    ThirtyTwo = 0x1,
};

struct ResEmitterVolume {
    ParticleType particle_type;
    u8 reserve0;
    u8 reserve1;
    Sphere32DivideType sphere_32_divide_type;
    Sphere64DivideType sphere_64_divide_type;
    u8 reserve2[3];
    float reserve3;
    float reserve4;
    float reserve5;
    float reserve6;
    float reserve7;
    float reserve8;
    float length; // unsure about this
    float size_x;
    float size_y;
    float size_z;
    u8 reserve9[8];
    s32 reserve10;
    s32 emission_type; // 1 seems to be a random multiplier for the number of particles, unsure about the rest
    u64 primitive_id;
    s32 reserve11;
    s32 reserve12;
    s32 reserve13;
    u32 reserve14;
};

struct ResRenderState {
    bool enable_blend;
    bool enable_depth_test;
    gfx::ComparisonFunction depth_comparison_function;
    bool enable_depth_write;
    u8 reserve0;
    u8 reserve1;
    u8 blend_factor_flag;
    u8 cull_mode; // 1 = back, 2 = front
};

struct ResTextureSamplerInfo {
    u64 texture_id;
    // not entirely sure about these
    u8 minor_index;
    u8 micro_index;
    u8 major_index;
    u8 reserve[13];
};

struct ResTextureFlags {
    u8 reserve0;
    u8 reserve1[3];
    u8 reserve2;
    u8 reserve3;
    u8 reserve4;
    u8 reserve5;
    u8 reserve6[8];
};

// this section is super massive
struct ResEmitter {
    u8 reserve0[0x10];
    char emitter_name[0x60];
    ShaderFlag shader_flag; // initialized at runtime
    u32 reserve1; // set to the u32 value at the start of the FCSF section at runtime
    u32 color0_anim_key_count;
    u32 alpha0_anim_key_count;
    u32 color1_anim_key_count;
    u32 alpha1_anim_key_count;
    u32 scale_anim_key_count;
    u32 unk_anim0_key_count;
    u32 unk_anim1_key_count;
    u32 unk_anim2_key_count;
    u32 unk_anim3_key_count;
    u32 unk_anim4_key_count;
    u32 unk_anim5_key_count;
    u8 reserve2[0x94];
    ResTextureShaderFlags texture_shader_flags[6];
    ResTextureParams texture_params[6];
    ResParticleAnim color0_anim;
    ResParticleAnim alpha0_anim;
    ResParticleAnim color1_anim;
    ResParticleAnim alpha1_anim;
    ResParticleAnim scale_anim;
    ResParticleAnim unk_anim0;
    ResParticleAnim unk_anim1;
    ResParticleAnim unk_anim2;
    ResParticleAnim unk_anim3;
    ResParticleAnim unk_anim4;
    ResParticleAnim unk_anim5;
    u8 reserve3[0x10];
    float reserve4[0x24];
    u8 reserve5[4];
    bool use_random_seed;
    bool reserve6;
    u8 reserve7[10];
    u32 random_seed;
    u8 reserve8[0xdc];
    ResEmitterVolume emitter_volume;
    ResRenderState render_state;
    u8 reserve9[9];
    bool has_trimming_primitive;
    u8 reserve10[14];
    s32 reserve11;
    s32 reserve12;
    u8 reserve13[8];
    u64 g3d_primitive_id;
    u64 trimming_primitive_id;
    u8 reserve14[8];
    u16 reserve15[4];
    u8 reserve16[8];
    bool color0_anim_no_interpolate;
    bool alpha0_anim_no_interpolate;
    bool color1_anim_no_interpolate;
    bool alpha1_anim_no_interpolate;
    bool scale_anim_no_interpolate;
    bool unk_anim0_no_interpolate;
    bool unk_anim1_no_interpolate;
    bool unk_anim2_no_interpolate;
    bool unk_anim3_no_interpolate;
    bool unk_anim4_no_interpolate;
    bool unk_anim5_no_interpolate;
    u8 reserve17[13];
    u32 reserve18;
    u32 shader_default_index;
    u32 shader_pass1_index;
    u32 shader_pass2_index;
    u32 shader_compute_default_index;
    u32 shader_compute_pass1_index;
    u32 shader_compute_pass2_index;
    u8 reserve19[0xd0];
    // unsure what the types are, but it seems like 3 is const and 2 is not const?
    u8 color0_anim_type;
    u8 color1_anim_type;
    u8 alpha0_anim_type;
    u8 alpha1_anim_type;
    util::Color4 color0;
    util::Color4 color1;
    u8 reserve20[0x30];
    ResTextureSamplerInfo textures[6];
    ResTextureFlags texture_flags[6];
    u8 reserve21[0x40];
};

struct ResAnimEmitterKeyParamSet {
    u8 reserve0;
    bool no_loop;
    bool no_interpolate;
    u8 reserve1;
    u32 key_count;
    u32 reserve2;
    ResAnim8KeyParam key_frames[key_count];
};

struct ResFieldRandom {
    bool use_aggregate4;
    bool use_rand_func;
    u8 reserve0[2];
    float reserve1[3];
    s32 reserve2;
    float reserve3[10];
    u8 reserve4[12];
    u32 key_count;
    u32 reserve5;
    u8 reserve6[4];
    ResAnim8KeyParam keys[key_count];
};

struct BinaryData {
    char signature[4];
    u32 size;
    u32 subsection_offset;
    u32 next_section_offset;
    u32 next_subsection_offset;
    u32 section_offset;
    u32 reserve0;
    u32 reserve1;
    
    std::print("{:#08x}: {}", addressof(this), signature);
    
    // sometimes the offset is to a null section which then causes imhex to crash as just check if the signature is non-zero
    if (subsection_offset != 0xFFFFFFFF && std::mem::read_unsigned(addressof(this) + subsection_offset, 4)) {
        BinaryData subsection @ addressof(this) + subsection_offset;
    }
    if (next_section_offset != 0xFFFFFFFF && std::mem::read_unsigned(addressof(this) + next_section_offset, 4)) {
        BinaryData next_section @ addressof(this) + next_section_offset;
    }
    if (next_subsection_offset != 0xFFFFFFFF && std::mem::read_unsigned(addressof(this) + next_subsection_offset, 4)) {
        BinaryData next_subsection @ addressof(this) + next_subsection_offset;
    }
    
    match (signature) {
        // nn::gfx::ResTextureFile (BNTX), this section also serves as a container section for GTNT
        ("GRTF") : { util::BinaryFileHeader res_texture_file @ addressof(this) + section_offset; }
        // don't know what this section contains tbh
        ("GTNT"): { u8 reserve @ addressof(this) + section_offset; }
        // PRIM is for standard primitives, TRIM is for trimming primitives
        // Primitive/trimming primitive array, just the container for PRIM/TRIM sections
        ("PRMA" | "TRMA"): {}
        ("PRIM" | "TRIM") : { ResPrimitive primitive @ addressof(this) + section_offset; }
        // nn::g3d2::ResFile (BFRES), this section also serves as a container section for G3NT
        ("G3PR"): { util::BinaryFileHeader res_file @ addressof(this) + section_offset; }
        // stores a G3d primitive
        ("G3NT"): { ResG3dPrimitiveTableRecord res_g3d_primitive_table_record @ addressof(this) + section_offset; }
        // Shader array, serves as a container for GRSR, GRRI, GRRE, GRCI, or GRCE sections
        ("GRSN"): {}
        // nn::gfx::ResShaderFile (BNSH), GRSR is for regular shaders, GRSC is for compute shaders
        ("GRSR" | "GRSC"): { util::BinaryFileHeader res_shader @ addressof(this) + section_offset; } 
        // GRRI is only found in the static ptcl file and serves as a global registry of all ptcl shaders
        // GRRE is for shaders used in that specific file, each shader must match one found in the GRRI section of the static ptcl
        // GRCI is identical to GRRI except it is for compute shaders instead
        // GRCE is identical to GRRE except it is for compute shaders instead
        ("GRRI" | "GRRE" | "GRCI" | "GRCE") : { ResShaderInfo shaders @ addressof(this) + section_offset; }
        // Emitter set array, container fo ESET sections
        ("ESTA"): {}
        // Emitter set, an array of emitters and their respective data sections
        ("ESET"): { ResEmitterSet emitter_set @ addressof(this) + section_offset; }
        // Emitter, contains many data sections for things such as behavior fields and animations
        ("EMTR"): { ResEmitter emitter @ addressof(this) + section_offset; }
        // Emitter animations, honestly no idea what each of these are
        ("EAES" | "EAER" | "EAET" | "EAC0" | "EAC1" | "EATR" | "EAPL" | "EAA0" | "EAA1" | "EAOV" | "EADV" | "EASL" | "EASS" | "EAGV"):
            { ResAnimEmitterKeyParamSet animation @ addressof(this) + section_offset; }
        // Don't know what these sections are for yet
        ("CSDP" | "CAPD" | "CUPD") : {}
        // Random fields (unsure of the difference)
        ("FRND" | "FRN1") : { ResFieldRandom field @ addressof(this) + section_offset; }
        // Other behavior fields
        // FMAG is magnetic field
        // FCOL is collision field
        // FCOV is convergence field
        // FCLN is curl noise field
        ("FMAG" | "FSPN" | "FCOL" | "FCOV" | "FPAD" | "FCLN" | "FGWD" | "FCSF") : {}
        // Unsure what these are for but it seems they're related to the stripe system somehow
        ("EP01" | "EP02" | "EP03" | "EP04") : {}
    }
};

struct ResParticle : util::BinaryFileHeader {
    std::assert(magic == "VFXB    ", std::format("Invalid file magic: {}", magic));
    std::assert(minor_ver == 4, std::format("Invalid graphics API version, expected 4: {:d}", minor_ver));
    std::assert(major_ver == 0x33, std::format("Invalid resource version, expected 0x33: {:#02x}", major_ver));
    
    BinaryData data @ addressof(this) + first_block_offset;
};

} // namespace vfx::detail

} // namespace nn

nn::vfx2::detail::ResParticle file @ 0x00;