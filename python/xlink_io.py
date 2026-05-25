"""Read/write Nintendo XLNK (.belnk / .bslnk) via dt-12345/xlink2 xlink_tool."""

import os
import subprocess
import tempfile
from pathlib import Path

from zstd_totk import compress_container, decompress_container, zsdic_pack_path

_ZSTD_MAGIC = b'\x28\xb5\x2f\xfd'
_EXTENSION_ROOT = Path(__file__).parent


def is_xlnk_extension(logical_path: str) -> bool:
    lower = logical_path.lower().replace('\\', '/')
    if lower.endswith('.zs'):
        lower = lower[:-3]
    return lower.endswith('.belnk') or lower.endswith('.bslnk')


def is_xlnk_binary(file_data: bytes) -> bool:
    if len(file_data) >= 4 and file_data[:4] == b'XLNK':
        return True
    try:
        data, _, _ = decompress_container(file_data, '', '')
    except ValueError:
        data = file_data
    return len(data) >= 4 and data[:4] == b'XLNK'


def find_xlink_tool() -> str:
    override = os.environ.get('TOTK_XLINK_TOOL', '').strip()
    if override:
        if os.path.isfile(override):
            return override
        raise FileNotFoundError(f'TOTK_XLINK_TOOL is not a file: {override}')

    name = 'xlink_tool.exe' if os.name == 'nt' else 'xlink_tool'
    bundled = _EXTENSION_ROOT / 'vendor' / 'xlink2' / name
    if bundled.is_file():
        return str(bundled)

    raise FileNotFoundError(
        'xlink_tool not found. Install dt-12345/xlink2 and set TOTK_XLINK_TOOL, '
        f'or place {name} in vendor/xlink2/.'
    )


def _zsdic_for_romfs(romfs_path: str) -> str:
    if not romfs_path:
        return ''
    path = zsdic_pack_path(romfs_path)
    return path if os.path.isfile(path) else ''


def _run_xlink_export(
    tool: str,
    input_path: str,
    output_yaml: str,
    zsdic: str,
) -> None:
    args = [tool, '-e', input_path, output_yaml]
    if zsdic:
        args.append(zsdic)
    result = subprocess.run(args, capture_output=True, text=True)
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or '').strip() or f'exit {result.returncode}'
        raise RuntimeError(f'xlink_tool export failed: {detail}')


def _run_xlink_import(
    tool: str,
    input_yaml: str,
    output_path: str,
    zsdic: str,
) -> None:
    args = [tool, '-i', input_yaml, output_path]
    if zsdic:
        args.append(zsdic)
    result = subprocess.run(args, capture_output=True, text=True)
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or '').strip() or f'exit {result.returncode}'
        raise RuntimeError(f'xlink_tool import failed: {detail}')


def read_xlnk_content(file_data: bytes, logical_path: str = '', romfs_path: str = '') -> str:
    tool = find_xlink_tool()
    zsdic = _zsdic_for_romfs(romfs_path)
    use_zsdic = bool(zsdic) and (
        logical_path.lower().endswith('.zs') or file_data.startswith(_ZSTD_MAGIC)
    )

    with tempfile.TemporaryDirectory(prefix='totk-xlnk-') as tmp:
        tmp_path = Path(tmp)
        inp = tmp_path / 'input'
        out_yaml = tmp_path / 'output.yaml'
        inp.write_bytes(file_data)
        _run_xlink_export(tool, str(inp), str(out_yaml), zsdic if use_zsdic else '')
        return out_yaml.read_text(encoding='utf-8')


def write_xlnk_bytes(
    orig_file_data: bytes,
    editor_text: str,
    logical_path: str = '',
    romfs_path: str = '',
) -> bytes:
    tool = find_xlink_tool()
    zsdic = _zsdic_for_romfs(romfs_path)
    was_zstd = logical_path.lower().endswith('.zs') or orig_file_data.startswith(_ZSTD_MAGIC)
    use_zsdic = bool(zsdic) and was_zstd

    with tempfile.TemporaryDirectory(prefix='totk-xlnk-') as tmp:
        tmp_path = Path(tmp)
        yaml_path = tmp_path / 'input.yaml'
        out_path = tmp_path / 'output'
        yaml_path.write_text(editor_text, encoding='utf-8')
        _run_xlink_import(tool, str(yaml_path), str(out_path), zsdic if use_zsdic else '')
        return out_path.read_bytes()
