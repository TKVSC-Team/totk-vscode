import sys, os
from pathlib import Path

sys.path.append(str(Path('e:/Nintendo Stuff/TOTK/TOTK Searcher Dev/totk-vscode/totk-vscode/python').resolve()))

from bntx_renderer import render_texture_to_png, extract_texture_linear

romfs_path = "e:/Nintendo Stuff/ROMS/Switch/Tears Dump/romfs"
bntx_path = romfs_path + "/Armor/Armor_012_Lower.bntx"
bntx_data = Path(bntx_path).read_bytes()

from bntx_renderer import _parse_textures
textures = _parse_textures(bntx_data)
tex_name = textures[0].name

try:
    extracted = extract_texture_linear(bntx_data, tex_name)
    tex_width, tex_height, decoder_key, linear, mip_count, format_id = extracted
    print(f"Extracted: {tex_width}x{tex_height}, {decoder_key}, {len(linear)} bytes, mip={mip_count}, fmt={format_id}")

    if decoder_key.startswith("bc"):
        dxgi_map = {
            0x1A: 72 if (format_id & 0xFF) == 0x06 else 71,
            0x1B: 75 if (format_id & 0xFF) == 0x06 else 74,
            0x1C: 78 if (format_id & 0xFF) == 0x06 else 77,
            0x1D: 81 if (format_id & 0xFF) == 0x02 else 80,
            0x1E: 84 if (format_id & 0xFF) == 0x02 else 83,
            0x1F: 96 if (format_id & 0xFF) == 0x02 else 95,
            0x20: 99 if (format_id & 0xFF) == 0x06 else 98,
        }
        dxgi_format = dxgi_map.get(format_id >> 8)
        print(f"DXGI Format: {dxgi_format}")
        header = bytearray(148)
        header[0:4] = b"DDS "
        header[4:8] = (124).to_bytes(4, "little")
        header[8:12] = (0x1 | 0x2 | 0x4 | 0x1000 | 0x80000).to_bytes(4, "little") 
        header[12:16] = tex_height.to_bytes(4, "little")
        header[16:20] = tex_width.to_bytes(4, "little")
        header[20:24] = len(linear).to_bytes(4, "little") 
        header[24:28] = (1).to_bytes(4, "little") 
        header[28:32] = (mip_count).to_bytes(4, "little") 
        
        header[76:80] = (32).to_bytes(4, "little") 
        header[80:84] = (0x4).to_bytes(4, "little") 
        header[84:88] = b"DX10"
        
        header[108:112] = (0x1000).to_bytes(4, "little") 
        
        header[128:132] = dxgi_format.to_bytes(4, "little")
        header[132:136] = (3).to_bytes(4, "little") 
        header[136:140] = (0).to_bytes(4, "little") 
        header[140:144] = (1).to_bytes(4, "little") 
        header[144:148] = (0).to_bytes(4, "little") 
        
        native_dds_bytes = bytes(header) + linear
        print(f"Created DDS bytes: {len(native_dds_bytes)}")
except Exception as e:
    import traceback
    traceback.print_exc()

# Let's also check the uncompressed fallback for ASTC
if not decoder_key.startswith("bc"):
    print("Not BC, testing uncompressed fallback.")
    png_path = render_texture_to_png(bntx_data, tex_name)
    from PIL import Image
    img = Image.open(png_path)
    img = img.convert("RGBA")
    width, height = img.size
    pixels = img.tobytes("raw", "RGBA")
    header = bytearray(128)
    header[0:4] = b"DDS "
    header[4:8] = (124).to_bytes(4, "little")
    header[8:12] = (0x100F).to_bytes(4, "little") 
    header[12:16] = height.to_bytes(4, "little")
    header[16:20] = width.to_bytes(4, "little")
    header[20:24] = (width * 4).to_bytes(4, "little")
    header[24:28] = (1).to_bytes(4, "little")
    header[28:32] = (1).to_bytes(4, "little")
    header[76:80] = (32).to_bytes(4, "little")
    header[80:84] = (0x41).to_bytes(4, "little")
    header[88:92] = (32).to_bytes(4, "little")
    header[92:96] = (0x000000FF).to_bytes(4, "little")
    header[96:100] = (0x0000FF00).to_bytes(4, "little")
    header[100:104] = (0x00FF0000).to_bytes(4, "little")
    header[104:108] = (0xFF000000).to_bytes(4, "little")
    header[108:112] = (0x1000).to_bytes(4, "little")
    print("Created uncompressed DDS")
