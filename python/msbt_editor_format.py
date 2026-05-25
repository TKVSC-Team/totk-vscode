"""Format MSBT label/text data for editor display (BYML-like key: value lines)."""

import re

from pymsbt.classes import TextCommand, TextComponent

_CMD_PATTERN = re.compile(
    r'\{cmd:([^:}]+):(\d+):(\d+):([^}]*)\}',
)
_UNESCAPE = {
    '\\n': '\n',
    '\\r': '\r',
    '\\t': '\t',
    '\\\\': '\\',
    '\\{': '{',
}


def _escape_text(text: str) -> str:
    return (
        text.replace('\\', '\\\\')
        .replace('\n', '\\n')
        .replace('\r', '\\r')
        .replace('\t', '\\t')
        .replace('{', '\\{')
    )


def components_to_display(components) -> str:
    parts: list[str] = []
    for component in components:
        if component.type == 'text':
            parts.append(_escape_text(component.data))
        elif component.type == 'command':
            command = component.data
            hexdata = command.data or ''
            parts.append(f'{{cmd:{command.magic}:{command.group}:{command.type}:{hexdata}}}')
    return ''.join(parts)


def display_to_components(text: str) -> list:
    components: list = []
    pos = 0

    while pos < len(text):
        match = _CMD_PATTERN.search(text, pos)
        if match is None:
            chunk = text[pos:]
            if chunk:
                components.append(TextComponent(type='text', data=_unescape_text(chunk)))
            break

        if match.start() > pos:
            components.append(
                TextComponent(type='text', data=_unescape_text(text[pos:match.start()]))
            )

        magic, group, cmd_type, hexdata = match.groups()
        data_size = len(bytes.fromhex(hexdata.replace('0x', ''))) if hexdata else 0
        command = TextCommand.__new__(TextCommand)
        command.magic = magic
        command.group = int(group)
        command.type = int(cmd_type)
        command.data_size = data_size
        command.data = hexdata if hexdata else None
        command.start_offset = 0
        command.end_offset = 0
        components.append(TextComponent(type='command', data=command))
        pos = match.end()

    if not components:
        components.append(TextComponent(type='text', data=''))

    return components


def _unescape_text(text: str) -> str:
    result: list[str] = []
    i = 0
    while i < len(text):
        if text[i] == '\\' and i + 1 < len(text):
            pair = text[i : i + 2]
            if pair in _UNESCAPE:
                result.append(_UNESCAPE[pair])
                i += 2
                continue
        result.append(text[i])
        i += 1
    return ''.join(result)


def _parse_value(raw: str) -> str:
    value = raw.strip()
    if len(value) >= 2 and value[0] == '"' and value[-1] == '"':
        inner = value[1:-1]
        out: list[str] = []
        i = 0
        while i < len(inner):
            if inner[i] == '\\' and i + 1 < len(inner):
                pair = inner[i : i + 2]
                if pair in _UNESCAPE:
                    out.append(_UNESCAPE[pair])
                    i += 2
                    continue
                out.append(inner[i + 1])
                i += 2
                continue
            out.append(inner[i])
            i += 1
        return ''.join(out)
    return _unescape_text(value)


def _format_value(text: str) -> str:
    if not text or any(ch in text for ch in ':#\n\r\t"') or text != text.strip():
        escaped = (
            text.replace('\\', '\\\\')
            .replace('"', '\\"')
            .replace('\n', '\\n')
            .replace('\r', '\\r')
            .replace('\t', '\\t')
        )
        return f'"{escaped}"'
    return text


def to_editor_text(text_labels: dict) -> str:
    lines: list[str] = []
    for label in sorted(text_labels.keys()):
        display = components_to_display(text_labels[label])
        lines.append(f'{label}: {_format_value(display)}')
    return '\n'.join(lines) + ('\n' if lines else '')


def from_editor_text(text: str) -> dict[str, list]:
    labels: dict[str, list] = {}
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith('#'):
            continue
        colon = line.find(':')
        if colon < 0:
            continue
        label = line[:colon].strip()
        value = _parse_value(line[colon + 1 :])
        labels[label] = display_to_components(value)
    return labels
