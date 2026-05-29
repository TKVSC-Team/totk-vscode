import oead
from byml_editor_format import to_editor_text

byml_doc = oead.byml.Hash(
    {
        "SystemUserParamCount": 0,
        "Strings": oead.byml.Array(["", "Alpha", "AlwaysDisplayDistance"]),
        "FloatVal": 1.0,
    }
)

print("=== oead.byml.to_text ===")
print(oead.byml.to_text(byml_doc))

print("=== to_editor_text ===")
print(to_editor_text(byml_doc))
