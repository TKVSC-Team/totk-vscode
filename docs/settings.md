# TKVSC Settings

## RomFS Dump Path
The absolute path to your TOTK Dump's romfs folder (the folder does not need to be named romfs).

For example: `C:\Users\Aster\Zelda\TOTK Dumps\140\romfs`

## Python 3.12 Path
The absolute path to `python.exe` on your system. It *must* be **Python 3.12**.

## Canonical Sync Options

### Enable Canonical Sync
This setting enables or disables the Canonical Sync feature.

### Canonical Sync Archive Type Blacklist
Specific file extensions (before the `.zs` for romfs-exposed files) can be added to this list to exclude them from the canonical sync process. By default, `.sarc` is excluded to prevent localization changes from applying to all languages, and `.blarc` is excluded to ensure custom layout archives can be loaded, as the game will only load one at a time, preventing the issues with overlapping canonical paths mentioned above.

### Canonical Sync Prefix Blacklist
Canonical path prefixes in this section are excluded from the canonical sync process. It is left empty by default. An example of a valid entry in this section is `GameParameter\DyeColorParam`.

### Canonical Sync Extension Blacklist
Many `.bgyml` files within archives have a more detailed extension before them. This setting checks for strings at the end of a canonical path, such as `.game__pouchcontent__DyeColorParam.bgyml` for the canonical path `GameParameter\DyeColorParam\Orange.game__pouchcontent__DyeColorParam.bgyml`.

## Additional AAMP Extensions
TOTK has many custom extensions that are actually just AAMP files. We did our best to label the known formats, however if you come across an AAMP file that the editor won't open, add its extensin here (e.g. `.baglblm`) and let us know in the TKVSC Discord server.