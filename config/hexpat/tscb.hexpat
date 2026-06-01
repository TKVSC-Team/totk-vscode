#pragma pattern_limit 0x1000000

#include <std/io.pat>

// helpers because offsets are relative to the offset itself and bc it's fun to do this

struct String {
    char value[];
} [[inline]];

struct WString {
    char16 value[];
} [[inline]];

using RelOffset;

fn relocate(RelOffset o) {
    return o.value > 0 ? o.offset + o.value : 0;
};

fn format_offset(RelOffset o) {
    return std::format("{:#x} + {:#x} = {:#x}", o.offset, o.value, relocate(o));
};

struct RelOffset {
    u64 offset = $ [[hidden]];
    
    u32 value;
} [[transform("relocate"), format("format_offset")]];

struct RelPtr<T> {
    RelOffset offset;
    
    if (offset != 0) {
        T data @ offset [[inline]];
    }
};

// ok enough of fake stuff, these actually exist now

namespace agl {

enum ImageFormat : u8 {
    cNONE = 0,
    cR8 = 1,
    cR8UI = 2,
    cR8SN = 3,
    cR8I = 4,
    cR16 = 5,
    cR16UI = 6,
    cR16SN = 7,
    cR16I = 8,
    cR16F = 9,
    cRG8 = 10,
    cRG8UI = 11,
    cRG8SN = 12,
    cRG8I = 13,
    cRGB565 = 14,
    cA1BGR5 = 15,
    cRGBA4 = 16,
    cRGB5A1 = 17,
    cR32UI = 18,
    cR32I = 19,
    cR32F = 20,
    cRG16 = 21,
    cRG16UI = 22,
    cRG16SN = 23,
    cRG16I = 24,
    cRG16F = 25,
    cR11G11B10F = 26,
    cRGB10A2 = 27,
    cRGB10A2UI = 28,
    cRGBA8 = 29,
    cRGBA8UI = 30,
    cRGBA8SN = 31,
    cRGBA8I = 32,
    cRGBA8_SRGB = 33,
    cRGB10A2_1 = 34,
    cRGB10A2UI_1 = 35,
    cRG32UI = 36,
    cRG32I = 37,
    cRG32F = 38,
    cRGBA16 = 39,
    cRGBA16UI = 40,
    cRGBA16SN = 41,
    cRGBA16I = 42,
    cRGBA16F = 43,
    cRGBA32UI = 44,
    cRGBA32I = 45,
    cRGBA32F = 46,
    cRGBA_DXT1 = 47,
    cRGBA_DXT1_SRGB = 48,
    cRGBA_DXT3 = 49,
    cRGBA_DXT3_SRGB = 50,
    cRGBA_DXT5 = 51,
    cRGBA_DXT5_SRGB = 52,
    cRGTC1_UNORM = 53,
    cRGTC1_SNORM = 54,
    cRGTC2_UNORM = 55,
    cRGTC2_SNORM = 56,
    cBPTC_SFLOAT = 57,
    cBPTC_UFLOAT = 58,
    cBPTC_UNORM = 59,
    cBPTC_UNORM_SRGB = 60,
    cRGBA_ASTC_4x4 = 61,
    cRGBA_ASTC_4x4_SRGB = 62,
    cRGBA_ASTC_5x4 = 63,
    cRGBA_ASTC_5x4_SRGB = 64,
    cRGBA_ASTC_5x5 = 65,
    cRGBA_ASTC_5x5_SRGB = 66,
    cRGBA_ASTC_6x5 = 67,
    cRGBA_ASTC_6x5_SRGB = 68,
    cRGBA_ASTC_6x6 = 69,
    cRGBA_ASTC_6x6_SRGB = 70,
    cRGBA_ASTC_8x5 = 71,
    cRGBA_ASTC_8x5_SRGB = 72,
    cRGBA_ASTC_8x6 = 73,
    cRGBA_ASTC_8x6_SRGB = 74,
    cRGBA_ASTC_8x8 = 75,
    cRGBA_ASTC_8x8_SRGB = 76,
    cRGBA_ASTC_10x5 = 77,
    cRGBA_ASTC_10x5_SRGB = 78,
    cRGBA_ASTC_10x6 = 79,
    cRGBA_ASTC_10x6_SRGB = 80,
    cRGBA_ASTC_10x8 = 81,
    cRGBA_ASTC_10x8_SRGB = 82,
    cRGBA_ASTC_10x10 = 83,
    cRGBA_ASTC_10x10_SRGB = 84,
    cRGBA_ASTC_12x10 = 85,
    cRGBA_ASTC_12x10_SRGB = 86,
    cRGBA_ASTC_12x12 = 87,
    cRGBA_ASTC_12x12_SRGB = 88,
    cDEPTH16 = 89,
    cDEPTH32F = 90,
    cDEPTH24_STENCIL8 = 91,
    cDEPTH32F_STENCIL8 = 92,
};

} // namespace agl

namespace tera {

enum ResFileType : u32 {
    HeightMap = 0x0000,
    NormalMap = 0x0100,
    Material = 0x2000,
    Grass = 0x4000,
    Water = 0x4100,
    Bake = 0x5000,
};

enum DefFilterType : u32 {
    Linear = 0,
    Nearest = 1,
};

struct Color3f {
    float r;
    float g;
    float b;
};

struct Color4f : Color3f {
    float a;
};

bitfield ResImageFlags {
    Compressed : 1;
    Rearranged : 1;
    DeployFile : 1;
    RolledOut : 1;
    SizePreferential : 1;
    Residential : 1;
    AttachTmb : 1;
    AffectVertexPos : 1;
    Editable : 1;
    Reserve9 : 1;
    VSRefer : 1;
    padding : 21;
};

struct ResImageInfo {
    ResFileType type;
    u32 _04;
    u32 _08;
    u32 _0C;
    u16 width;
    u16 _12;
    u8 margin;
    u8 _15[0x3]; // might just be padding idk
    u32 mip_count;
    agl::ImageFormat format;
    u8 _1D[0x3]; // probably just padding
    u32 archive_level; // 2 bits
    DefFilterType def_filter_type; // bottom bit, 0 = linear, 1 = nearest
    u32 _28;
    u32 _2C;
    u32 dependency_count;
    u32 dependencies[3];
    Color4f clear_color;
    ResImageFlags flags;
    u32 _54;
    u32 _58;
    u32 _5C;
    RelPtr<String> name_offset;
    RelPtr<String> file_type_offset;
    RelPtr<WString> description_offset;
    RelPtr<String> extension_offset;
    u32 _70;
    u32 _74;
    u32 _78;
    u32 _7C;
};

struct ResMaterialInfo {
    u32 tex_index;
    u32 _04;
    u32 _08;
    u32 _0C;
    float u_scale;
    float v_scale;
    u32 _18;
    u32 _1C;
    float fabrication_micro;
    float fabrication_tiling;
    u32 _28;
    u32 height_correction;
    Color3f color;
    u32 _3C;
};

struct ResFile {
    ResFileType type;
    u32 _04;
    u32 _08;
    u32 _0C;
    u32 _10;
    u32 _14;
    u32 _18;
    u32 _1C;
    float min_height;
    float max_height;
    u32 _28;
    u32 _2C;
    u32 _30;
    u32 _34;
    u32 _38;
    u32 _3C;
};

struct ResFileArray<auto count> {
    RelOffset array_offset; // offset to the array below but imhex is not cooperating with array pointers
    RelPtr<ResFile> array[count];
};

struct ResArea {
    float x;
    float z;
    float scale;
    u32 _0C;
    u32 _10;
    u32 _14;
    u32 _18;
    u32 _1C;
    u32 file_count;
    u32 _24;
    u32 _28;
    u32 _2C;
    u32 _30;
    u32 _34;
    u32 _38;
    u32 _3C;
    u32 _40;
    u32 _44;
    u32 _48;
    u32 _4C;
    u32 _50;
    u32 _54;
    u32 _58;
    u32 _5C;
    RelPtr<String> filename_offset;
    ResFileArray<file_count> file_resources;
};

// the vast majority of this header is metadata that never changes between files
struct ResTerrainScene {
    char magic[4]; // TSCB
    // there is an alternative version with the TSCZ magic
    // the format is the same except the file data is a zstd compressed stream at 0x10
    u8 major_ver; // must be 0xc
    u8 minor_ver; // must be < 8
    padding[2];
    u32 is_little_endian; // 1 = little endian, anything else is treated as big endian
    RelOffset string_pool_offset;
    float world_scale;
    float height_scale;
    u32 _18;
    u32 _1C;
    u32 _20;
    u32 _24;
    u32 _28;
    u32 _2C;
    u32 image_info_count;
    u32 mat_info_count;
    u32 area_count;
    u32 knot_level;
    u32 _40;
    u32 _44;
    u32 _48;
    u32 _4C;
    float area_x;
    float area_z;
    float area_scale;
    u32 _5C;
    u32 _60;
    u32 _64;
    u32 _68;
    u32 _6C;
    RelOffset image_info_array_offset;
    RelOffset mat_info_array_offset;
    RelOffset area_array_offset;
    
    RelPtr<ResImageInfo> image_info[image_info_count] @ image_info_array_offset;
    RelPtr<ResMaterialInfo> mat_info_array[mat_info_count] @ mat_info_array_offset;
    RelPtr<ResArea> areas[area_count] @ area_array_offset;
} [[inline]];

} // namespace tera

tera::ResTerrainScene file @ 0x00;