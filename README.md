# Obsidian Git

An [Obsidian](https://obsidian.md) plugin that turns your vault into a git-managed repository.  
Run `add`, `commit`, `push`, `fetch`, `pull`, and `rebase` directly from Obsidian, and configure your remote URL and authentication without ever touching the terminal.

> **Desktop only** — requires the desktop (Electron) version of Obsidian.

---

## Features

| Feature | Details |
|---|---|
| **Stage & Commit** | Stage all changes and commit with a customisable message template |
| **Push / Fetch / Pull** | Interact with any HTTPS or SSH remote |
| **Rebase** | Rebase the current branch onto the configured remote branch |
| **Git Sync** | One-click sync: fetch → rebase → commit local changes → push |
| **Force sync (destructive)** | Optional one-way remote → local overwrite that discards local differences |
| **Backup command** | One-click: stage all → commit → (pull →) push |
| **Auto-commit** | Commit on a configurable schedule (1 – 120 minutes) |
| **Remote configuration** | Set remote URL, name, and branch from the settings panel |
| **Authentication** | Username + personal access token (PAT) for HTTPS remotes; SSH key via your system agent |
| **Status bar** | Live display of branch, changed-file count, and ahead/behind counts |
| **Ribbon button** | Left ribbon shortcut for Git Sync |

---

## Installation

### Manual installation

1. Download `main.js`, `manifest.json`, and `styles.css` (if present) from the [latest release](../../releases/latest).
2. Copy the files into `.obsidian/plugins/obsidian-git/` inside your vault.
3. Enable the plugin in **Settings → Community plugins**.

### Building from source

```bash
git clone https://github.com/MichaelLing83/Obsidian-git.git
cd Obsidian-git
npm install
npm run build        # produces main.js
```

Copy `main.js` and `manifest.json` to `.obsidian/plugins/obsidian-git/` and enable the plugin.

---

## Configuration

Open **Settings → Obsidian Git** to configure the plugin.

### Remote Repository

| Setting | Description |
|---|---|
| **Remote URL** | HTTPS (`https://github.com/user/repo.git`) or SSH (`git@github.com:user/repo.git`) URL |
| **Remote name** | Git remote alias, usually `origin` |
| **Branch** | Branch to push to / pull from, e.g. `main` |

Click **Apply** to persist the remote URL to your local git configuration.

### Authentication

| Setting | Description |
|---|---|
| **Username** | Your git-hosting username (GitHub, GitLab, …). HTTPS only. |
| **Personal access token / password** | PAT or password. Stored in the plugin data file — keep your vault private. For SSH remotes, leave empty. |

> **Note:** credentials are embedded in the remote URL only during network operations and are immediately removed afterwards so they are never written to `.git/config`.

### Commit

| Setting | Description |
|---|---|
| **Commit message template** | Use `{{date}}` to insert the current date/time, e.g. `vault backup: {{date}}` |

### Pull / Sync

| Setting | Description |
|---|---|
| **Pull strategy** | `merge` (merge commit) or `rebase` (replay local commits on top of remote) |
| **Pull before push** | Automatically pull before every push to avoid rejected pushes |
| **Enable force sync from remote (destructive)** | Enables a dangerous command that forces local vault content to match remote and discards local differences |

### Auto-commit

| Setting | Description |
|---|---|
| **Enable auto-commit** | Toggle scheduled commits on/off |
| **Interval (minutes)** | How often to auto-commit (1 – 120 min) |
| **Auto-push after commit** | Push automatically after every commit |

---

## Commands

All commands are accessible via the **Command palette** (`Ctrl/Cmd + P`):

| Command | Description |
|---|---|
| `Git: Stage all changes` | `git add -A` |
| `Git: Sync with remote (fetch, rebase, commit, push)` | Fetch remote, rebase local branch, commit local changes, push |
| `Git: Force sync from remote (destructive, discard local differences)` | Overwrite local files from remote branch and discard local differences |
| `Git: Commit staged changes` | Commit with the message template |
| `Git: Stage all and commit` | Stage + commit in one step |
| `Git: Push to remote` | Push (optionally pulls first) |
| `Git: Fetch from remote` | `git fetch` |
| `Git: Pull from remote` | Pull using the configured strategy |
| `Git: Rebase onto remote branch` | `git rebase <remote>/<branch>` |
| `Git: Initialize git repository in vault` | `git init` for a fresh vault |
| `Git: Show git status` | Display a status summary in a notice |
| `Git: Backup vault (stage all, commit, push)` | Full backup in one command |

---

## License

[MIT](LICENSE)

