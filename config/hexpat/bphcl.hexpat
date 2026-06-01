#include <std/mem.pat>
#include <std/core.pat>
#include <std/io.pat>
#include <std/string.pat>
#include <std/sys.pat>

// phive wrapper stuff

enum ResFileType : u8 {
    Shape           = 0,
    NavMesh         = 1,
    StaticCompound  = 2,
    Cloth           = 3,
};

struct ResPhive {
    char magic[6]; // Phive
    u8 reserve0;
    u8 reserve1;
    u16 byte_order_mark;
    ResFileType file_type;
    u8 max_section_capacity;
    u32 tagfile_offset;
    u32 param_offset;
    u32 file_end_offset;
    u32 tagfile_size;
    u32 param_size;
    u32 file_end_size; // ik this doesn't really make sense, but consistency
};

ResPhive file @ 0x00;

// cloth param

enum ResParamType : u8 {
    Bool = 0,
    F32,
    Int,
    Vec2,
    Vec3,
    Vec4,
    Color,
    String32,
    String64,
    Curve1,
    Curve2,
    Curve3,
    Curve4,
    BufferInt,
    BufferF32,
    String256,
    Quat,
    U32,
    BufferU32,
    BufferBinary,
    StringRef,
};

bitfield ResParameterFlags {
    offset : 24;
    ResParamType type : 8;
};

struct Vector2f {
    float x;
    float y;
};

struct Vector3f {
    float x;
    float y;
    float z;
};

struct Vector4f {
    float x;
    float y;
    float z;
    float w;
};

struct Color4f {
    float r;
    float g;
    float b;
    float a;
};

struct Quatf {
    float a;
    float b;
    float c;
    float d;
};

struct Curve {
    u32 a;
    u32 b;
    float floats[30];
};

struct Buffer<T> {
    u32 count;
    T values[count];
};

struct ResParameter {
    u32 name_hash;
    ResParameterFlags flags;

    match (flags.type) {
        (ResParamType::Bool) : { bool value @ addressof(this) + flags.offset * 4; }
        (ResParamType::F32) : { float value @ addressof(this) + flags.offset * 4; }
        (ResParamType::Int) : { s32 value @ addressof(this) + flags.offset * 4; }
        (ResParamType::Vec2) : { Vector2f value @ addressof(this) + flags.offset * 4; }
        (ResParamType::Vec3) : { Vector3f value @ addressof(this) + flags.offset * 4; }
        (ResParamType::Vec4) : { Vector4f value @ addressof(this) + flags.offset * 4; }
        (ResParamType::Color) : { Color4f value @ addressof(this) + flags.offset * 4; }
        (ResParamType::String32) : { char value[32] @ addressof(this) + flags.offset * 4; }
        (ResParamType::String64) : { char value[64] @ addressof(this) + flags.offset * 4; }
        (ResParamType::Curve1) : { Curve value[1] @ addressof(this) + flags.offset * 4; }
        (ResParamType::Curve2) : { Curve value[2] @ addressof(this) + flags.offset * 4; }
        (ResParamType::Curve3) : { Curve value[3] @ addressof(this) + flags.offset * 4; }
        (ResParamType::Curve4) : { Curve value[4] @ addressof(this) + flags.offset * 4; }
        (ResParamType::BufferInt) : { Buffer<s32> value @ addressof(this) + flags.offset * 4 - 4; }
        (ResParamType::BufferF32) : { Buffer<float> value @ addressof(this) + flags.offset * 4 - 4; }
        (ResParamType::String256) : { char value[256] @ addressof(this) + flags.offset * 4; }
        (ResParamType::Quat) : { Quatf value @ addressof(this) + flags.offset * 4; }
        (ResParamType::U32) : { u32 value @ addressof(this) + flags.offset * 4; }
        (ResParamType::BufferU32) : { Buffer<u32> value @ addressof(this) + flags.offset * 4 - 4; }
        (ResParamType::BufferBinary) : { Buffer<u8> value @ addressof(this) + flags.offset * 4 - 4; }
        (ResParamType::StringRef) : { char value[] @ addressof(this) + flags.offset * 4; }
    }
};

bitfield ResFlags {
    offset : 16;
    count : 16;
};

struct ResParamObj {
    u32 name_hash;
    ResFlags flags;

    ResParameter child_params[flags.count] @ addressof(this) + flags.offset * 4;
};

struct ResParamList {
    u32 name_hash;
    ResFlags child_list_flags;
    ResFlags child_obj_flags;

    ResParamList child_lists[child_list_flags.count] @ addressof(this) + child_list_flags.offset * 4;
    ResParamObj child_objects[child_obj_flags.count] @ addressof(this) + child_obj_flags.offset * 4;
};

struct ResParameterArchive {
    char magic[4]; // AAMP (little endian) or PMAA (big endian)
    u32 version;
    u32 flags; // not really an aamp-focused hexpat so we'll just assume little endian
    u32 file_size;
    u32 param_io_version;
    u32 param_io_offset;
    u32 list_count;
    u32 object_count;
    u32 param_count;
    u32 data_size;
    u32 string_pool_size;
    u32 reserve;
    char param_io_type[];

    ResParamList param_io @ addressof(this) + 0x30 + param_io_offset;
};

ResParameterArchive cloth_param @ file.param_offset;

// tagfile stuff

fn section_from_slice(str name, u128 start, u128 size) {
    std::mem::Section section = std::mem::create_section(name);
    u8 data[size] @ start;
    std::mem::set_section_size(section, size);
    std::mem::copy_value_to_section(data, section, 0x0);
    return section;
};

struct String {
    char string[];
} [[inline]];

fn find_section(u128 start, u128 end, auto ... bytes) {
    return std::mem::find_sequence_in_range(0, start, end + 1, bytes) - 4;
};

using VarUInt;

fn read_varuint(VarUInt i) {
    if (i.byte0 & 0x80 == 0) {
        return i.byte0;
    }
    match (i.byte0 >> 3) {
        (0x10 ... 0x17):
            return ((i.byte0 << 8) | i.bytes[0]) & 0x3FFF;
        (0x18 ... 0x1B):
            return (
                (i.byte0 << 16) |
                (i.bytes[0] << 8) |
                i.bytes[1]
            ) & 0x1FFFFF;
        (0x1C):
            return (
               ( i.byte0 << 24 ) |
               ( i.bytes[0] << 16 ) |
               ( i.bytes[1] << 8 ) |
               i.bytes[2]
            ) & 0x7FFFFFF;
        (0x1D):
            return (
                ( i.byte0 << 32 ) |
                ( i.bytes[0] << 24 ) |
                ( i.bytes[1] << 16 ) |
                ( i.bytes[2] << 8 ) |
                i.bytes[3]
            )  & 0x7FFFFFFFFFFFFFF;
        (0x1E):
            return ( ( i.byte0 << 56 ) |
                ( i.bytes[0] << 48 ) |
                ( i.bytes[1] << 40 ) |
                ( i.bytes[2] << 32 ) |
                ( i.bytes[3] << 24 ) |
                ( i.bytes[4] << 16 ) |
                ( i.bytes[5] << 8 ) |
                i.bytes[6]
            ) & 0x7FFFFFFFFFFFFFF;
        (0x1F):
            return ( i.byte0 & 7 ) == 0
                ? (
                  ( i.byte0 << 40 ) |
                  ( i.bytes[0] << 32 ) |
                  ( i.bytes[1] << 24 ) |
                  ( i.bytes[2] << 16 ) |
                  ( i.bytes[3] << 8 ) |
                  i.bytes[4]
                ) & 0xFFFFFFFFFF
                :
                  ( i.byte0 & 7 ) == 1
                  ? (
                     i.bytes[0] << 56 ) |
                     ( i.bytes[1] << 48 ) |
                     ( i.bytes[2] << 40 ) |
                     ( i.bytes[3] << 32 ) |
                     ( i.bytes[4] << 24 ) |
                     ( i.bytes[5] << 16 ) |
                     ( i.bytes[6] << 8 ) |
                     i.bytes[7]
                  : 0;
    }
};

fn format_varuint(VarUInt i) {
    return std::format("{}", i);
};

struct VarUInt {
    u8 byte0;
    if (byte0 & 0x80 != 0) {
        match (byte0 >> 3) {
            (0x10 ... 0x17) : u8 bytes[1];
            (0x18 ... 0x1B) : u8 bytes[2];
            (0x1C) : u8 bytes[3];
            (0x1D) : u8 bytes[4];
            (0x1E) : u8 bytes[7];
            (0x1F) : u8 bytes[13];
        }
    }
} [[single_color, sealed, transform("read_varuint"), format("format_varuint")]];

using ResTagfileSectionHeader;

fn format_section(auto header) {
    return header.signature;
};

fn format_name(auto t) {
    return t.name;
};

bitfield Size {
    is_chunk    :  2;
    size        : 30;
} [[bitfield_order(std::core::BitfieldOrder::MostToLeastSignificant, 32), inline]];

struct ResTagfileSectionHeader {
    be Size size;
    char signature[4];
} [[format("format_section")]];

struct ResTypeTemplate {
    VarUInt index;
    VarUInt value;

    str name = parent.parent.parent.parent.types.strings[index].string [[export]];

    if (name[0] == 't') {
        // value - 1 is the type index but this is in the middle of initializing the array so we can't access it yet
    }

} [[format("format_name")]];

struct ResNamedType {
    VarUInt index;
    VarUInt template_count;
    ResTypeTemplate templates[template_count];

    str name = parent.parent.parent.types.strings[index].string [[export]];
} [[format("format_name")]];

struct ResTypeBodyDeclaration {
    VarUInt name_index;
    VarUInt flags;
    if (flags >> 7 & 1) {
        u8 reserve; // << 0xc might be alignment?
    }
    VarUInt offset;
    VarUInt type_index;

    str name = parent.parent.parent.parent.fields.strings[name_index].string [[export]];
} [[format("format_name")]];

struct ResTypeBodyInterface {
    VarUInt type_index;
    VarUInt flags;
};

struct ResTypeBody {
    VarUInt type_index;
    if (type_index != 0) {
        VarUInt parent_type_index;
        VarUInt flags;

        if ((flags >> 0) & 1) {
            VarUInt format;
        }
        if ((flags >> 1) & 1) {
            VarUInt subtype_index;
        }
        if ((flags >> 2) & 1) {
            VarUInt version;
        }
        if ((flags >> 3) & 1) {
            VarUInt size;
            VarUInt alignment;
        }
        if ((flags >> 4) & 1) {
            VarUInt unknown_flags;
        }
        if ((flags >> 5) & 1) {
            VarUInt decl_count; // top 16 bits is the placeholder count
            ResTypeBodyDeclaration declarations[decl_count & 0xffff];
        }
        if ((flags >> 6) & 1) {
            VarUInt interface_count;
            ResTypeBodyInterface interfaces[internface_count];
        }
        if ((flags >> 7) & 1) {
            VarUInt attr_index;
            str attr = parent.parent.parent.attributes.strings[attr_index].string [[export]];
        }
    }
};

struct ResTypeHash {
    VarUInt type_index;
    u32 hash;
};

struct ResTypeSection : ResTagfileSectionHeader {
    match (signature) {
        ("TPTR" | "TPAD") : {
            /*
            TPTR is for storing pointers at runtime
            TPAD appears to quite literally just be padding
            */
            u8 pad[size.size - 8];
        }
        ("TST1" | "FST1" | "AST1" | "TSTR" | "FSTR" | "ASTR") : {
            // type, field, and attribute strings
            String strings[while($ < addressof(this) + size.size - 1)];
        }
        ("TNA1" | "TNAM") : {
            // type name info
            VarUInt type_count;
            ResNamedType types[type_count - 1];
        }
        ("TBDY" | "TBOD") : {
            // type body info (members, flags, etc.)
            ResTypeBody type_bodies[while($ < addressof(this) + size.size - 1)];
        }
        ("THSH") : {
            // type hashes (checked against the registry at runtime)
            VarUInt hash_count;
            ResTypeHash hashes[hash_count];
        }
        ("TSHA" | "TPRO" | "TPHS" | "TSEQ") : {
            std::assert_warn(false, std::format("Unsupported section: {}", signature));
        }
        (_) : {
            std::error(std::format("Invalid section signature: {}", signature));
        }
    }
    $ = addressof(this) + size.size;
};

struct ResItem {
    u32 flags;
    u32 type_index = flags & 0xffffff [[export]];
    u32 data_offset;
    u32 count;

    // u8 data @ data_offset + parent.parent.parent.data_offset;
};

struct ResPatch {
    u32 type_index;
    u32 count;
    u32 offsets[count];

    /*
    patches are performed by going to each of the offsets in the data section and reading the u32 value there
    that u32 value is an index into the items array the pointer is pointing at
    */
};

struct ResIndexSection : ResTagfileSectionHeader {
    match (signature) {
        ("ITEM") : {
            ResItem items[while($ < addressof(this) + size.size - 1)];
        }
        ("PTCH") : {
            ResPatch internal_patches[while(std::mem::read_unsigned($, 4, std::mem::Endian::Little))];
            u32 terminator; // 4 null bytes
            ResPatch external_patches[while($ < addressof(this) + size.size - 1)];
        }
    }
    $ = addressof(this) + size.size;
};

struct ResSection : ResTagfileSectionHeader {
    match (signature) {
        ("SDKV") : { char version[8]; }
        ("DATA") : { u8 data[size.size - 8] [[hidden]]; }
        ("TYPE") : { ResTypeSection sections[while($ < addressof(this) + size.size - 1)] [[inline]]; }
        ("INDX") : { ResIndexSection sections[while($ < addressof(this) + size.size - 1)] [[inline]]; }
        ("TCRF" | "TCID") : { std::error("Compendium sections are not supported"); }
    }
    $ = addressof(this) + size.size;
};

struct ResTagfile : ResTagfileSectionHeader {
    std::assert(signature == "TAG0", std::format("{} is not a valid tagfile signature, expected TAG0", signature));
    
    u128 data_offset = find_section(addressof(this), addressof(this) + size.size, 'D', 'A', 'T', 'A') + 8;
    u32 data_size = std::mem::read_unsigned(data_offset - 8, 4, std::mem::Endian::Big) & 0x3fffffff - 8;

    s128 offset = find_section(addressof(this), addressof(this) + size.size, 'T', 'S', 'T', '1');
    if (offset >= 0) {
        ResTypeSection types @ offset [[hidden]];
    } else {
        ResTypeSection types @ find_section(addressof(this), addressof(this) + size.size, 'T', 'S', 'T', 'R') [[hidden]];
    }
    offset = find_section(addressof(this), addressof(this) + size.size, 'F', 'S', 'T', '1');
    if (offset >= 0) {
        ResTypeSection fields @ offset [[hidden]];
    } else {
        ResTypeSection fields @ find_section(addressof(this), addressof(this) + size.size, 'F', 'S', 'T', 'R') [[hidden]];
    }
    offset = find_section(addressof(this), addressof(this) + size.size, 'A', 'S', 'T', '1');
    if (offset >= 0) {
        ResTypeSection attributes @ offset [[hidden]];
    } else {
        offset = find_section(addressof(this), addressof(this) + size.size, 'A', 'S', 'T', 'R');
        if (offset >= 0) {
            ResTypeSection attributes @ find_section(addressof(this), addressof(this) + size.size, 'A', 'S', 'T', 'R') [[hidden]];
        }
    }

    ResSection sections[while($ < addressof(this) + size.size)] [[inline]];
};

ResTagfile tagfile @ file.tagfile_offset;

// hcl structs + data section patches

fn get_section_index(str magic, s32 index = -1) {
    if (index == -1) {
        for (u8 i = 0, i < std::core::member_count(tagfile.sections), i = i + 1) {
            if (tagfile.sections[i].signature == magic) {
                return i;
            }
        }
    } else {
        for (u8 i = 0, i < std::core::member_count(tagfile.sections[index].sections), i = i + 1) {
            if (tagfile.sections[index].sections[i] == magic) {
                return i;
            }
        }
    }
    return -1;
};

fn get_type_name_section_index() {
    for (u8 i = 0, i < std::core::member_count(tagfile.sections[type_section_index].sections), i = i + 1) {
        if (tagfile.sections[type_section_index].sections[i].signature == "TNA1"
            || tagfile.sections[type_section_index].sections[i].signature == "TNAM") {
                return i;
            }
    }
    return -1;
};

fn get_type_name(auto index) {
    return tagfile.sections[type_section_index].sections[type_name_index].types[index - 1].name;
};

std::mem::Section data = section_from_slice("Data", tagfile.data_offset, tagfile.data_size);

const str array = "hkArray";

fn inplace_fixup(u32 offset, u32 type_index) {
    u32 index @ offset in data;
    if (type_index > 0) {
        // there may be other types where this is relevant but this is the only one I saw so far
        if (std::string::starts_with(get_type_name(type_index), "hkArray")) {
            s32 size @ offset + 8 in data;
            size = tagfile.sections[index_section_index].sections[item_section_index].items[index].count;
        }
    }
    const u64 addr = tagfile.sections[index_section_index].sections[item_section_index].items[index].data_offset - offset;
    u64 ptr @ offset in data;
    ptr = addr;
    // std::print(std::format("Patching {:#08x} at {:#08x}", ptr, offset));
};

fn read_ptr(auto t) {
    u64 ptr @ t.offset - tagfile.data_offset in data;
    return ptr;
};

fn read_int(auto t) {
    s32 val @ t.offset - tagfile.data_offset in data;
    return val;
};

const u8 type_section_index = get_section_index("TYPE");
const u8 type_name_index = get_section_index("TNAM", type_section_index) != -1 ? get_section_index("TNAM", type_section_index) : get_section_index("TNA1", type_section_index);
const u8 index_section_index = get_section_index("INDX");
const u8 item_section_index = get_section_index("ITEM", index_section_index);
const u8 ptch_section_index = get_section_index("PTCH", index_section_index);

// handle relocations
if (ptch_section_index != -1) {
    for (u32 i = 0, i < std::core::member_count(tagfile.sections[index_section_index].sections[ptch_section_index].internal_patches), i = i + 1) {
        for (u32 j = 0, j < std::core::member_count(tagfile.sections[index_section_index].sections[ptch_section_index].internal_patches[i].offsets), j = j + 1) {
            inplace_fixup(tagfile.sections[index_section_index].sections[ptch_section_index].internal_patches[i].offsets[j],
                            tagfile.sections[index_section_index].sections[ptch_section_index].internal_patches[i].type_index);
        }
    }
}

fn format_ptr(auto ptr) {
    return std::format("{:#08x}", ptr);
};

fn format_int(auto val) {
    return std::format("{:d}", val);
};

fn format_string(auto string) {
    return std::format("{}", string._str);
};

struct Ptr {
    u64 value;
    
    u64 offset = addressof(this); // hack bc addressof() doesn't work properly in the transform func
} [[sealed, transform("read_ptr"), format("format_ptr")]];

struct hkRefPtr<T> {
    std::mem::AlignTo<0x8>;
    u64 _offset = $;
    Ptr m_ptr;

    T m_data @ _offset + m_ptr;
};

struct Int {
    s32 value;

    u64 offset = addressof(this);
} [[sealed, transform("read_int"), format("format_int")]];

struct hkArray<T> {
    std::mem::AlignTo<0x8>;
    u64 _offset = $;
    Ptr offset;
    Int m_size;
    s32 m_capacityAndFlags;

    T m_data[m_size] @ _offset + offset;
};

struct hkBitFieldStorage {
    hkArray<u32> m_words;
    s32 m_numBits;
};

struct hkBitField {
    hkBitFieldStorage m_storage;
};

struct hkStringPtr {
    std::mem::AlignTo<0x8>;
    u64 _offset = $;
    Ptr m_stringAndFlag;

    char string[] @ _offset + m_stringAndFlag;
    str _str = string; // it doesn't like the char[] string views for some reason so we do this
} [[format("format_string")]];

struct hkRefVariant {
    std::mem::AlignTo<0x8>;
    Ptr m_ptr;
};

struct hkRootLevelContainer__NamedVariant {
    std::mem::AlignTo<0x8>;
    hkStringPtr m_name;
    hkStringPtr m_className;
    hkRefVariant m_variant;
};

struct hkRootLevelContainer {
    std::mem::AlignTo<0x8>;
    hkArray<hkRootLevelContainer__NamedVariant> m_namedVariants;
};

hkRootLevelContainer root_container @ tagfile.data_offset;

u128 cloth_offset = 0;
u128 resource_offset = 0;
u128 animation_offset = 0;

for (u32 i = 0, i < root_container.m_namedVariants.m_size, i = i + 1) {
    if (root_container.m_namedVariants.m_data[i].m_className == "hclClothContainer") {
        cloth_offset = addressof(root_container.m_namedVariants.m_data[i].m_variant) + root_container.m_namedVariants.m_data[i].m_variant.m_ptr;
    } else if (root_container.m_namedVariants.m_data[i].m_className == "hkMemoryResourceContainer") {
        resource_offset = addressof(root_container.m_namedVariants.m_data[i].m_variant) + root_container.m_namedVariants.m_data[i].m_variant.m_ptr;
    } else if (root_container.m_namedVariants.m_data[i].m_className == "hkaAnimationContainer") {
        animation_offset = addressof(root_container.m_namedVariants.m_data[i].m_variant) + root_container.m_namedVariants.m_data[i].m_variant.m_ptr;
    }
}

struct hkObjectBase {
    u64 _vft_reserve;
};

struct hkReferencedObject : hkObjectBase {
    std::mem::AlignTo<0x8>;
    u64 m_sizeAndFlags;
    u64 m_refCount;
};

struct hkVector4f {
    float m_x;
    float m_y;
    float m_z;
    float m_w;
};

struct hkQuaternionf {
    std::mem::AlignTo<0x10>;
    hkVector4f m_vec;
};

struct hkRotationf {
    std::mem::AlignTo<0x10>;
    hkVector4f m_col0;
    hkVector4f m_col1;
    hkVector4f m_col2;
};

struct hkMatrix4f {
    std::mem::AlignTo<0x10>;
    hkVector4f m_col0;
    hkVector4f m_col1;
    hkVector4f m_col2;
    hkVector4f m_col3;
};

struct hkTransform {
    hkRotationf m_rotation;
    hkVector4f m_translation;
};

struct hkQsTransformf {
    std::mem::AlignTo<0x10>;
    hkVector4f m_translation;
    hkQuaternionf m_rotation;
    hkVector4f m_scale;
};

struct hclShape : hkReferencedObject {
    s32 m_type;
};

struct hclCollidable : hkReferencedObject {
    hkTransform m_transform;
    hkVector4f m_linearVelocity;
    hkVector4f m_angularVelocity;
    u64 m_userData;
    hkRefPtr<hclShape> m_shape;
    hkStringPtr m_name;
    float m_pinchDetectionRadius;
    u8 m_pinchDetectionPriority;
    bool m_pinchDetectionEnabled;
    bool m_virtualCollisionPointCollisionEnabled;
    bool m_enabled;
};

struct hclSimClothData__OverridableSimulationInfo {
    std::mem::AlignTo<0x10>;
    hkVector4f m_gravity;
    float m_globalDampingPerSecond;
    padding[0xc];
};

struct hclSimClothData__ParticleData {
    float m_mass;
    float m_invMass;
    float m_radius;
    float m_friction;
};

struct hclSimClothPose : hkReferencedObject {
    hkStringPtr m_name;
    hkArray<hkVector4f> m_positions;
};

struct hclConstraintSet : hkReferencedObject {
    hkStringPtr m_name;
    u32 m_constraintId;
    u32 m_type;
};

struct hclSimClothData__CollidableTransformMap {
    u32 m_transformSetIndex;
    hkArray<u32> m_transformIndices;
    hkArray<hkMatrix4f> m_offsets;
};

struct hclAction : hkReferencedObject {
    bool m_active;
    bool m_registeredWithWorldStepping;
};

struct hclSimClothData__TransferMotionData {
    std::mem::AlignTo<0x4>;
    u32 m_transformSetIndex;
    u32 m_transformIndex;
    bool m_transferTranslationMotion;
    std::mem::AlignTo<0x4>;
    float m_minTranslationSpeed;
    float m_maxTranslationSpeed;
    float m_minTranslationBlend;
    float m_maxTranslationBlend;
    bool m_transferRotationMotion;
    std::mem::AlignTo<0x4>;
    float m_minRotationSpeed;
    float m_maxRotationSpeed;
    float m_minRotationBlend;
    float m_maxRotationBlend;
};

struct hclSimClothData__LandscapeCollisionData {
    std::mem::AlignTo<0x4>;
    float m_landscapeRadius;
    bool m_enableStuckParticleDetection;
    std::mem::AlignTo<0x4>;
    float m_stuckParticlesStretchFactorSq;
    bool m_pinchDetectionEnabled;
    u8 m_pinchDetectionPriority;
    std::mem::AlignTo<0x4>;
    float m_pinchDetectionRadius;
    float m_collisionTolerance;
};

struct hclSimClothData__CollidablePinchingData {
    std::mem::AlignTo<0x4>;
    bool m_pinchDetectionEnabled;
    u8 m_pinchDetectionPriority;
    std::mem::AlignTo<0x4>;
    float m_pinchDetectionRadius;
};

struct hclVirtualCollisionPointsData__Block {
    std::mem::AlignTo<0x4>;
    float m_safeDisplacementRadius;
    u16 m_startingVCPIndex;
    u8 m_numVCPs;
};

struct hclVirtualCollisionPointsData__BarycentricDictionaryEntry {
    std::mem::AlignTo<0x2>;
    u16 m_startingBarycentricIndex;
    u8 m_numBarycentrics;
};

struct hclVirtualCollisionPointsData__TriangleFanSection {
    std::mem::AlignTo<0x2>;
    u16 m_oppositeRealParticleIndices[2];
    u16 m_barycentricDictionaryIndex;
};

struct hclVirtualCollisionPointsData__TriangleFan {
    std::mem::AlignTo<0x2>;
    u16 m_realParticleIndex;
    u16 m_vcpStartIndex;
    u8 m_numTriangles;
};

struct hclVirtualCollisionPointsData__TriangleFanLandscape {
    std::mem::AlignTo<0x2>;
    u16 m_realParticleIndex;
    u16 m_triangleStartIndex;
    u16 m_vcpStartIndex;
    u8 m_numTriangles;
};

struct hclVirtualCollisionPointsData__EdgeFanSection {
    std::mem::AlignTo<0x2>;
    u16 m_oppositeRealParticleIndex;
    u16 m_barycentricDictionaryIndex;
};

struct hclVirtualCollisionPointsData__EdgeFan {
    std::mem::AlignTo<0x2>;
    u16 m_realParticleIndex;
    u16 m_edgeStartIndex;
    u8 m_numEdges;
};

struct hclVirtualCollisionPointsData__EdgeFanLandscape {
    std::mem::AlignTo<0x2>;
    u16 m_realParticleIndex;
    u16 m_edgeStartIndex;
    u16 m_vcpStartIndex;
    u8 m_numEdges;
};

struct hclVirtualCollisionPointsData__BarycentricPair {
    std::mem::AlignTo<0x4>;
    float m_u;
    float m_v;
};

struct hclVirtualCollisionPointsData {
    hkArray<hclVirtualCollisionPointsData__Block> m_blocks;
    u16 m_numVCPoints;
    hkArray<u16> m_landscapeParticlesBlockIndex;
    u16 m_numLandscapeVCPoints;
    hkArray<float> m_edgeBarycentricsDictionary;
    hkArray<hclVirtualCollisionPointsData__BarycentricDictionaryEntry> m_edgeDictionaryEntries;
    hkArray<hclVirtualCollisionPointsData__BarycentricPair> m_triangleBarycentricsDictionary;
    hkArray<hclVirtualCollisionPointsData__BarycentricDictionaryEntry> m_triangleDictionaryEntries;
    hkArray<hclVirtualCollisionPointsData__EdgeFanSection> m_edges;
    hkArray<hclVirtualCollisionPointsData__EdgeFan> m_edgeFans;
    hkArray<hclVirtualCollisionPointsData__TriangleFanSection> m_triangles;
    hkArray<hclVirtualCollisionPointsData__TriangleFan> m_triangleFans;
    hkArray<hclVirtualCollisionPointsData__EdgeFanSection> m_edgesLandscape;
    hkArray<hclVirtualCollisionPointsData__EdgeFanLandscape> m_edgeFansLandscape;
    hkArray<hclVirtualCollisionPointsData__TriangleFanSection> m_trianglesLandscape;
    hkArray<hclVirtualCollisionPointsData__TriangleFanLandscape> m_triangleFansLandscape;
    hkArray<u16> m_edgeFanIndices;
    hkArray<u16> m_triangleFanIndices;
    hkArray<u16> m_edgeFanIndicesLandscape;
    hkArray<u16> m_triangleFanIndicesLandscape;
};

struct hclSimClothData : hkReferencedObject {
    hkStringPtr m_name;
    hclSimClothData__OverridableSimulationInfo m_simulationInfo;
    hkArray<hclSimClothData__ParticleData> m_particleDatas;
    hkArray<u16> m_fixedParticles;
    bool m_doNormals;
    hkArray<u32> m_simOpIds;
    hkArray<hkRefPtr<hclSimClothPose>> m_simClothPoses;
    hkArray<hkRefPtr<hclConstraintSet>> m_staticConstraintSets;
    hkArray<hkRefPtr<hclConstraintSet>> m_antiPinchConstraintSets;
    hclSimClothData__CollidableTransformMap m_collidableTransformMap;
    hkArray<hkRefPtr<hclCollidable>> m_perInstanceCollidables;
    float m_maxParticleRadius;
    hkArray<u32> m_staticCollisionMasks;
    hkArray<hkRefPtr<hclAction>> m_actions;
    float m_totalMass;
    hclSimClothData__TransferMotionData m_transferMotionData;
    bool m_transferMotionEnabled;
    bool m_landscapeCollisionEnabled;
    hclSimClothData__LandscapeCollisionData m_landscapeCollisionData;
    u32 m_numLandscapeCollidableParticles;
    hkArray<u16> m_triangleIndices;
    hkArray<u8> m_triangleFlips;
    bool m_pinchDetectionEnabled;
    hkArray<bool> m_perParticlePinchDetectionEnabledFlags;
    hkArray<hclSimClothData__CollidablePinchingData> m_collidablePinchingDatas;
    u16 m_minPinchedParticleIndex;
    u16 m_maxPinchedParticleIndex;
    u32 m_maxCollisionPairs;
    hclVirtualCollisionPointsData m_virtualCollisionPointsData;
};

enum hclRuntimeConversionInfo__VectorConversion : u8 {
    VC_FLOAT4 = 0x0,
    VC_FLOAT3 = 0x1,
    VC_BYTE4 = 0x2,
    VC_SHORT3 = 0x3,
    VC_HFLOAT3 = 0x4,
    VC_SBYTE4 = 0x5,
    VC_CUSTOM_A = 0x14,
    VC_CUSTOM_B = 0x15,
    VC_CUSTOM_C = 0x16,
    VC_CUSTOM_D = 0x17,
    VC_CUSTOM_E = 0x18,
    VC_MAX_NUM = 0x20,
    VC_NONE = 0xfa,
};

struct hclBufferLayout__BufferElement {
    hclRuntimeConversionInfo__VectorConversion m_vectorConversion;
    u8 m_vectorSize;
    u8 m_slotId;
    u8 m_slotStart;
};

enum hclBufferLayout__SlotFlags : u8 {
    SF_NO_ALIGNED_START = 0x0,
    SF_16BYTE_ALIGNED_START = 0x1,
    SF_64BYTE_ALIGNED_START = 0x3,
};

struct hclBufferLayout__Slot {
    hclBufferLayout__SlotFlags m_flags;
    u8 m_stride;
};

enum hclBufferLayout__TriangleFormat : u8 {
    TF_THREE_INT32S = 0x0,
    TF_THREE_INT16S = 0x1,
    TF_OTHER = 0x2,
};

struct hclBufferLayout {
    hclBufferLayout__BufferElement m_elementsLayout[4];
    hclBufferLayout__Slot m_slots[4];
    u8 m_numSlots;
    hclBufferLayout__TriangleFormat m_triangleFormat;
};

struct hclBufferDefinition : hkReferencedObject {
    hkStringPtr m_meshName;
    hkStringPtr m_bufferName;
    s32 m_type;
    s32 m_subType;
    u32 m_numVertices;
    u32 m_numTriangles;
    hclBufferLayout m_bufferLayout;
};

struct hclTransformSetDefinition : hkReferencedObject {
    hkStringPtr m_name;
    s32 m_type;
    u32 m_numTransforms;
};

struct hclBufferUsage {
    u8 m_perComponentFlags[4];
    bool m_trianglesRead;
};

struct hclClothState__BufferAccess {
    std::mem::AlignTo<0x4>;
    u32 m_bufferIndex;
    hclBufferUsage m_bufferUsage;
    std::mem::AlignTo<0x4>;
    u32 m_shadowBufferIndex;
};

struct hclTransformSetUsage__TransformTracker {
    hkBitField m_read;
    hkBitField m_readBeforeWrite;
    hkBitField m_written;
};

struct hclTransformSetUsage {
    std::mem::AlignTo<0x8>;
    u8 m_perComponentFlags[2];
    hkArray<hclTransformSetUsage__TransformTracker> m_perComponentTransformTrackers;
};

struct hclClothState__TransformSetAccess {
    u32 m_transformSetIndex;
    hclTransformSetUsage m_transformSetUsage;
};

struct hclOperator : hkReferencedObject {
    hkStringPtr m_name;
    u32 m_operatorID;
    u32 m_type;
    hkArray<hclClothState__BufferAccess> m_usedBuffers;
    hkArray<hclClothState__TransformSetAccess> m_usedTransformSets;
};

struct hclStateDependencyGraph__Branch {
    s32 m_branchId;
    hkArray<s32> m_stateOperatorIndices;
    hkArray<s32> m_parentBranches;
    hkArray<s32> m_childBranches;
};

struct hclStateDependencyGraph : hkReferencedObject {
    hkArray<hclStateDependencyGraph__Branch> m_branches;
    hkArray<s32> m_rootBranchIds;
    hkArray<hkArray<s32>> m_children;
    hkArray<hkArray<s32>> m_parents;
    bool m_multiThreadable;
};

struct hclClothState : hkReferencedObject {
    hkStringPtr m_name;
    hkArray<u32> m_operators;
    hkArray<hclClothState__BufferAccess> m_usedBuffers;
    hkArray<hclClothState__TransformSetAccess> m_usedTransformSets;
    hkArray<u32> m_usedSimCloths;
    hkRefPtr<hclStateDependencyGraph> m_dependencyGraph;
};

struct hclStateTransition__SimClothTransitionData {
    bool m_isSimulated;
    hkArray<u32> m_transitionConstraints;
    u32 m_transitionType;
};

enum hclStateTransition__TransitionType : u8 {
    TRANSITION_INACTIVE = 0x0,
    ACQUIRE_VELOCITY_FROM_ANIMATION = 0x1,
    TRANSITION_TO_ANIMATION = 0x2,
    TRANSITION_FROM_ANIMATION = 0x4,
    BLEND_TO_ANIMATION = 0x8,
    BLEND_FROM_ANIMATION = 0x10,
    ANIMATION_TRANSITION_TYPE = 0x6,
    ANIMATION_BLEND_TYPE = 0x18,
    ANIMATION_TYPE = 0x1e,
    TO_ANIMATION_TYPE = 0xa,
    FROM_ANIMATION_TYPE = 0x14,
    TRANSFER_VELOCITY_TO_SLOD = 0x20,
    ACQUIRE_VELOCITY_FROM_SLOD = 0x40,
    TRANSITION_TO_SLOD = 0x80,
    TRANSITION_FROM_SLOD = 0x100,
    BLEND_TO_SLOD = 0x200,
    BLEND_FROM_SLOD = 0x400,
    SLOD_TRANSITION_TYPE = 0x180,
    SLOD_BLEND_TYPE = 0x600,
    SLOD_TYPE = 0x780,
    TO_SLOD_TYPE = 0x280,
    FROM_SLOD_TYPE = 0x500,
    BLEND_NO_SIM_TRANSITION = 0x800,
};

enum hclBlendSomeVerticesOperator__BlendWeightType : u8 {
    CONSTANT_BLEND = 0x0,
    CUSTOM_WEIGHT = 0x1,
    BUFFER_A_WEIGHT = 0x2,
    BUFFER_B_WEIGHT = 0x3,
    BLEND_BUFFER_A_TO_B = 0x4,
    BLEND_BUFFER_B_TO_A = 0x5,
    BLEND_BUFFER_A_TO_CUSTOM_WEIGHT = 0x6,
    BLEND_BUFFER_B_TO_CUSTOM_WEIGHT = 0x7,
    BLEND_CUSTOM_WEIGHT_TO_BUFFER_A = 0x8,
    BLEND_CUSTOM_WEIGHT_TO_BUFFER_B = 0x9,
};

struct hclStateTransition__BlendOpTransitionData {
    hkArray<s32> m_bufferASimCloths;
    hkArray<s32> m_bufferBSimCloths;
    hclStateTransition__TransitionType m_transitionType;
    hclBlendSomeVerticesOperator__BlendWeightType m_blendWeightType;
    std::mem::AlignTo<0x4>;
    u32 m_blendOperatorId;
};

struct hclStateTransition__StateTransitionData {
    hkArray<hclStateTransition__SimClothTransitionData> m_simClothTransitionData;
    hkArray<hclStateTransition__BlendOpTransitionData> m_blendOpTransitionData;
    bool m_simulatedState;
    bool m_emptyState;
};

struct hclStateTransition : hkReferencedObject {
    hkStringPtr m_name;
    hkArray<u32> m_stateIds;
    hkArray<hclStateTransition__StateTransitionData> m_stateTransitionData;
    hkArray<hkArray<u32>> m_simClothTransitionConstraints;
};

enum hclClothData__Platform : u32 {
    HCL_PLATFORM_INVALID = 0x0,
    HCL_PLATFORM_WIN32 = 0x1,
    HCL_PLATFORM_X64 = 0x2,
    HCL_PLATFORM_MACPPC = 0x4,
    HCL_PLATFORM_IOS = 0x8,
    HCL_PLATFORM_MAC386 = 0x10,
    HCL_PLATFORM_PS3 = 0x20,
    HCL_PLATFORM_XBOX360 = 0x40,
    HCL_PLATFORM_WII = 0x80,
    HCL_PLATFORM_LRB = 0x100,
    HCL_PLATFORM_LINUX = 0x200,
    HCL_PLATFORM_PSVITA = 0x400,
    HCL_PLATFORM_ANDROID = 0x800,
    HCL_PLATFORM_CTR = 0x1000,
    HCL_PLATFORM_WIIU = 0x2000,
    HCL_PLATFORM_PS4 = 0x4000,
    HCL_PLATFORM_XBOXONE = 0x8000,
    HCL_PLATFORM_MAC64 = 0x10000,
    HCL_PLATFORM_NX = 0x20000,
    HCL_PLATFORM_GDK = 0x40000,
    HCL_PLATFORM_PS5 = 0x80000,
    HCL_PLATFORM_MACARM64 = 0x100000,
};

struct hclClothData : hkReferencedObject {
    hkStringPtr m_name;
    hkArray<hkRefPtr<hclSimClothData>> m_simClothDatas;
    hkArray<hkRefPtr<hclBufferDefinition>> m_bufferDefinitions;
    hkArray<hkRefPtr<hclTransformSetDefinition>> m_transformSetDefinitions;
    hkArray<hkRefPtr<hclOperator>> m_operators;
    hkArray<hkRefPtr<hclClothState>> m_clothStateDatas;
    hkArray<hkRefPtr<hclStateTransition>> m_stateTransitions;
    hkArray<hkRefPtr<hclAction>> m_actions;
    bool m_generatedAtRuntime;
    std::mem::AlignTo<0x4>;
    hclClothData__Platform m_targetPlatform;
};

struct hclClothContainer : hkReferencedObject {
    hkArray<hkRefPtr<hclCollidable>> m_collidables;
    hkArray<hkRefPtr<hclClothData>> m_clothDatas;
};

struct hkMemoryResourceHandle__ExternalLink {
    hkStringPtr m_memberName;
    hkStringPtr m_externalId;
};

struct hkMemoryResourceHandle : hkReferencedObject {
    hkRefVariant m_variant;
    hkStringPtr m_name;
    hkArray<hkMemoryResourceHandle__ExternalLink> m_references;
};

struct hkMemoryResourceContainer : hkReferencedObject {
    hkStringPtr m_name;
    hkRefPtr<hkMemoryResourceContainer> m_parent;
    hkArray<hkRefPtr<hkMemoryResourceHandle>> m_resourceHandles;
    hkArray<hkRefPtr<hkMemoryResourceContainer>> m_children;
};

struct hkaBone {
    hkStringPtr m_name;
    bool m_lockTranslation;
};

struct hkLocalFrame : hkReferencedObject {};

struct hkaSkeleton__LocalFrameOnBone {
    hkRefPtr<hkLocalFrame> m_localFrame;
    u16 m_boneIndex;
};

struct hkaSkeleton__Partition {
    hkStringPtr m_name;
    u16 m_startBoneIndex;
    u16 m_numBones;
};

struct hkaSkeleton : hkReferencedObject {
    hkStringPtr m_name;
    hkArray<u16> m_parentIndices;
    hkArray<hkaBone> m_bones;
    hkArray<hkQsTransformf> m_referencePose;
    hkArray<float> m_referenceFloats;
    hkArray<hkStringPtr> m_floatSlots;
    hkArray<hkaSkeleton__LocalFrameOnBone> m_localFrames;
    hkArray<hkaSkeleton__Partition> m_partitions;
};

enum hkaAnimatedReferenceFrame__hkaReferenceFrameTypeEnum : u8 {
    REFERENCE_FRAME_UNKNOWN = 0x0,
    REFERENCE_FRAME_DEFAULT = 0x1,
    REFERENCE_FRAME_PARAMETRIC = 0x2,
};

struct hkaAnimatedReferenceFrame : hkReferencedObject {
    hkaAnimatedReferenceFrame__hkaReferenceFrameTypeEnum m_frameType;
};

enum hkaAnimation__AnimationType : u32 {
    HK_UNKNOWN_ANIMATION = 0x0,
    HK_INTERLEAVED_ANIMATION = 0x1,
    HK_MIRRORED_ANIMATION = 0x2,
    HK_SPLINE_COMPRESSED_ANIMATION = 0x3,
    HK_QUANTIZED_COMPRESSED_ANIMATION = 0x4,
    HK_PREDICTIVE_COMPRESSED_ANIMATION = 0x5,
    HK_REFERENCE_POSE_ANIMATION = 0x6,
};

struct hkaAnnotationTrack__Annotation {
    float m_time;
    hkStringPtr m_text;
};

struct hkaAnnotationTrack {
    hkStringPtr m_trackName;
    hkArray<hkaAnnotationTrack__Annotation> m_annotations;
};

struct hkaAnimation : hkReferencedObject {
    hkaAnimation__AnimationType m_type;
    float m_duration;
    s32 m_numberOfTransformTracks;
    s32 m_numberOfFloatTracks;
    hkRefPtr<hkaAnimatedReferenceFrame> m_extractedMotion;
    hkArray<hkaAnnotationTrack> m_annotationTracks;
};

enum hkaAnimationBinding__BlendHint : u8 {
    NORMAL = 0x0,
    ADDITIVE_PARENT_SPACE = 0x1,
    ADDITIVE_CHILD_SPACE = 0x2,
};

struct hkaAnimationBinding : hkReferencedObject {
    hkStringPtr m_originalSkeletonName;
    hkRefPtr<hkaAnimation> m_animation;
    hkArray<s16> m_transformTrackToBoneIndices;
    hkArray<s16> m_floatTrackToFloatSlotIndices;
    hkArray<s16> m_partitionIndices;
    hkaAnimationBinding__BlendHint m_blendHint;
};

struct hkaBoneAttachment : hkReferencedObject {
    hkStringPtr m_originalSkeletonName;
    hkMatrix4f m_boneFromAttachment;
    hkRefVariant m_attachment;
    hkStringPtr m_name;
    u16 m_boneIndex;
};

struct hkxVertexBuffer__VertexData {
    hkArray<u32> m_vectorData;
    hkArray<u32> m_floatData;
    hkArray<u32> m_uint32Data;
    hkArray<u16> m_uint16Data;
    hkArray<u8> m_uint8Data;
    u32 m_numVerts;
    u32 m_vectorStride;
    u32 m_floatStride;
    u32 m_uint32Stride;
    u32 m_uint16Stride;
    u32 m_uint8Stride;
};

enum hkxVertexDescription__DataType : u16 {
    HKX_DT_NONE = 0x0,
    HKX_DT_UINT8 = 0x1,
    HKX_DT_INT16 = 0x2,
    HKX_DT_UINT32 = 0x3,
    HKX_DT_FLOAT = 0x4,
};

enum hkxVertexDescription__DataUsage : u16 {
    HKX_DU_NONE = 0x0,
    HKX_DU_POSITION = 0x1,
    HKX_DU_COLOR = 0x2,
    HKX_DU_NORMAL = 0x4,
    HKX_DU_TANGENT = 0x8,
    HKX_DU_BINORMAL = 0x10,
    HKX_DU_TEXCOORD = 0x20,
    HKX_DU_BLENDWEIGHTS = 0x40,
    HKX_DU_BLENDINDICES = 0x80,
    HKX_DU_USERDATA = 0x100,
};

struct hkxVertexDescription__ElementDecl {
    std::mem::AlignTo<0x8>;
    u32 m_byteOffset;
    hkxVertexDescription__DataType m_type;
    hkxVertexDescription__DataUsage m_usage;
    u32 m_byteStride;
    u8 m_numElements;
    hkStringPtr m_channelID;
};

struct hkxVertexDescription {
    hkArray<hkxVertexDescription__ElementDecl> m_decls;
};

struct hkxVertexBuffer : hkReferencedObject {
    hkxVertexBuffer__VertexData m_data;
    hkxVertexDescription m_desc;
};

enum hkxIndexBuffer__IndexType : u8 {
    INDEX_TYPE_INVALID = 0x0,
    INDEX_TYPE_TRI_LIST = 0x1,
    INDEX_TYPE_TRI_STRIP = 0x2,
    INDEX_TYPE_TRI_FAN = 0x3,
    INDEX_TYPE_MAX_ID = 0x4,
};

struct hkxIndexBuffer : hkReferencedObject {
    hkxIndexBuffer__IndexType m_indexType;
    hkArray<u16> m_indices16;
    hkArray<u32> m_indices32;
    u32 m_vertexBaseOffset;
    u32 m_length;
};

struct hkxAttribute {
    hkStringPtr m_name;
    hkRefVariant m_value;
};

struct hkxAttributeGroup {
    hkStringPtr m_name;
    hkArray<hkxAttribute> m_attributes;
};

struct hkxAttributeHolder : hkReferencedObject {
    hkArray<hkxAttributeGroup> m_attributeGroups;
};

enum hkxMaterial__TextureType : u32 {
    TEX_UNKNOWN = 0x0,
    TEX_DIFFUSE = 0x1,
    TEX_REFLECTION = 0x2,
    TEX_BUMP = 0x3,
    TEX_NORMAL = 0x4,
    TEX_DISPLACEMENT = 0x5,
    TEX_SPECULAR = 0x6,
    TEX_SPECULARANDGLOSS = 0x7,
    TEX_OPACITY = 0x8,
    TEX_EMISSIVE = 0x9,
    TEX_REFRACTION = 0xa,
    TEX_GLOSS = 0xb,
    TEX_DOMINANTS = 0xc,
    TEX_NOTEXPORTED = 0xd,
    TEX_NUM_TYPES = 0xe,
};

struct hkxMaterial__TextureStage {
    hkRefVariant m_texture;
    hkxMaterial__TextureType m_usageHint;
    s32 m_tcoordChannel;
};

enum hkxMaterial__UVMappingAlgorithm : u32 {
    UVMA_SRT = 0x0,
    UVMA_TRS = 0x1,
    UVMA_3DSMAX_STYLE = 0x2,
    UVMA_MAYA_STYLE = 0x3,
};

enum hkxMaterial__Transparency : u8 {
    transp_none = 0x0,
    transp_alpha = 0x2,
    transp_additive = 0x3,
    transp_colorkey = 0x4,
    transp_subtractive = 0x9,
};

struct hkxMaterial__Property {
    u32 m_key;
    u32 m_value;
};

struct hkxMaterial : hkxAttributeHolder {
    hkStringPtr m_name;
    hkArray<hkxMaterial__TextureStage> m_stages;
    hkVector4f m_diffuseColor;
    hkVector4f m_ambientColor;
    hkVector4f m_specularColor;
    hkVector4f m_emissiveColor;
    hkArray<hkRefPtr<hkxMaterial>> m_subMaterials;
    hkRefVariant m_extraData;
    float m_uvMapScale[2];
    float m_uvMapOffset[2];
    float m_uvMapRotation;
    hkxMaterial__UVMappingAlgorithm m_uvMapAlgorithm;
    float m_specularMultiplier;
    float m_specularExponent;
    hkxMaterial__Transparency m_transparency;
    std::mem::AlignTo<0x8>;
    u64 m_userData;
    hkArray<hkxMaterial__Property> m_properties;
};

struct hkxVertexAnimation__UsageMap {
    hkxVertexDescription__DataUsage m_use;
    u8 m_useIndexOrig;
    u8 m_useIndexLocal;
};

struct hkxVertexAnimation : hkReferencedObject {
    float m_time;
    hkxVertexBuffer m_vertData;
    hkArray<s32> m_vertexIndexMap;
    hkArray<hkxVertexAnimation__UsageMap> m_componentMap;
};

struct hkMeshBoneIndexMapping {
    hkArray<u16> m_mapping;
};

struct hkxMeshSection__InstanceInfo {
    hkMatrix4f m_localTransform;
    u32 m_vertexBase;
    u32 m_verticesCount;
    u32 m_indexOffset;
    u32 m_indicesCount;
};

struct hkxMeshSection : hkReferencedObject {
    hkRefPtr<hkxVertexBuffer> m_vertexBuffer;
    hkArray<hkRefPtr<hkxIndexBuffer>> m_indexBuffers;
    hkRefPtr<hkxMaterial> m_material;
    hkArray<hkRefVariant> m_userChannels;
    hkArray<hkRefPtr<hkxVertexAnimation>> m_vertexAnimations;
    hkArray<float> m_linearKeyFrameHints;
    hkArray<hkMeshBoneIndexMapping> m_boneMatrixMap;
    hkArray<hkxMeshSection__InstanceInfo> m_instances;
    hkVector4f m_originalBoundingBoxMin;
    hkVector4f m_originalBoundingBoxMax;
};

struct hkxMesh__UserChannelInfo : hkxAttributeHolder {
    hkStringPtr m_name;
    hkStringPtr m_className;
};

struct hkxMesh : hkReferencedObject {
    hkArray<hkRefPtr<hkxMeshSection>> m_sections;
    hkArray<hkRefPtr<hkxMesh__UserChannelInfo>> m_userChannelInfos;
};

struct hkaMeshBinding__Mapping {
    hkArray<s16> m_mapping;
};

struct hkaMeshBinding : hkReferencedObject {
    hkRefPtr<hkxMesh> m_mesh;
    hkStringPtr m_originalSkeletonName;
    hkStringPtr m_name;
    hkRefPtr<hkaSkeleton> m_skeleton;
    hkArray<hkaMeshBinding__Mapping> m_mappings;
    hkArray<hkTransform> m_boneFromSkinMeshTransforms;
};

struct hkaAnimationContainer : hkReferencedObject {
    hkArray<hkRefPtr<hkaSkeleton>> m_skeletons;
    hkArray<hkRefPtr<hkaAnimation>> m_animations;
    hkArray<hkRefPtr<hkaAnimationBinding>> m_bindings;
    hkArray<hkRefPtr<hkaBoneAttachment>> m_attachments;
    hkArray<hkRefPtr<hkaMeshBinding>> m_skins;
};

hclClothContainer cloth_container @ cloth_offset;
hkMemoryResourceContainer mem_resource_container @ resource_offset;
hkaAnimationContainer animation_container @ animation_offset;