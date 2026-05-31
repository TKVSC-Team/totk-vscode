import sys
from pathlib import Path
sys.path.append(str(Path('e:/Nintendo Stuff/TOTK/TOTK Searcher Dev/totk-vscode/totk-vscode/python').resolve()))
from txtg_reader import read_txtg_texture_result
data = Path(r"e:/Nintendo Stuff/ROMS/Switch/Tears Dump/romfs/TexToGo/Armor_001_Lower_Alb.1.txtg").read_bytes()
res = read_txtg_texture_result(data, "tex")
print("TXTG Meta:", res.get("metadata", {}).get("misc"))
