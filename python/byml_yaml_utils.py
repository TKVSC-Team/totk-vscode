"""Helpers for round-tripping BYML YAML text (typed integers, hashes)."""

import re

# Bare decimal literals above signed 64-bit max were emitted by older editor builds and
# parse as the wrong BYML node type on save.
_U64_DECIMAL_PATTERN = re.compile(
    r'(?P<prefix>:\s*|,\s*|\{\s*)(?P<num>\d{10,})(?=\s*(?:$|[,}\]]))',
    re.MULTILINE,
)


def normalize_byml_u64_literals(yml_text: str) -> str:
    """Convert bare u64-sized decimals to !ul 0x... so oead keeps unsigned 64-bit types."""

    def replace(match: re.Match[str]) -> str:
        value = int(match.group('num'))
        if value <= 0x7FFFFFFFFFFFFFFF:
            return match.group(0)
        hex_value = f'!ul 0x{value:x}'
        return f'{match.group("prefix")}{hex_value}'

    return _U64_DECIMAL_PATTERN.sub(replace, yml_text)


def format_byml_for_editor(byml_doc) -> str:
    """Serialize a BYML document for editing (oead canonical YAML with typed integers)."""
    import oead

    text = oead.byml.to_text(byml_doc)
    return text.rstrip() + '\n'
