# How to Dump the RomFS and ExeFS of a Nintendo Switch Game

If you're looking to create mods for Nintendo Switch games, or use mods for games with changelog-based mod managers (such as [BotW](https://gamebanana.com/games/6386) or [TotK](https://gamebanana.com/games/7617)), you'll need to have a dump of your game. In the context of Nintendo Switch games, a dump refers to the files extracted from your cartridge and/or installation of a game.

It is assumed in this tutorial that you already have a modded Nintendo Switch system. If you don't, [this guide](https://switch.hacks.guide/) will help you set it up.

## Dumping Firmware and Keys
#### Dumping `prod.keys` and `title.keys`:
1. Download [Lockpick_RCM.bin](https://github.com/impeeza/Lockpick_RCMDecScots/releases/latest/download/Lockpick_RCM.bin)
2. Put your Modded Switch into RCM and use [TegraRCM GUI](https://github.com/eliboa/TegraRcmGUI/releases) to inject the Lockpick_RCM.bin payload
    * Navigate the menu using Volume Up to move up, Volume Down to move down, and Power to select
3. Select `Dump From Emunand`
4. Return to the menu, and select `Reboot (RCM)`

#### Dumping Firmware
1. Download [`TegraExplorer.bin`](https://github.com/suchmememanyskill/TegraExplorer/releases/download/4.2.0/TegraExplorer.bin)
2. Inject the payload using the same method as above
    * Navigate the menu using the JoyCon Controllers
3. Navigate to `FirmwareDump.te` in the Scripts section
4. Select the script and choose `Dump emummc`, press A to confirm. This may take a few minutes, however the progress is visible onscreen
5. Press any button to return to the main screen once the process has completed, and select `Reboot to RCM` to prepare for the next step

## NX Dump Tool

### Switch MicroSD Setup

#### NXDT Setup:
1. Click [here](https://github.com/DarkMatterCore/nxdumptool/releases/download/rewrite-prerelease/nxdt_rw_poc.nro) to download `nxdt_rw_poc.nro`

2. Connect to the MicroSD card of your modded Nintendo Switch either directly or using Hekate's USB Mass Storage feature
    * To use USB Mass Storage, navigate to the `Tools` tab, then select `USB Tools`, then `SD Card` as shown in the images below

        <img src="https://raw.githubusercontent.com/TKVSC-Team/totk-vscode/refs/heads/main/docs/tutorials/nxdt/nxdt_hekate_tools.bmp" alt="Screenshot of the Tools tab in Hekate" width="80%"/>
3. Move `nxdt_rw_poc.nro` into the `switch\` folder located at the root of the MicroSD Card

#### Moving Keys and Firmware to PC

1. Move `prod.keys` and `title.keys` from the `switch\` folder to your PC, you'll need them later.

2. Return to the root of the MicroSD Card navigate to the `tegraexplorer\Firmware` folder. Copy the folder to your PC, you'll need this later.

3. Eject the MicroSD within the file explorer
    * If you did not use Hekate's USB Mass Storage, at this point you can eject the MicroSD Card, put it back in your Nintendo Switch, and boot into Hekate.

4. Launch back into Atmosphere

### PC-Side Setup

#### Windows Users:
1. Download and install [Zadig Drivers](https://zadig.akeo.ie/)
2. Download and extract [`nxdt_host.7z`](https://github.com/DarkMatterCore/nxdumptool/releases/download/rewrite-prerelease/nxdt_host.7z)
3. Launch `nxdt_host.exe` from where you extracted the .7z to

#### MacOS Users:
1. Download [`nxdt_host_mac.zip`](https://github.com/DarkMatterCore/nxdumptool/releases/download/rewrite-prerelease/nxdt_host_mac.zip)
2. Extract `nxdt_host_mac.zip` into your `Applications` folder
3. The first time you launch the app, you'll need to right click the .app folder, select `Open` and then `Open` once again on the dialog that appears
    * For subsequent launches you will be able to open it normally
4. Set the `Output directory` to a location of your choosing, you'll need it later

#### Linux Users:
*Linux users will need Flathub*

1. Run `flatpak install flathub org.v1993.NXDumpClient`
2. If it doesn't appear on your desktop, you can launch it by running `flatpak run org.v1993.NXDumpClient`, and follow any additional onscreen instructions
3. Optionally, press `Ctrl + P` to open a Preferences window and set the destination directory for the game dump

### Dumping XCI/NSP

On your modded Nintendo Switch, navigate to the Homebrew Menu by holding `R` on your controller while launching any game. Navigate to `nxdt_rw_poc` as shown below and launch it.

<img src="https://raw.githubusercontent.com/TKVSC-Team/totk-vscode/refs/heads/main/docs/tutorials/nxdt/nxdt_homebrewmenu.jpg" alt="Homebrew Menu screenshot with nxdt_rw_poc selected" width="80%"/> 



You should be presented with a screen similar to the one below:

<img src="https://raw.githubusercontent.com/TKVSC-Team/totk-vscode/refs/heads/main/docs/tutorials/nxdt/nxdt_nxdt_main.jpg" alt="Main menu of NX Dump Tool" width="80%"/>

Depending on what you want to dump, you will either select `gamecard menu`, `user titles menu`, or possibly both. The `gamecard menu` is for dumping from a cartridge. This will include a `.xci` file containing the basegame and any bundled updates and/or DLC. The `user titles` menu is for anything digitally installed to your system. This will result in you performing multiple dumps to extract the basegame, installed update, DLC, and DLC update where applicable. 

If you want to dump The Legend of Zelda: Tears of the Kingdom, for example, and you bought the physical version on its release date, you'll need to go through the `gamecard menu` to dump the `.xci` containing the base version of the game, and the `user titles menu` to dump the `.nsp` containing the update that's installed on your system.

Regardless of what dump you're making, ensure that on your PC you have the NX Dump Tool Host Client open that you set up earlier, and that your Nintendo Switch is connected via USB to your PC, and click `Start Server` if the prompt appears.

#### Dumping Game Card Content
1. Choose `gamecard menu`
2. Ensure that `output storage` is set to `usb host (pc)` as shown below

    <img src="https://raw.githubusercontent.com/TKVSC-Team/totk-vscode/refs/heads/main/docs/tutorials/nxdt/nxdt_nxdt_gamecard.jpg" alt="MaDump configuration screen for game cards within NX Dump Tool" width="90%">

3. Select `dump gamecard image (xci)`

Wait for the process to complete. Both the Nintendo Switch and Host Client will display the progress of the dump.

#### Dumping Installed Content
1. Choose `user titles menu`
2. Select the title you'd like to dump content for from the list
3. Choose `nsp dump options`
4. Choose the content type you'd like to dump. You will need at *least* the `base application`, and it is recommended to dump the latest update as well, as the update only contains the modified files relative to the basegame, not the full game
5. Ensure that `output storage` is seto to `usb host (pc)` as shown below

    <img src="https://raw.githubusercontent.com/TKVSC-Team/totk-vscode/refs/heads/main/docs/tutorials/nxdt/nxdt_nxdt_usertitles_dumpscreen.jpg" alt="Dump configuration screen for user titles within NX Dump Tool" width="90%">

6. Select `start nsp dump`

Repeat the above steps for all content you'd like to have copies of on your PC.

#### Collecting Dumped Files
Once the game dump process completes, locate the produced files and move them to a location of your choosing, which will be referred to as the `Game Executables` folder. On MacOS and Linux, you should have set these up earlier. On Windows, the files will be located in subfolders within the directory containing `nxdt_host.exe`.

Now that we have the game executables, we'll set up the emulator Ryubing to extract their contents, which are needed to create mods.

## Ryubing Setup
The amazing team behind Ryubing has already created a [comprehensive setup guide](https://docs.ryujinx.app/guides/setup-guide/), so I'm not going to try and replace it. During setup, you'll need to be able to locate your `Game Executables` folder alongside the Firmware folder and `.keys` files that you copied off of the MicroSD Card earlier in this guide. Come back once you've followed that guide.

At this point, you should see your games in Ryubing. Right click on a game and hover over `Extract Data`. For all games, you will see the `ExeFS`, `RomFS`, and `Logo` options. For games that you have installed DLC for, you will also see the `DLC RomFS` option. See the below image for reference:

<img src="https://raw.githubusercontent.com/TKVSC-Team/totk-vscode/refs/heads/main/docs/tutorials/nxdt/nxdt_ryubing_extractdata.png" alt="Context menu on Ryubing's main screen for Breath of the Wild. Extract Data is being hovered over, and showing the four aforementioned options" width="80%">

Regardless of what type of mods you make, you should create a RomFS dump. For creating mods that involve writing and compiling code, you will also need to create an ExeFS dump. After selecting the type of dump you'd like to make, create a folder for the files to go in. Each dump type should go in a separate empty folder.

Congratulations, you now have a dump of your game ready to create mods with!