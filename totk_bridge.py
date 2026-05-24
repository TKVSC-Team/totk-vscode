import sys
import json
import zstandard as zstd
import oead
from byml_editor_format import to_editor_text

sys.stdout.reconfigure(encoding='utf-8')
sys.stdin.reconfigure(encoding='utf-8')

# Helper to automatically sniff and decompress ZSTD or Yaz0
def get_byml_data(file_data):
    is_zstd = False
    is_yaz0 = False
    if file_data.startswith(b'\x28\xb5\x2f\xfd'):
        file_data = zstd.ZstdDecompressor().decompress(file_data)
        is_zstd = True
    elif file_data.startswith(b'Yaz0'):
        file_data = oead.yaz0.decompress(file_data)
        is_yaz0 = True
    return file_data, is_zstd, is_yaz0

def main():
    try:
        command = sys.argv[1]
        pack_path = sys.argv[2]
        
        with open(pack_path, 'rb') as f:
            data = f.read()
            
        is_sarc_compressed = data.startswith(b'\x28\xb5\x2f\xfd')
        if is_sarc_compressed:
            data = zstd.ZstdDecompressor().decompress(data)
            
        sarc = oead.Sarc(data)
        
        if command == "list":
            files = [file.name for file in sarc.get_files()]
            print(json.dumps(files))
            
        elif command == "read":
            internal_path = sys.argv[3]
            file_data = bytes(sarc.get_file(internal_path).data)
            
            if internal_path.endswith('.byml') or internal_path.endswith('.bgyml'):
                file_data, _, _ = get_byml_data(file_data)
                
                if file_data.startswith(b'YB') or file_data.startswith(b'BY'):
                    is_little = file_data.startswith(b'YB')
                    
                    try:
                        byml_doc = oead.byml.from_binary(file_data)
                    except Exception as e:
                        if "version" in str(e).lower():
                            # The Nintendo Byte-Hack: Force version 4 to trick the parser
                            mutable = bytearray(file_data)
                            if is_little:
                                mutable[2:4] = (4).to_bytes(2, 'little')
                            else:
                                mutable[2:4] = (4).to_bytes(2, 'big')
                            byml_doc = oead.byml.from_binary(bytes(mutable))
                        else:
                            raise e
                            
                    text_output = to_editor_text(byml_doc)
                    print(json.dumps({"content": text_output}))
                else:
                    print(json.dumps({"content": f"<Unknown BYML Magic: {file_data[:4]}>"}))
            else:
                print(json.dumps({"content": f"<Binary Data: {len(file_data)} bytes. BYML editing only!>"}))

        elif command == "write":
            internal_path = sys.argv[3]
            new_yaml = sys.stdin.read()
            
            orig_file_data = bytes(sarc.get_file(internal_path).data)
            orig_file_data, is_zstd, is_yaz0 = get_byml_data(orig_file_data)
            
            # Grab the true original version so we can restore it
            if orig_file_data.startswith(b'BY'):
                big_endian = True
                version = int.from_bytes(orig_file_data[2:4], 'big')
            elif orig_file_data.startswith(b'YB'):
                big_endian = False
                version = int.from_bytes(orig_file_data[2:4], 'little')
            else:
                big_endian = False
                version = 7
                
            byml_doc = oead.byml.from_text(new_yaml)
            
            try:
                # Try to save normally first
                new_byml_bytes = oead.byml.to_binary(byml_doc, big_endian=big_endian, version=version)
            except Exception as e:
                if "version" in str(e).lower():
                    # Fallback: Save as v4, then manually inject the true version byte back in
                    new_byml_bytes = bytearray(oead.byml.to_binary(byml_doc, big_endian=big_endian, version=4))
                    if big_endian:
                        new_byml_bytes[2:4] = version.to_bytes(2, 'big')
                    else:
                        new_byml_bytes[2:4] = version.to_bytes(2, 'little')
                    new_byml_bytes = bytes(new_byml_bytes)
                else:
                    raise e
            
            # Recompress the internal file if needed
            if is_zstd:
                new_byml_bytes = zstd.ZstdCompressor().compress(new_byml_bytes)
            elif is_yaz0:
                new_byml_bytes = oead.yaz0.compress(new_byml_bytes)
            
            # Swap the data in the archive
            writer = oead.SarcWriter.from_sarc(sarc)
            writer.files[internal_path] = new_byml_bytes
            new_sarc_bytes = writer.write()[1]
            
            # Recompress the master pack
            if is_sarc_compressed:
                new_sarc_bytes = zstd.ZstdCompressor().compress(new_sarc_bytes)
                
            with open(pack_path, 'wb') as f:
                f.write(new_sarc_bytes)
                
            print(json.dumps({"success": True}))
            
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(0)

if __name__ == "__main__":
    main()