# TKVSC Addon Development

TKVSC supports **companion VS Code extensions** (addons) that extend the editor with tools, custom editors, and (in future phases) game-specific formats.

This guide covers how addons integrate with core TKVSC. For the programmatic API surface, see the versioned references under [docs/api/](api/).

## Requirements

- TKVSC installed and enabled (`TKVSC-Team.totk-vscode`)
- Your addon declares a dependency on core:

```json
{
  "extensionDependencies": [
    "TKVSC-Team.totk-vscode"
  ]
}
```

- Pin a minimum TKVSC version in your addon README or `package.json` `engines` once we publish semver guarantees. Today, match the API version your addon targets (see below).

## Getting the API

```typescript
import * as vscode from 'vscode';
import type { TkvscApi } from 'totk-vscode'; // types: see docs/api/v1.md until @tkvsc/api is published

export async function activate(context: vscode.ExtensionContext) {
  const ext = vscode.extensions.getExtension('TKVSC-Team.totk-vscode');
  const api = await ext?.activate() as TkvscApi | undefined;
  if (!api) {
    return;
  }

  if (api.apiVersion !== 1) {
    void vscode.window.showErrorMessage(
      `This addon requires TKVSC API v1 (got v${api.apiVersion}).`,
    );
    return;
  }

  // Wait for projects tree + core services, or run immediately if already ready:
  api.onDidReady(() => {
    // safe to assume archive tree is registered
  });
}
```

## Integration models

| Model | When to use |
|-------|-------------|
| **Standard VS Code contributes** | Commands, menus, custom editors, grammars, settings - no TKVSC API required beyond optional helpers |
| **`contributes.tkvsc` manifest** | Declarative file formats, game profiles, AAMP extensions, archive patterns, Python bridge handlers |
| **TKVSC programmatic API** | Project tree context, raw file I/O inside archives, Python bridge access, runtime format registration |

## Declarative formats (`contributes.tkvsc`)

Declare formats in your addon `package.json`. Core merges them with built-in TotK formats and writes a handler manifest for the Python bridge.

```json
{
  "contributes": {
    "tkvsc": {
      "formats": [
        {
          "extensions": ["ainb"],
          "handler": "ainb",
          "language": "yaml",
          "editable": false
        }
      ],
      "bridgeHandlers": [
        {
          "kind": "ainb",
          "modulePath": "./python/ainb_io.py"
        }
      ]
    }
  }
}
```

Python module contract (addon-provided):

```python
def read_content(file_data: bytes, logical_path: str, romfs_path: str = "") -> str: ...


def write_content(
    original: bytes, editor_text: str, logical_path: str, romfs_path: str = ""
) -> bytes: ...
```

Function names default to `read_content` / `write_content` and can be overridden per handler.

You can also register at runtime:

```typescript
api.registerFormatHandler({ extensions: ['ainb'], handler: 'ainb', language: 'yaml', editable: false });
api.registerBridgeHandler({
  kind: 'ainb',
  modulePath: path.join(context.extensionPath, 'python', 'ainb_io.py'),
});
```

See [api/v1.md](api/v1.md) for full field reference.

## Game addons (`gameProfile`)

Game addons register a profile so TKVSC knows how to validate dumps, compress `.zs` files, and index archives:

```json
{
  "contributes": {
    "tkvsc": {
      "id": "splatoon3",
      "gameProfile": {
        "displayName": "Splatoon 3",
        "romfsSentinel": "Pack/Bootup.Nin_NX_NVN.pack.zs",
        "compressionBackend": "plain-zstd-yaz0",
        "romfsSettingsKey": "splatoon3.romfsPath",
        "indexing": {
          "enableRomfsSearch": true,
          "enableCanonicalPaths": false
        },
        "ainb": {
          "categoryDirs": ["AI", "Sequence"],
          "nodeDefinitionGlob": "{category}/NodeDefinition/Node.Product.*.aidefn.byml*"
        }
      },
      "archivePatterns": ["\\.(pack|sarc|genvb)(\\.zs)?$"],
      "formats": [
        { "extensions": ["byml", "bgyml"], "handler": "byml", "language": "byml", "editable": true }
      ]
    },
    "configuration": {
      "title": "Splatoon 3 (TKVSC)",
      "properties": {
        "TKVSC.splatoon3.romfsPath": {
          "type": "string",
          "default": "",
          "description": "Path to your Splatoon 3 RomFS dump."
        }
      }
    }
  }
}
```

Users switch the active profile with `TKVSC.activeGameId`. Each game gets its own search index under `globalStorage/indexes/{gameId}/`.

TotK remains the built-in default (`config/games/totk.json`); canonical path sync is TotK-specific and should be disabled for other games.

## Project adapters (`ProjectAdapter`)

Use a **project adapter** when your mod tool uses a different folder layout than TKMM (e.g. BCML, loose romfs projects):

```typescript
const api = await vscode.extensions.getExtension('TKVSC-Team.totk-vscode')?.activate();

api.registerProjectAdapter(myBcmlAdapter);
```

Each adapter implements:

- **Detection** - `isProjectRoot(path)` 
- **Options tree** - `optionsDirName`, `contextValues` for menu `when` clauses
- **Import** - optional `importProjects()` (like TKMM `recent.json`)
- **Scaffold** - optional `scaffoldNewProject()` for “create project” flows

TKMM is the built-in adapter (`id: 'tkmm'`). `resolveProjectRoot()` and the Projects sidebar consult whichever adapter matches the folder.

See [`src/projectAdapters/tkmmAdapter.ts`](../src/projectAdapters/tkmmAdapter.ts) as the reference implementation.

## Common patterns

### Context menu on a project root

```json
"contributes": {
  "commands": [{
    "command": "my-addon.packageAsTkcl",
    "title": "Package as TKCL"
  }],
  "menus": {
    "view/item/context": [{
      "command": "my-addon.packageAsTkcl",
      "when": "view == totk-editor.archives && viewItem == archiveRoot",
      "group": "2_package@1"
    }]
  }
}
```

Use `api.views.archives` and `api.contextValues.archiveRoot` in code instead of hardcoding strings when possible (same values; see [API v1](api/v1.md)).

### Custom editor with archive read/write

```typescript
const bytes = await api.readRawBytes(document.uri);
// ... parse, edit in webview ...
await api.writeRawBytes(document.uri, serialized);
```

Works for `sarc://`, `totk-disk://`, and `file://` URIs that point inside nested archives.

## API documentation

| Document | Description |
|----------|-------------|
| [api/v1.md](api/v1.md) | **Complete API reference** - every method, type, manifest field, env var, and integration recipe |
| [api/README.md](api/README.md) | API doc index and type source paths |
| [api/CHANGELOG.md](api/CHANGELOG.md) | API version history |

When new API versions ship, a new `vN.md` is added. Breaking changes bump `api.apiVersion`.

## URI schemes (stable)

Addons should treat these schemes as the TKVSC virtual file system:

| Scheme | Writable | Description |
|--------|----------|-------------|
| `sarc` | Yes (in projects) | Project/archive browser |
| `totk-disk` | Yes | On-disk project files with bridge conversion on save |
| `totk-dump` | No | Read-only game dump mirror |

## Settings

User-facing settings use the `TKVSC.*` namespace (see [settings.md](settings.md)). Addon-specific settings should use your own prefix, e.g. `myAddon.cliPath`.

## Further reading

- [commands.md](commands.md) - stable `totk-editor.*` command IDs for menu `when` clauses
- [settings.md](settings.md) - core configuration
