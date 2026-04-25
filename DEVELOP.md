# Development Guide

## Prerequisites

- Node.js >= 18
- npm
- [GitHub CLI (`gh`)](https://cli.github.com/) — required for releasing
- [`jq`](https://stedolan.github.io/jq/) — required for releasing

```bash
brew install gh jq
gh auth login
```

## Setup

```bash
npm install
```

## Development

Start the dev build watcher (no type-check, fast rebuild on save):

```bash
npm run dev
```

To test the plugin locally, copy the output files to your vault's plugin directory:

```bash
cp main.js manifest.json ~/path/to/vault/.obsidian/plugins/vault-git-sync/
```

Then reload Obsidian (Ctrl/Cmd + R or disable/enable the plugin in Settings).

## Production Build

Runs TypeScript type-check first, then bundles with esbuild:

```bash
npm run build
```

Output: `main.js` (minified bundle)

## Release

Use the provided `release.sh` script to bump version, build, commit, tag, push, and create a GitHub Release in one step:

```bash
./release.sh <new-version>
# Example:
./release.sh 1.1.0
```

### What the script does

1. **Pre-flight checks** — verifies `gh` and `jq` are installed, current branch is `main`/`master`, and the working tree is clean.
2. **Bump versions** — updates `version` field in `package.json`, `manifest.json`, and adds an entry to `versions.json`.
3. **Build** — runs `npm run build`.
4. **Commit & tag** — creates a commit `chore: release <version>` and a git tag `<version>`.
5. **Push** — pushes the commit and the tag to `origin`.
6. **GitHub Release** — creates a release via `gh release create`, attaching `main.js` and `manifest.json`.

### Files updated per release

| File | Change |
|---|---|
| `package.json` | `version` field |
| `manifest.json` | `version` field |
| `versions.json` | New `"<version>": "<minAppVersion>"` entry |
| `main.js` | Rebuilt bundle |

## Publishing to the Obsidian Community Plugin List

This is a one-time process done after the plugin is ready for public release.

1. Fork [obsidianmd/obsidian-releases](https://github.com/obsidianmd/obsidian-releases).
2. Edit `community-plugins.json` and append:

```json
{
  "id": "vault-git-sync",
  "name": "Vault Git Sync",
  "author": "MichaelLing83",
  "description": "Perform git operations (add, commit, push, fetch, pull, rebase) on your vault and configure remote repository settings.",
  "repo": "MichaelLing83/Obsidian-git"
}
```

3. Submit a Pull Request to `obsidianmd/obsidian-releases`.
4. Wait for the Obsidian team to review and merge. Once merged, the plugin appears in the in-app community plugin browser.

> **Note:** The `repo` field must point to a **public** GitHub repository with a valid GitHub Release containing `main.js` and `manifest.json`.

## Project Structure

```
obsidian-git/
├── src/
│   ├── main.ts          # Plugin entry point, commands, ribbon
│   ├── gitManager.ts    # Git operations (wraps simple-git)
│   ├── settings.ts      # Settings tab UI
│   └── types.ts         # Settings interface and defaults
├── main.js              # Compiled bundle (do not edit manually)
├── manifest.json        # Plugin metadata
├── versions.json        # Version → minAppVersion mapping
├── esbuild.config.mjs   # Build configuration
├── tsconfig.json        # TypeScript configuration
├── release.sh           # Release automation script
└── DEVELOP.md           # This file
```
