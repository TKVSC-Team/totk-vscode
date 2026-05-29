import shlex
import struct

from msbt_tags import MSBT_TAGS_BY_ID, MSBT_TAGS_BY_NAME


def _decode_str_arg(raw: str):
    """Strip the leading Nintendo ctrl char from a decoded str argument.

    Returns (visible_text, ctrl_char).  ctrl_char is '' if absent.
    """
    if raw and ord(raw[0]) < 0x20:
        return raw[1:], raw[0]
    return raw, ''


def _decode_str_args_block(data: bytes, count: int) -> list[str]:
    usable = len(data) & ~1
    chars = []
    for i in range(0, usable, 2):
        chars.append(data[i] | (data[i + 1] << 8))

    results: list[str] = []
    ci = 0  # character index

    for _arg_idx in range(count):
        if ci >= len(chars):
            results.append('')
            continue

        ch = chars[ci]

        if ch == 0x0000:
            # Empty argument.
            results.append('')
            ci += 1
            continue

        has_ctrl = ch < 0x0020
        if has_ctrl:
            ci += 1

        text_chars: list[str] = []
        while ci < len(chars):
            ch = chars[ci]
            if ch == 0x0000:
                ci += 1
                break
            if ch < 0x0020:
                break
            text_chars.append(chr(ch))
            ci += 1
        results.append(''.join(text_chars))

    return results


def command_to_tag(magic, group, type_, hexdata):
    key = f"{group}_{type_}"
    if key not in MSBT_TAGS_BY_ID:
        return f"{{cmd:{magic}:{group}:{type_}:{hexdata}}}"

    tag_def = MSBT_TAGS_BY_ID[key]
    tag_name = tag_def['name']
    args_def = tag_def.get('arguments', [])

    if not args_def:
        return f"{{{{{tag_name}}}}}"

    if hexdata:
        hexdata = hexdata.replace('0x', '').replace(' ', '')
        if len(hexdata) % 2 != 0:
            hexdata = '0' + hexdata
        try:
            b = bytes.fromhex(hexdata)
        except ValueError:
            b = b''
    else:
        b = b''

    offset = 0
    args_str = []

    str_run_start = None
    for i, a in enumerate(args_def):
        if a.get('dataType') == 'str':
            if str_run_start is None:
                str_run_start = i
        else:
            str_run_start = None

    for i, arg in enumerate(args_def):
        dtype = arg.get('dataType')
        name = arg.get('name')
        val = None

        if dtype == 'u8' and offset + 1 <= len(b):
            val = struct.unpack_from('<B', b, offset)[0]
            offset += 1
        elif dtype == 'u16' and offset + 2 <= len(b):
            val = struct.unpack_from('<H', b, offset)[0]
            offset += 2
        elif dtype == 's16' and offset + 2 <= len(b):
            val = struct.unpack_from('<h', b, offset)[0]
            offset += 2
        elif dtype == 'bool':
            if offset + 2 <= len(b):
                val = bool(struct.unpack_from('<H', b, offset)[0])
                offset += 2
            elif offset + 1 <= len(b):
                val = bool(struct.unpack_from('<B', b, offset)[0])
                offset += 1
        elif dtype == 'str':
            if str_run_start is not None and i >= str_run_start:
                str_args_remaining = [a for a in args_def[i:] if a.get('dataType') == 'str']
                decoded_strs = _decode_str_args_block(b[offset:], len(str_args_remaining))
                for j, sa in enumerate(str_args_remaining):
                    sa_name = sa.get('name')
                    sa_val = decoded_strs[j] if j < len(decoded_strs) else ''
                    if sa_val is not None:
                        args_str.append(f'{sa_name}="{sa_val}"')
                break
            else:
                end = offset
                while end + 1 < len(b):
                    if b[end] == 0 and b[end + 1] == 0:
                        break
                    end += 2
                try:
                    raw = b[offset:end].decode('utf-16-le')
                    visible, _ = _decode_str_arg(raw)
                    val = visible
                except Exception:
                    val = b[offset:end].hex()
                offset = end + 2

        if val is not None:
            if 'valueMap' in arg:
                vmap = {int(k): v for k, v in arg['valueMap'].items()}
                if val in vmap:
                    val = vmap[val]
            if isinstance(val, bool):
                val_str = "true" if val else "false"
            else:
                val_str = str(val)
            args_str.append(f'{name}="{val_str}"')

    if args_str:
        return f"{{{{{tag_name} {' '.join(args_str)}}}}}"
    return f"{{{{{tag_name}}}}}"


def tag_to_command(tag_content):
    parts = shlex.split(tag_content)
    if not parts:
        return None

    tag_name = parts[0]
    if tag_name not in MSBT_TAGS_BY_NAME:
        return None

    tag_def = MSBT_TAGS_BY_NAME[tag_name]
    group = tag_def['group']
    type_ = tag_def['type']
    magic = 14

    args_def = tag_def.get('arguments', [])
    b = bytearray()

    parsed_args = {}
    for part in parts[1:]:
        if '=' in part:
            k, v = part.split('=', 1)
            parsed_args[k] = v

    for arg in args_def:
        dtype = arg.get('dataType')
        name = arg.get('name')
        val_str = parsed_args.get(name)

        if val_str is None:
            if dtype == 'u8':
                b.extend(b'\x00')
            elif dtype in ('u16', 's16', 'bool'):
                b.extend(b'\x00\x00')
            elif dtype == 'str':
                b.extend(b'\x00\x00')  # empty null-terminated string
            continue

        val = None
        if 'valueMap' in arg:
            for k, v in arg['valueMap'].items():
                if str(v) == val_str:
                    val = int(k)
                    break

        if val is None:
            if dtype == 'bool':
                val = val_str.lower() == 'true'
            else:
                try:
                    val = int(val_str)
                except ValueError:
                    val = 0

        if dtype == 'u8':
            b.extend(struct.pack('<B', val))
        elif dtype == 'u16':
            b.extend(struct.pack('<H', val))
        elif dtype == 's16':
            b.extend(struct.pack('<h', val))
        elif dtype == 'bool':
            b.extend(struct.pack('<H', 1 if val else 0))
        elif dtype == 'str':
            if val_str:
                b.extend('\u0002'.encode('utf-16-le'))
                b.extend(val_str.encode('utf-16-le'))
            b.extend(b'\x00\x00')

    return str(magic), group, type_, b.hex()
