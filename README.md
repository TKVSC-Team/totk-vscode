# totk-vscode [TKVSC]

TKVSC is a Visual Studio Code extension for editing and browsing **Tears of the Kingdom** (**TotK**) game files.

## Features


### Supported Filetypes 


#### Text Editor
- BYML
- BGYML
- AAMP
- MSBT
- ASB (Changes automatically applied to corresponding BAEV)
- BAEV (Changes automatically applied to corresponding ASB)
- XLINK

#### Node Editor

- AINB (definitely works btw)

---

### Activity Bar Tabs

Preview and edit subfiles of SARC and BNTX archives

**Your Mods**
- Add the current folder open in VS Code to a list of Project Folders.

**TotK Dump**
- Browse your dump of TotK in Read-Only mode. Right click to add a file to the correct romfs path within a Project Folder of your choosing

### Additional capabilities:

- Archives within archives (e.g. a `.sarc` inside a `.pack`) can be browsed and edited
- Right-click a file within an archive to export it to a Project Folder.
- File templates: Rather than the typical method of copying, pasting, and wiping an existing file to make a new file of the same format, TKVSC can create empty files of formats supported by the editor.
- Preview `.bntx` subfiles and `.txtg` files as PNGs
- Visual editor for [TKMM](https://tkmm.org) `.tkproj` files
- For files TKVSC does not support, such as `.bfres`, the user can choose external programs to open them in by default (separate from similar features in the OS).

## Setup

### Requirements
* [Python 3.12](https://www.python.org/downloads/release/python-31213/)
* Node.js
* Valid TotK dump

### Steps
1. Install the extension (VSIX).
2. Follow the prompt to select your romfs dump path.


### Python troubleshooting

**`python3` works in CMD but the extension cannot find Python?** Cursor and VS Code are often launched without your full user PATH (unlike a terminal you opened yourself). Fix:

1. **TOTK: Select Python (from detected installs)** - scans `where python3`, common install folders, and `py`.
2. **TOTK: Browse for python.exe** - point at the real interpreter (e.g. `%LocalAppData%\Programs\Python\Python312\python.exe`).
3. Or set **TOTK Editor → Python Path** to that full path, then **TOTK: Set Up Python Environment** again.

If setup fails, run **TOTK: Set Up Python Environment** from the Command Palette.

## Build Instructions

A VSIX file is the installable extension package. Build it from the project root:

```bash
npm install
npm run package:vsix
```

That produces `totk-vscode-0.0.1.vsix` (version comes from `package.json`).


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
