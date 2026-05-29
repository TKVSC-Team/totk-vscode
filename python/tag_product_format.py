import json
import os

import oead
import yaml


def to_editor_text(byml_doc: oead.byml.Hash) -> str:
    path_list = byml_doc.get("PathList", [])
    tag_list = [str(x) for x in byml_doc.get("TagList", [])]
    bit_table = bytes(byml_doc.get("BitTable", b""))

    actor_tag_data = {}
    path_list_count = len(path_list)
    tag_list_count = len(tag_list)

    def get_bit(data: bytes, index: int) -> bool:
        byte_idx = index // 8
        bit_idx = index % 8
        if byte_idx < len(data):
            return ((data[byte_idx] >> bit_idx) & 1) == 1
        return False

    for i in range(path_list_count // 3):
        actor_path = f"{path_list[i * 3]}|{path_list[i * 3 + 1]}|{path_list[i * 3 + 2]}"
        actor_tag_list = []
        for k in range(tag_list_count):
            if get_bit(bit_table, i * tag_list_count + k):
                actor_tag_list.append(tag_list[k])
        actor_tag_data[actor_path] = actor_tag_list

    data = {"PathList": actor_tag_data, "TagList": tag_list}

    fmt = os.environ.get("TOTK_TAG_PRODUCT_FORMAT", "json")
    if fmt == "yaml":
        return yaml.safe_dump(data, sort_keys=False, allow_unicode=True, width=float("inf"))
    else:
        return json.dumps(data, indent=4)


def from_editor_text(editor_text: str, big_endian: bool, version: int) -> bytes:
    json_data = yaml.safe_load(editor_text)
    cached_tag_list = json_data.get("TagList", [])
    path_list_map = json_data.get("PathList", {})

    path_vec = list(path_list_map.items())

    def sort_key(item):
        key = item[0]
        parts = key.split("|")
        extract = parts[1] if len(parts) > 1 else key
        return (extract, key)

    path_vec.sort(key=sort_key)

    path_list_out = []
    bit_table_bits = []

    for path, tag_entries in path_vec:
        if "|" in path:
            slices = path.split("|")
            path_list_out.extend(slices)

        for tag in cached_tag_list:
            bit_table_bits.append(tag in tag_entries)

    # Pack bits to bytes (LSB0)
    bit_table_bytes = bytearray((len(bit_table_bits) + 7) // 8)
    for i, bit in enumerate(bit_table_bits):
        if bit:
            byte_idx = i // 8
            bit_idx = i % 8
            bit_table_bytes[byte_idx] |= 1 << bit_idx

    byml_dict = {
        "PathList": path_list_out,
        "BitTable": bytes(bit_table_bytes),
        "RankTable": "",
        "TagList": cached_tag_list,
    }

    byml_doc = oead.byml.Hash(byml_dict)
    return oead.byml.to_binary(byml_doc, big_endian=big_endian, version=version)
