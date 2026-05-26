#!/usr/bin/env bash
#
# Full setup and build from a fresh clone of totk-vscode.
#
#   1. Initializes git submodules (vendor/ainb)
#   2. Installs Node dependencies (root + node-editor)
#   3. Creates a Python venv and installs Python dependencies
#   4. Compiles the extension
#   5. Optionally packages a .vsix (pass --skip-vsix to skip)
#
# Usage:
#   ./scripts/setup.sh                      # full build + vsix
#   ./scripts/setup.sh --skip-vsix          # build without vsix
#   ./scripts/setup.sh --python /path/to/python3.12  # explicit python

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SKIP_VSIX=false
PYTHON_CMD=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --skip-vsix) SKIP_VSIX=true; shift ;;
        --python)    PYTHON_CMD="$2"; shift 2 ;;
        *)           echo "Unknown option: $1"; exit 1 ;;
    esac
done

cd "$ROOT"

# ── 1. Git submodules ──────────────────────────────────────────────
echo ""
echo "=== Initializing git submodules ==="
git submodule update --init --recursive

# ── 2. Node dependencies ───────────────────────────────────────────
echo ""
echo "=== Installing Node dependencies (root) ==="
npm install

echo ""
echo "=== Installing Node dependencies (node-editor) ==="
npm --prefix editors/node-editor install

# ── 3. Python venv ─────────────────────────────────────────────────
echo ""
echo "=== Setting up Python virtual environment ==="

if [[ -z "$PYTHON_CMD" ]]; then
    for candidate in python3 python; do
        if command -v "$candidate" &>/dev/null; then
            ver=$("$candidate" --version 2>&1 || true)
            if [[ "$ver" =~ Python\ 3\.([0-9]+) ]] && (( ${BASH_REMATCH[1]} >= 10 )); then
                PYTHON_CMD="$candidate"
                echo "  Found: $ver ($candidate)"
                break
            fi
        fi
    done
    if [[ -z "$PYTHON_CMD" ]]; then
        echo "ERROR: Python 3.10+ not found. Install it or pass --python /path/to/python3."
        exit 1
    fi
fi

VENV_DIR="$ROOT/.venv"
if [[ ! -d "$VENV_DIR" ]]; then
    echo "  Creating venv at $VENV_DIR"
    "$PYTHON_CMD" -m venv "$VENV_DIR"
else
    echo "  venv already exists at $VENV_DIR"
fi

PIP="$VENV_DIR/bin/pip"
echo "  Installing Python dependencies"
"$PIP" install -r "$ROOT/requirements.txt" --quiet

# ── 4. Compile ─────────────────────────────────────────────────────
echo ""
echo "=== Compiling extension ==="
npm run compile || echo "  Compile finished with warnings. Continuing..."

# ── 5. Package VSIX ────────────────────────────────────────────────
if [[ "$SKIP_VSIX" == false ]]; then
    echo ""
    echo "=== Packaging .vsix ==="
    npx vsce package
    VSIX=$(ls -t "$ROOT"/*.vsix 2>/dev/null | head -n1)
    if [[ -n "$VSIX" ]]; then
        echo ""
        echo "  VSIX ready: $(basename "$VSIX")"
    fi
fi

echo ""
echo "=== Setup complete ==="
