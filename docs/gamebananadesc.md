# Tears of the Kingdom Visual Studio Code (TKVSC)
TKVSC is an extension for Microsoft Visual Studio Code tailored to developing TOTK mods. It allows users to directly edit many text-based filetypes and archive contents in a smooth, git-integrated environment.

TKVSC adds two tabs to the left side of VSCode. `TOTK Dump` and `Your Projects`.\
In the `Your Projects` tab, you can add the current open folder in VSCode. Once it's been added, you can edit its files from this tab even if a different folder is open in VSCode.\
In the `TOTK Dump` tab, you can add files and archives from the vanilla game to any of your mod projects.

Supported Filetypes (Text Editor):
* `AAMP`
* `BGYML`
* `BYML`
* `MSBT`
* `XLNK`
* `ASB`
* `BAEV`\
(Corresponding `ASB` and `BAEV` files will have their changes applied to one another automatically when saving)

\
\
But you may be asking, what makes TKVSC different from other text-based file editors for TOTK?

### Canonical Path Saving

The canonical path of a file is where the file exists in the game's memory, as opposed to the romfs path which describes its location within a game dump. Using the romfs file located at `\Pack\Actor\Armor_001_Head.pack.zs\Component\ArmorParam\Armor_001_Head.game__component__ArmorParam.bgyml` as an example, the canonical path would be `\Component\ArmorParam\Armor_001_Head.game__component__ArmorParam.bgyml`.

Anyone who has made changes to an upgradeable armor set, or to any parameter file that is parented to a file used in another actor pack, is familiar with needing to make the same edits to an identically named file in several different locations in order for everything to work nicely ingame. TKVSC builds a database of all canonical paths in your game dump and in each of your mod projects and automatically saves changes to all instances of a file's canonical path, pulling files in from the game dump as needed when it isn't already present in your mod project.

To demonstrate with a direct comparison, modifying the defense of every level of the Champion's Leathers would take 15 file modifications without TKVSC, and only 5 with TKVSC.

For more information, you can visit the project's [GitHub repository](https://github.com/TKVSC-Team/totk-vscode), or join the [TKVSC Discord server](https://discord.gg/vwPnX2uB8s) for support.