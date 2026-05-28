import struct
import shlex
from msbt_tags import MSBT_TAGS_BY_ID, MSBT_TAGS_BY_NAME

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
    
    for arg in args_def:
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
            end = offset
            while end + 1 < len(b):
                if b[end] == 0 and b[end+1] == 0:
                    break
                end += 2
            try:
                val = b[offset:end].decode('utf-16-le')
            except:
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
            # fill with 0
            if dtype == 'u8': b.extend(b'\x00')
            elif dtype in ('u16', 's16', 'bool'): b.extend(b'\x00\x00')
            continue
            
        val = None
        if 'valueMap' in arg:
            for k, v in arg['valueMap'].items():
                if str(v) == val_str:
                    val = int(k)
                    break
                    
        if val is None:
            if dtype == 'str':
                val = val_str
            elif dtype == 'bool':
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
            b.extend(struct.pack('<H', 1 if val else 0)) # assuming 2 bytes for bool
        elif dtype == 'str':
            b.extend(val.encode('utf-16-le'))
            b.extend(b'\x00\x00')
            
    return str(magic), group, type_, b.hex()
