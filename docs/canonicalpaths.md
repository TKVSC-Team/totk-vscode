# Canoncial Sync

### Background
There are two types of paths to consider when working with files in TotK. The romfs path, and the canonical path. To explain the differences between these path types, we'll use the following example:

Armor pieces in TotK can be upgraded. The actor for the second tier (1 upgrade) of the Hylian Hood is `Armor_002_Head`. As with all other upgraded armor pieces in the game, the `Component\ArmorParam` subfolder of the actor pack contains two files: `Armor_001_Head.game__component__ArmorParam.bgyml` and `Armor_002_Head.game__component__ArmorParam.bgyml`. The ArmorParam file beginning with `Armor_001_Head` contains the bulk of the data, while the ArmorParam file beginning with `Armor_002_Head` only contains the data that changed between the first and second tiers, and a line marking the `Armor_001_Head` file as its parent, causing it to inherit its data with the exception of the specific entries in the `Armor_002_Head` file.

The romfs path is the path to a file starting from the root of the romfs folder. For example, the romfs path for the `ArmorParam` file of the base-tier Hylian Hood, `Armor_001_Head`, is `\Pack\Actor\Armor_001_Head.pack.zs\Component\ArmorParam\Armor_001_Head.game__component__ArmorParam.bgyml`. 

The canonical path of a file is where the file exists in the game's memory. For that same ArmorParam file, the canonical path would be `\Component\ArmorParam\Armor_001_Head.game__component__ArmorParam.bgyml`. 

The `Armor_001_Head.game__component__ArmorParam.bgyml` has a different romfs path depending on which actor pack it's in, however its canonical path remains the same. As a result, if the contents of each of these identically-named files differ, whichever actor is loaded first ingame will have its subfile take priority even after the second actor is loaded in.

### TKVSC Implementation
To prevent this issue in the past, mod developers would have to manually apply the same edit to all canonical instances of a file. This was extremely tedious. TKVSC builds databases of canonical paths in your provided game dump and in each mod project. When saving a file in your mod project that shares a canonical path with other files, the contents of the file will be saved to all romfs instances of that canonical path. If your mod project does not include one of the romfs instances of the canonical filepath that exists in the game dump, the vanilla file will be automatically copied into the project directory and the changes will be correctly applied.

## Canonical Sync Settings

### Enable Canonical Sync
This setting enables or disables the Canonical Sync feature.

### Archive Type Blacklist
Specific file extensions (before the `.zs` for romfs-exposed files) can be added to this list to exclude them from the canonical sync process. By default, `.sarc` is excluded to prevent localization changes from applying to all languages, and `.blarc` is excluded to ensure custom layout archives can be loaded, as the game will only load one at a time, preventing the issues with overlapping canonical paths mentioned above.

### Prefix Blacklist
Canonical path prefixes in this section are excluded from the canonical sync process. It is left empty by default. An example of a valid entry in this section is `GameParameter\DyeColorParam`.

### Extension Blacklist
Many `.bgyml` files within archives have a more detailed extension before them. This setting checks for strings at the end of a canonical path, such as `.game__pouchcontent__DyeColorParam.bgyml` for the canonical path `GameParameter\DyeColorParam\Orange.game__pouchcontent__DyeColorParam.bgyml`.