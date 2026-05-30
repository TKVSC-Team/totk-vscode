import struct

import zstandard as zstd
from txtg_reader import is_txtg


class TxtgEditor:
    def __init__(self, data: bytes):
        if not is_txtg(data):
            raise ValueError('Not a valid TXTG file.')
        self._data = bytearray(data)

    @property
    def header_size(self) -> int:
        val = struct.unpack_from('<H', self._data, 0x00)[0]
        return val if val else 0x50

    @property
    def width(self) -> int:
        return struct.unpack_from('<H', self._data, 0x08)[0]

    @width.setter
    def width(self, value: int):
        struct.pack_into('<H', self._data, 0x08, value)

    @property
    def height(self) -> int:
        return struct.unpack_from('<H', self._data, 0x0A)[0]

    @height.setter
    def height(self, value: int):
        struct.pack_into('<H', self._data, 0x0A, value)

    @property
    def array_count(self) -> int:
        return max(struct.unpack_from('<H', self._data, 0x0C)[0], 1)

    @array_count.setter
    def array_count(self, value: int):
        struct.pack_into('<H', self._data, 0x0C, value)

    @property
    def mip_count(self) -> int:
        return max(self._data[0x0E], 1)

    @mip_count.setter
    def mip_count(self, value: int):
        self._data[0x0E] = value

    @property
    def comp_r(self) -> int:
        return self._data[0x18]

    @comp_r.setter
    def comp_r(self, value: int):
        self._data[0x18] = value

    @property
    def comp_g(self) -> int:
        return self._data[0x19]

    @comp_g.setter
    def comp_g(self, value: int):
        self._data[0x19] = value

    @property
    def comp_b(self) -> int:
        return self._data[0x1A]

    @comp_b.setter
    def comp_b(self, value: int):
        self._data[0x1A] = value

    @property
    def comp_a(self) -> int:
        return self._data[0x1B]

    @comp_a.setter
    def comp_a(self, value: int):
        self._data[0x1B] = value

    @property
    def format_id(self) -> int:
        return struct.unpack_from('<H', self._data, 0x3C)[0]

    @format_id.setter
    def format_id(self, value: int):
        struct.pack_into('<H', self._data, 0x3C, value)

    @property
    def texture_setting2(self) -> int:
        return struct.unpack_from('<I', self._data, 0x44)[0]

    @texture_setting2.setter
    def texture_setting2(self, value: int):
        struct.pack_into('<I', self._data, 0x44, value)

    @property
    def texture_setting4(self) -> int:
        return struct.unpack_from('<I', self._data, 0x4C)[0]

    @texture_setting4.setter
    def texture_setting4(self, value: int):
        struct.pack_into('<I', self._data, 0x4C, value)

    def replace_image_data(self, raw_surfaces: list[bytes]):
        header = self._data[:self.header_size]
        cctx = zstd.ZstdCompressor()
        size_table = []
        payload_data = bytearray()
        surface_count = len(raw_surfaces)

        for surface in raw_surfaces:
            compressed = cctx.compress(surface)
            size_table.append(len(compressed))
            payload_data.extend(compressed)

        index_bytes = bytearray(surface_count * 4)
        size_bytes = bytearray()
        for size in size_table:
            size_bytes.extend(struct.pack('<Q', size))

        new_data = bytearray(header)
        new_data.extend(index_bytes)
        new_data.extend(size_bytes)
        new_data.extend(payload_data)
        self._data = new_data

    def to_bytes(self) -> bytes:
        return bytes(self._data)

