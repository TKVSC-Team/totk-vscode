<div align="center">
  <img src="https://github.com/TKVSC-Team/totk-vscode/blob/main/graphics/logo/Logo_FancyShading.png" width="300vh">
  <h1>Tears of the Kingdom VSCode Extension</h1>
  
  <a href="https://discord.gg/vwPnX2uB8s">
    <img src="https://img.shields.io/discord/1508590792149827745?style=for-the-badge&logoColor=5865F2&color=5865F2&labelColor=2A2C33&logo=discord&label=discord" alt="Discord"/>
  </a> &nbsp;
  <a href="https://github.com/TKVSC-Team/totk-vscode/releases/latest">
    <img src="https://img.shields.io/github/v/tag/TKVSC-Team/totk-vscode?style=for-the-badge&logoColor=ffffff&color=C71B42&labelColor=2A2C33&logo=github&label=Version" alt="Latest Release"
  </a> &nbsp;
  <a href="https://github.com/TKVSC-Team/totk-vscode">
    <img src="https://img.shields.io/github/stars/TKVSC-Team/totk-vscode?style=for-the-badge&color=FFCB41&labelColor=2A2C33&logo=github" alt="Stars"/>

  </a> &nbsp;
  <a href="https://github.com/TKVSC-Team/totk-vscode/releases">
    <img src="https://img.shields.io/github/downloads/TKVSC-Team/totk-vscode/total?style=for-the-badge&labelColor=2A2C33&color=31c059&logo=data:image/svg%2bxml;base64,PD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iaXNvLTg4NTktMSI/Pg0KPCEtLSBVcGxvYWRlZCB0bzogU1ZHIFJlcG8sIHd3dy5zdmdyZXBvLmNvbSwgR2VuZXJhdG9yOiBTVkcgUmVwbyBNaXhlciBUb29scyAtLT4NCjxzdmcgZmlsbD0iIzMxYzA1OSIgaGVpZ2h0PSI4MDBweCIgd2lkdGg9IjgwMHB4IiB2ZXJzaW9uPSIxLjEiIGlkPSJDYXBhXzEiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyIgeG1sbnM6eGxpbms9Imh0dHA6Ly93d3cudzMub3JnLzE5OTkveGxpbmsiDQoJIHZpZXdCb3g9IjAgMCA0NzEuMiA0NzEuMiIgeG1sOnNwYWNlPSJwcmVzZXJ2ZSI+DQo8Zz4NCgk8Zz4NCgkJPHBhdGggZD0iTTQ1Ny43LDIzMC4xNWMtNy41LDAtMTMuNSw2LTEzLjUsMTMuNXYxMjIuOGMwLDMzLjQtMjcuMiw2MC41LTYwLjUsNjAuNUg4Ny41Yy0zMy40LDAtNjAuNS0yNy4yLTYwLjUtNjAuNXYtMTI0LjgNCgkJCWMwLTcuNS02LTEzLjUtMTMuNS0xMy41cy0xMy41LDYtMTMuNSwxMy41djEyNC44YzAsNDguMywzOS4zLDg3LjUsODcuNSw4Ny41aDI5Ni4yYzQ4LjMsMCw4Ny41LTM5LjMsODcuNS04Ny41di0xMjIuOA0KCQkJQzQ3MS4yLDIzNi4yNSw0NjUuMiwyMzAuMTUsNDU3LjcsMjMwLjE1eiIvPg0KCQk8cGF0aCBkPSJNMjI2LjEsMzQ2Ljc1YzIuNiwyLjYsNi4xLDQsOS41LDRzNi45LTEuMyw5LjUtNGw4NS44LTg1LjhjNS4zLTUuMyw1LjMtMTMuOCwwLTE5LjFjLTUuMy01LjMtMTMuOC01LjMtMTkuMSwwbC02Mi43LDYyLjgNCgkJCVYzMC43NWMwLTcuNS02LTEzLjUtMTMuNS0xMy41cy0xMy41LDYtMTMuNSwxMy41djI3My45bC02Mi44LTYyLjhjLTUuMy01LjMtMTMuOC01LjMtMTkuMSwwYy01LjMsNS4zLTUuMywxMy44LDAsMTkuMQ0KCQkJTDIyNi4xLDM0Ni43NXoiLz4NCgk8L2c+DQo8L2c+DQo8L3N2Zz4=" alt="Downloads"/>
  </a>
</div>

<br />

The **T**ears of the **K**ingdom **V**isual **S**tudio **C**ode Extension or **TKVSC** is a Visual Studio Code extension for editing and browsing **Tears of the Kingdom** (**TotK**) game files.

Our core design philosophy creating this extension is **centralization of tooling concerns**, and **automating the boilerplate of the design process**.

<sup></sub>It also pairs well with **TKMM!**</sup></sub>

**TKVSC** GameBanana page: https://gamebanana.com/tools/22893

## Features
Preview and edit subfiles of SARC and BNTX archives

 <img src="https://github.com/TKVSC-Team/totk-vscode/blob/main/graphics/Promo/SARC_Edit.png" width="300vh">

### Supported Filetypes 


#### Text Editor
- BYML
- BGYML
- AAMP
- MSBT
- ASB (Changes automatically applied to corresponding BAEV)
- BAEV (Changes automatically applied to corresponding ASB)
- XLINK

---

### Activity Bar Tabs

 <img src="https://github.com/TKVSC-Team/totk-vscode/blob/main/graphics/Promo/ActivityBarGuide.png" width="300vh">


**Your Mods**
- Add the current folder open in VS Code to a list of Project Folders.

**TOTK Dump**
- Browse your dump of TOTK in Read-Only mode. Right click to add a file to the correct romfs path within a Project Folder of your choosing

### Additional capabilities:

- Archives within archives (e.g. a `.sarc` inside a `.pack`) can be browsed and edited
- Right-click a file within an archive to export it to a Project Folder.
- File templates: Rather than the typical method of copying, pasting, and wiping an existing file to make a new file of the same format, TKVSC can create empty files of formats supported by the editor.
- Preview `.bntx` subfiles and `.txtg` files as PNGs
- Visual editor for [TKMM](https://tkmm.org) `.tkproj` files
- For files TKVSC does not support, such as `.bfres`, the user can choose external programs to open them in by default (separate from similar features in the OS).

 <img src="https://github.com/TKVSC-Team/totk-vscode/blob/main/graphics/Promo/tkproj_Edit.png" width="300vh">

## Canonical Path Saving

The canonical path of a file is where the file exists in the game's memory, as opposed to the romfs path which describes its location within a game dump. Using the romfs file located at `\Pack\Actor\Armor_001_Head.pack.zs\Component\ArmorParam\Armor_001_Head.game__component__ArmorParam.bgyml` as an example, the canonical path would be `\Component\ArmorParam\Armor_001_Head.game__component__ArmorParam.bgyml`.

Anyone who has made changes to an upgradeable armor set, or to any parameter file that is parented to a file used in another actor pack, is familiar with needing to make the same edits to an identically named file in several different locations in order for everything to work nicely ingame. TKVSC builds a database of all canonical paths in your game dump and in each of your mod projects and automatically saves changes to all instances of a file's canonical path, pulling files in from the game dump as needed when it isn't already present in your mod project.

To demonstrate with a direct comparison, modifying the defense of every level of the Champion's Leathers would take **15 file modifications without TKVSC**, and only **5 with TKVSC**.

## Planned Features

*( if there are any features you don't see on here, feel free to make an issue on this GitHub! )*

- Node Based Editors (AINB, ASB, BAEV, and EVFL are all planned.)
- BFRES Support (Preview, Editing.)
- Audio Support (BARS, BWAV.)
- Actor Tooling (Automating the process as much as possible.)
- <sub></sup>PTCL/ELink support is being researched but not confirmed. This is uncharted territory.</sup></sub>

## Setup

### Requirements
* [Python 3.12](https://www.python.org/downloads/release/python-31213/)
* Node.js
* Python 3.12-venv (on Linux)
* Valid TOTK dump

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

### Contributing:
We are an open project, and if there are any features you'd like to see, or issues you come across: feel free to make a PR!

### Getting Started:

```bash
npm install
npm run compile
```

Press F5 to launch the Extension Development Host. The dev host uses the same auto-setup logic as production.

Manual Python setup (optional):

```bash
py -3.12 -m pip install .
```

## Credits
### TKVSC Team
**Mind** - Project Lead, Developer\
**The5thTear** - Developer, Research\
**Aster** - Graphics, Documentation

### Third-Parties
**dt13245**: [ASB fork](https://github.com/TKVSC-Team/asb), [AINB fork](https://github.com/TKVSC-Team/AINB), and [XLink2](https://github.com/dt-12345/xlink2) binaries integrated into codebase\
**KillzXGaming**: [Switch Toolbox](https://github.com/KillzXGaming/Switch-Toolbox) - image handling referenced\
**Arch Leaders**: [NX Editor](https://github.com/NX-Editor/NxEditor) - text formatting referenced\
**SolidLink**: [Totkbits](https://github.com/SolidLink95/TotkBits) - Tag.Product and text formatting referenced\
**AeonSake**: [MSBT Editor](https://gitlab.com/AeonSake/msbt-editor) - TotK Config included\
**P1gyy**: [pymsbt fork](https://github.com/TKVSC-Team/pymsbt) integrated into codebase

## Help and Community

- [Discord Server](https://discord.gg/BbVXenRFVc)
<!--- [Documentation]()--->