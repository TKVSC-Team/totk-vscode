# Contributing to TKVSC

Thanks for your interest in contributing! Here's what you need to know.

## Getting started

1. Fork the repository and clone your fork
2. Run the script to setup the development environment: `scripts/init-dev-env.ps1` (Windows) or `scripts/init-dev-env.sh` (Linux/macOS)
3. Open the project in VS Code and press `F5` to launch the extension in a dev host window

## Before submitting a PR

- Make sure the extension builds: `npm run build`
- Run `npm run fix` to lint and format both TypeScript and Python
- Keep changes focused - one concern per PR
- Reference any related issue in your PR description (e.g. `Closes #123`)
- Don't include unrelated formatting or whitespace changes

## Code style

- TypeScript source lives in `src/`, Python scripts in `python/`, and local dependencies in `vendor/`
- Follow the existing patterns in the file you're editing
- Run `npm run fix` before submitting - this runs both TypeScript and Python linting and formatting in one step

## Questions?

Join the [TKVSC Discord](https://discord.gg/vwPnX2uB8s) if you want to discuss a contribution before starting.
