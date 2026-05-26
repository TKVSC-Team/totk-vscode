# totk-vscode

VS Code support for editing **Tears of the Kingdom** game files.

## Features

- Syntax highlighting for BYML / MSBT
- Browse `.pack` / `.sarc` / `.genvb` / `.blarc` / `.bntx` archives (including `.zs` compressed) as folders
- Edit `.byml` / `.bgyml` as text
- Edit **AAMP** parameter files (`.baglenv`, `.bptcl`, `.bphhb`, and [many other extensions](aamp-extensions.json)) as YAML
- Edit `.msbt` message files as `label: text` lines
- Edit `.asb` animation state binaries as JSON (merges sibling `.baev` when present)
- Edit `.baev` animation event archives as JSON
- Edit `.belnk` / `.bslnk` XLNK sound/effect link databases as YAML (via bundled [xlink_tool](https://github.com/dt-12345/xlink2))
- Syntax highlighting for BYML-style text and MSBT labels (including numeric IDs)

Works with a compressed or decompressed game dump. A game dump **MUST** be provided to edit compressed files.

## Install and use

1. Install the extension (VSIX or Marketplace).
2. On first activation, the extension creates a private Python virtual environment and installs `oead`, `zstandard`, and `pymsbt` automatically.
3. **Requirement:** [Python 3.10+](https://www.python.org/downloads/) must be installed and discoverable (`python` / `python3` on PATH, or Windows `py` launcher).
4. Set **TOTK Editor → Romfs Path** to your extracted game dump (folder containing `Pack/ZsDic.pack.zs`) if you work with `.zs` files.
5. Open your extracted game folder as a normal workspace folder (`file://`), or run **TOTK: Open Archive (.pack, .sarc, .genvb, .blarc, .bntx)** to browse one archive.

**Tip:** Leave **Virtual RomFS Workspace** disabled (default) so Explorer delete/rename work on real files. Enable it only if you want `.pack` files to expand inline in a full-folder workspace.

### Where files can be opened

| Location | How it works |
|----------|----------------|
| **Inside `.pack` / `.sarc` / `.genvb` / `.blarc` / `.bntx`** (via `sarc://` workspace) | Browse the archive like a folder; editable files are converted automatically. |
| **Loose files on disk** (extracted RomFS tree) | Open normally from the explorer — the extension reopens them as editable JSON/text. Or use **TOTK: Open File**. |
| **Single file** | Command **TOTK: Open File (BYML, AAMP, MSBT, ASB, BAEV, belnk, bslnk)** |

Files opened as plain `file://` binary (garbled text) means Python setup failed or the extension did not activate — run **TOTK: Set Up Python Environment** and reload.

### XLNK (.belnk / .bslnk) notes

- Binary files use the `XLNK` magic header. The editor shows them as YAML text (often very large — hundreds of thousands of lines).
- Conversion uses `vendor/xlink2/xlink_tool.exe` on Windows (from [dt-12345/xlink2](https://github.com/dt-12345/xlink2)). On Linux/macOS, place `xlink_tool` there or set **TOTK Editor → Xlink Tool Path** / env `TOTK_XLINK_TOOL`.
- `.belnk.zs` / `.bslnk.zs` need **Romfs Path** set (same as other `.zs` assets) so ZSTD dictionaries apply.

If setup fails, run **TOTK: Set Up Python Environment** from the Command Palette.

**`python3` works in CMD but the extension cannot find Python?** Cursor and VS Code are often launched without your full user PATH (unlike a terminal you opened yourself). Fix:

1. **TOTK: Select Python (from detected installs)** — scans `where python3`, common install folders, and `py`.
2. **TOTK: Browse for python.exe** — point at the real interpreter (e.g. `%LocalAppData%\\Programs\\Python\\Python312\\python.exe`).
3. Or set **TOTK Editor → Python Path** to that full path, then **TOTK: Set Up Python Environment** again.

### `.zs` compressed files

Most TOTK assets use Nintendo ZSTD dictionaries from `Pack/ZsDic.pack.zs` in your game dump. Set **TOTK Editor → Romfs Path** to the root of your extracted **RomFS** (the folder that contains `Pack/ZsDic.pack.zs`). Without this, `.pack.zs` archives and files like `.byml.zs` fail with *dictionary mismatch*.

The extension picks the correct dictionary per file type (pack, bcett BYML, generic `.zs`, etc.) using the bundled [asb-toolkit](https://github.com/dt-12345/asb) ZSTD helpers.

### BYML hashes and IDs

Unsigned 64-bit values (hashes, placement IDs, etc.) are shown in **NX Editor–compatible** form, e.g. `!ul 0x895d6d80d4cda78d`, not as large decimal numbers. Saving preserves the `!ul` type so values do not turn into incorrect negative integers.

If you edited a file with an older build that wrote bare decimals, re-open the file after updating the extension (or save once) so literals are corrected before writing binary BYML.

### AAMP notes

Many TOTK files use different extensions but share the same **AAMP** binary format (magic `AAMP`). The extension converts them to editable YAML via [oead](https://github.com/TotkMods/oead). Syntax highlighting uses VS Code’s built-in **YAML** mode (not the custom BYML colors).

- Built-in extensions are listed in [`aamp-extensions.json`](aamp-extensions.json) (TOTK + common BotW-style names).
- Add more with **TOTK Editor → Extra Aamp Extensions** (extension name only, e.g. `bcustom`).
- Inside archives, files with unknown extensions are still opened if their data starts with `AAMP`.

### ASB / BAEV notes

- Opening an `.asb` file loads the matching `.baev` from the same folder in the archive when it exists (AsNode BAEV).
- Saving an `.asb` writes both `.asb` and `.baev` if the JSON contains BAEV event data.
- Animation BAEV files (paired with `.anim.bfres`) can be opened as standalone `.baev` files.

## Syntax colors

By default, BYML / MSBT use your **editor theme’s normal highlighting** (TextMate grammar only). AAMP files use built-in **YAML** highlighting.

If colors look wrong after upgrading, run **TOTK: Clear Syntax Color Overrides** from the Command Palette, then reload the window.

Optional custom colors: enable **TOTK Editor → Colors: Enabled** and adjust the color settings. Use **TOTK: Reset Syntax Colors to Defaults** to turn that off and clear overrides.

## Bundle and share (`.vsix`)

A VSIX file is the installable extension package. Build it from the project root:

```bash
npm install
npm run package:vsix
```

That produces `totk-vscode-0.0.1.vsix` (version comes from `package.json`). This can be used in VSCode or Cursor.

**Install on another machine**

1. Install [Python 3.10+](https://www.python.org/downloads/) (add to PATH on Windows).
2. In VS Code / Cursor: Extensions view → `...` menu → **Install from VSIX...** → pick the `.vsix` file.
3. Reload the window when prompted.
4. First run will download Python libraries into a private venv (one-time setup notification).


## Development

```bash
npm install
npm run compile
```

Press F5 to launch the Extension Development Host. The dev host uses the same auto-setup logic as production.

Manual Python setup (optional):

```bash
py -3.12 -m pip install -r requirements.txt
```
