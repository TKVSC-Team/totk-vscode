<#
.SYNOPSIS
    Full setup and build from a fresh clone of totk-vscode.
.DESCRIPTION
    1. Initializes git submodules (vendor/ainb)
    2. Installs Node dependencies (root + node-editor)
    3. Creates a Python venv and installs Python dependencies
    4. Compiles the extension
    5. Optionally packages a .vsix
.PARAMETER SkipVsix
    Skip the final .vsix packaging step.
.PARAMETER PythonPath
    Explicit path to a Python 3.10+ interpreter. If omitted, tries py, python3, python.
#>
param(
    [switch]$SkipVsix,
    [string]$PythonPath
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

Push-Location $root
try {
    # ── 1. Git submodules ──────────────────────────────────────────────
    Write-Host "`n=== Initializing git submodules ===" -ForegroundColor Cyan
    git submodule update --init --recursive
    if ($LASTEXITCODE -ne 0) { throw "git submodule update failed" }

    # ── 2. Node dependencies ───────────────────────────────────────────
    Write-Host "`n=== Installing Node dependencies (root) ===" -ForegroundColor Cyan
    npm install
    if ($LASTEXITCODE -ne 0) { throw "npm install failed" }

    Write-Host "`n=== Installing Node dependencies (node-editor) ===" -ForegroundColor Cyan
    npm --prefix editors/node-editor install
    if ($LASTEXITCODE -ne 0) { throw "npm install (node-editor) failed" }

    # ── 3. Python venv ─────────────────────────────────────────────────
    Write-Host "`n=== Setting up Python virtual environment ===" -ForegroundColor Cyan

    if ($PythonPath) {
        $py = $PythonPath
    } else {
        $py = $null
        foreach ($candidate in @('py -3', 'python3', 'python')) {
            $parts = $candidate -split ' '
            $exe = $parts[0]
            $args = if ($parts.Length -gt 1) { $parts[1..($parts.Length-1)] } else { @() }
            try {
                $ver = & $exe @args --version 2>&1
                if ($ver -match 'Python 3\.(\d+)' -and [int]$Matches[1] -ge 10) {
                    $py = $candidate
                    Write-Host "  Found: $ver ($candidate)" -ForegroundColor Green
                    break
                }
            } catch {}
        }
        if (-not $py) { throw "Python 3.10+ not found. Install it or pass -PythonPath." }
    }

    $venvDir = Join-Path $root '.venv'
    if (-not (Test-Path $venvDir)) {
        Write-Host "  Creating venv at $venvDir"
        $parts = $py -split ' '
        $exe = $parts[0]
        $args = if ($parts.Length -gt 1) { $parts[1..($parts.Length-1)] } else { @() }
        & $exe @args -m venv $venvDir
        if ($LASTEXITCODE -ne 0) { throw "venv creation failed" }
    } else {
        Write-Host "  venv already exists at $venvDir"
    }

    $pip = Join-Path $venvDir 'Scripts' 'pip.exe'
    Write-Host "  Installing Python dependencies"
    & $pip install -r (Join-Path $root 'requirements.txt') --quiet
    if ($LASTEXITCODE -ne 0) { throw "pip install failed" }

    # ── 4. Compile ─────────────────────────────────────────────────────
    Write-Host "`n=== Compiling extension ===" -ForegroundColor Cyan
    npm run compile
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  Compile finished with warnings (non-zero exit). Continuing..." -ForegroundColor Yellow
    }

    # ── 5. Package VSIX ────────────────────────────────────────────────
    if (-not $SkipVsix) {
        Write-Host "`n=== Packaging .vsix ===" -ForegroundColor Cyan
        npx vsce package
        if ($LASTEXITCODE -ne 0) { throw "vsce package failed" }
        $vsix = Get-ChildItem $root -Filter '*.vsix' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
        Write-Host "`n  VSIX ready: $($vsix.Name)" -ForegroundColor Green
    }

    Write-Host "`n=== Setup complete ===" -ForegroundColor Green
} finally {
    Pop-Location
}
