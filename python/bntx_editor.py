import struct
from bntx_reader import is_bntx, _read_bntx_string

class BntxEditor:
    def __init__(self, data: bytes):
        if not is_bntx(data):
            raise ValueError('Not a valid BNTX file.')
        self._data = bytearray(data)
        
        self.bom = self._data[0x0C:0x0E]
        self.le = (self.bom == b'\xff\xfe')
        self.endian_fmt = '<' if self.le else '>'

    def _read_fmt(self, fmt: str, offset: int):
        return struct.unpack_from(self.endian_fmt + fmt, self._data, offset)[0]

    def _write_fmt(self, fmt: str, offset: int, value):
        struct.pack_into(self.endian_fmt + fmt, self._data, offset, value)

    @property
    def tex_count(self) -> int:
        return self._read_fmt('i', 0x24)
        
    @tex_count.setter
    def tex_count(self, value: int):
        self._write_fmt('i', 0x24, value)

    @property
    def info_ptrs_addr(self) -> int:
        return self._read_fmt('q', 0x28)

    @property
    def file_size(self) -> int:
        return self._read_fmt('I', 0x1C)

    @file_size.setter
    def file_size(self, value: int):
        self._write_fmt('I', 0x1C, value)

    def get_texture_ptrs(self) -> list[int]:
        ptrs = []
        addr = self.info_ptrs_addr
        for _ in range(self.tex_count):
            ptrs.append(self._read_fmt('q', addr))
            addr += 8
        return ptrs

    def find_texture_brti(self, name: str) -> int:
        for ptr in self.get_texture_ptrs():
            if ptr <= 0 or ptr + 0x70 > len(self._data): continue
            name_addr = self._read_fmt('q', ptr + 0x10 + 0x50)
            if 0 < name_addr < len(self._data):
                tex_name = _read_bntx_string(self._data, name_addr, self.le)
                if tex_name == name:
                    return ptr
        return -1

    def update_metadata(self, name: str, metadata: dict):
        ptr = self.find_texture_brti(name)
        if ptr < 0:
            raise ValueError(f'Texture {name} not found.')
            
        d = ptr + 0x10
        channels = ['Zero', 'One', 'Red', 'Green', 'Blue', 'Alpha']
        ch_map = {c: i for i, c in enumerate(channels)}

        if 'red' in metadata and metadata['red'] in ch_map:
            self._data[d + 0x48] = ch_map[metadata['red']]
        if 'green' in metadata and metadata['green'] in ch_map:
            self._data[d + 0x49] = ch_map[metadata['green']]
        if 'blue' in metadata and metadata['blue'] in ch_map:
            self._data[d + 0x4A] = ch_map[metadata['blue']]
        if 'alpha' in metadata and metadata['alpha'] in ch_map:
            self._data[d + 0x4B] = ch_map[metadata['alpha']]

        if metadata.get('swizzle') is not None:
            self._write_fmt('H', d + 0x04, int(metadata['swizzle']))

        new_name = metadata.get('name', name)
        if new_name is not None and new_name != name:
            self.rename_texture(name, new_name)
            name = new_name
            
        if 'path' in metadata and metadata['path'] is not None:
            new_path = metadata['path']
            ptr = self.find_texture_brti(name)
            new_path_bytes = struct.pack(self.endian_fmt + 'H', len(new_path)) + new_path.encode('utf-8') + b'\x00'
            new_addr = len(self._data)
            self._data.extend(new_path_bytes)
            self._write_fmt('q', ptr + 0x10 + 0x58, new_addr)
            self.file_size = len(self._data)
            
        if 'useSRGB' in metadata and metadata['useSRGB'] is not None:
            use_srgb = bool(metadata['useSRGB'])
            format_id = self._read_fmt('I', ptr + 0x10 + 0x0C)
            variant = format_id & 0xFF
            
            # Aggressively correct the variant byte (0x06 for SRGB, 0x01 for UNORM)
            if use_srgb and variant != 0x06:
                format_id = (format_id & 0xFFFFFF00) | 0x06
                self._write_fmt('I', ptr + 0x10 + 0x0C, format_id)
            elif not use_srgb and variant != 0x01:
                format_id = (format_id & 0xFFFFFF00) | 0x01
                self._write_fmt('I', ptr + 0x10 + 0x0C, format_id)

    def rename_texture(self, old_name: str, new_name: str):
        raise NotImplementedError('Texture renaming is temporarily disabled!')

    def replace_texture_payload(self, name: str, new_payload: bytes):
        ptr = self.find_texture_brti(name)
        if ptr < 0:
            raise ValueError(f'Texture {name} not found.')
            
        new_data_addr = len(self._data)
        self._data.extend(new_payload)
        
        self._write_fmt('q', ptr + 0x10 + 0x18, new_data_addr)
        self._write_fmt('q', ptr + 0x10 + 0x20, len(new_payload))
        
        self.file_size = len(self._data)
        
    def to_bytes(self) -> bytes:
        return bytes(self._data)

