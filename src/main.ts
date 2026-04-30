import { Notice, Platform, Plugin, WorkspaceLeaf, moment } from "obsidian";
import { Buffer as BufferPolyfill } from "buffer";
import { expandCommitMessageTemplate } from "./commitMessage";
import { GitHistoryView } from "./gitHistoryView";
import { GitManager } from "./gitManager";
import { ObsidianGitSettingTab } from "./settings";
import { DEFAULT_SETTINGS, GIT_HISTORY_VIEW_TYPE, GitStatus, ObsidianGitSettings } from "./types";

// Android WebView may not expose a global Buffer symbol, but isomorphic-git
// and its internals rely on it in multiple code paths (pack/index handling).
if (typeof (globalThis as any).Buffer === "undefined") {
  (globalThis as any).Buffer = BufferPolyfill;
}

export default class ObsidianGitPlugin extends Plugin {
  settings: ObsidianGitSettings;
  gitManager: GitManager;
  private readonly debugLogPath = ".obsidian/plugins/vault-git-sync/debug.log";

  private statusBarItem: HTMLElement | null = null;
  private syncRibbonEl: HTMLElement | null = null;
  private historyRibbonEl: HTMLElement | null = null;
  private autoCommitIntervalId: number | null = null;
  private statusRefreshIntervalId: number | null = null;

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async onload(): Promise<void> {
    await this.loadSettings();

    console.info(`[Obsidian Git] loading plugin v${this.manifest.version}`);
    await this.appendDebugLog(`loading plugin v${this.manifest.version}`);

    const adapter = this.app.vault.adapter;
    // On mobile, DataAdapter uses vault-relative paths so dir must be "".
    // getBasePath() is desktop-only; using an absolute path on mobile would
    // break ObsidianFsAdapter which expects paths relative to vault root.
    const vaultPath = Platform.isMobile
      ? ""
      : ((adapter as any).getBasePath?.() ?? (adapter as any).basePath ?? "");
    this.gitManager = new GitManager(vaultPath, this.settings, adapter);

    this.addSettingTab(new ObsidianGitSettingTab(this.app, this));

    this.registerView(GIT_HISTORY_VIEW_TYPE, (leaf) => new GitHistoryView(leaf, this));

    this.registerCommands();
    this.registerRibbon();

    if (this.settings.showStatusBar) {
      this.statusBarItem = this.addStatusBarItem();
      this.statusBarItem.setText("Git: loading…");
    }

    this.setupAutoCommit();
    this.setupStatusRefresh();

    // Initial status update
    this.refreshStatus();
  }

  onunload(): void {
    this.clearAutoCommit();
    this.clearStatusRefresh();
    this.app.workspace.detachLeavesOfType(GIT_HISTORY_VIEW_TYPE);
  }

  // -------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.gitManager?.updateSettings(this.settings);
  }

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  private registerCommands(): void {
    // --- Sync (commit + fetch + integrate remote + push) ---
    this.addCommand({
      id: "git-sync",
      name: "Sync with remote (commit, fetch, rebase, push)",
      callback: async () => {
        await this.runGitOp("Sync", async () => {
          await this.syncWithRemote();
          await this.refreshStatus();
        });
      },
    });

    // --- Force sync from remote (destructive) ---
    this.addCommand({
      id: "git-force-sync-from-remote",
      name: "Force sync from remote (destructive, discard local differences)",
      callback: async () => {
        await this.runGitOp("Force Sync", async () => {
          if (!this.settings.enableForceSync) {
            new Notice(
              "Git force sync is disabled. Enable 'Force sync from remote (destructive)' in settings first."
            );
            return;
          }

          const confirmed = window.confirm(
            [
              "Force sync will discard local differences and overwrite local files from remote branch.",
              "Untracked files will be removed (except .obsidian).",
              "Continue?",
            ].join("\n")
          );

          if (!confirmed) {
            new Notice("Git force sync canceled.");
            return;
          }

          await this.gitManager.forceSyncFromRemote();
          new Notice("Git force sync complete. Local vault now matches remote branch (except .obsidian).", 10000);
          await this.refreshStatus();
        });
      },
    });

    // --- Stage all ---
    this.addCommand({
      id: "git-stage-all",
      name: "Stage all changes",
      callback: async () => {
        await this.runGitOp("Stage all", async () => {
          await this.gitManager.stageAll();
          new Notice("Git: all changes staged.");
          await this.refreshStatus();
        });
      },
    });

    // --- Commit ---
    this.addCommand({
      id: "git-commit",
      name: "Commit staged changes",
      callback: async () => {
        await this.runGitOp("Commit", async () => {
          const msg = this.buildCommitMessage();
          await this.gitManager.commit(msg);
          new Notice(`Git: committed — "${msg}"`);
          if (this.settings.autoPushOnCommit) {
            await this.push();
          }
          await this.refreshStatus();
        });
      },
    });

    // --- Stage all + commit ---
    this.addCommand({
      id: "git-stage-all-and-commit",
      name: "Stage all and commit",
      callback: async () => {
        await this.runGitOp("Stage all & commit", async () => {
          const msg = this.buildCommitMessage();
          await this.gitManager.stageAllAndCommit(msg);
          new Notice(`Git: staged & committed — "${msg}"`);
          if (this.settings.autoPushOnCommit) {
            await this.push();
          }
          await this.refreshStatus();
        });
      },
    });

    // --- Push ---
    this.addCommand({
      id: "git-push",
      name: "Push to remote",
      callback: async () => {
        await this.runGitOp("Push", async () => {
          if (this.settings.pullBeforePush) {
            await this.gitManager.pull();
          }
          await this.push();
          await this.refreshStatus();
        });
      },
    });

    // --- Fetch ---
    this.addCommand({
      id: "git-fetch",
      name: "Fetch from remote",
      callback: async () => {
        await this.runGitOp("Fetch", async () => {
          await this.gitManager.fetch();
          new Notice("Git: fetch complete.");
          await this.refreshStatus();
        });
      },
    });

    // --- Pull (merge) ---
    this.addCommand({
      id: "git-pull",
      name: "Pull from remote",
      callback: async () => {
        await this.runGitOp("Pull", async () => {
          await this.gitManager.pull();
          new Notice("Git: pull complete.");
          await this.refreshStatus();
        });
      },
    });

    // --- Rebase ---
    this.addCommand({
      id: "git-rebase",
      name: "Rebase onto remote branch",
      callback: async () => {
        await this.runGitOp("Rebase", async () => {
          await this.gitManager.rebase();
          new Notice("Git: rebase complete.");
          await this.refreshStatus();
        });
      },
    });

    // --- Init ---
    this.addCommand({
      id: "git-init",
      name: "Initialize git repository in vault",
      callback: async () => {
        await this.runGitOp("Init", async () => {
          await this.gitManager.init();
          new Notice("Git: repository initialized.");
          await this.refreshStatus();
        });
      },
    });

    // --- Status ---
    this.addCommand({
      id: "git-show-status",
      name: "Show git status",
      callback: async () => {
        await this.runGitOp("Status", async () => {
          const status = await this.gitManager.status();
          const lines: string[] = [];
          lines.push(`Branch: ${status.current ?? "unknown"}`);
          lines.push(`Ahead: ${status.ahead}  Behind: ${status.behind}`);
          if (status.staged.length) lines.push(`Staged: ${status.staged.join(", ")}`);
          if (status.modified.length) lines.push(`Modified: ${status.modified.join(", ")}`);
          if (status.not_added.length) lines.push(`Untracked: ${status.not_added.join(", ")}`);
          if (status.deleted.length) lines.push(`Deleted: ${status.deleted.join(", ")}`);
          new Notice(lines.join("\n"), 8000);
        });
      },
    });

    // --- Git history (graph view) ---
    this.addCommand({
      id: "git-open-history",
      name: "Open Git commit graph",
      callback: async () => {
        await this.openGitHistoryView();
      },
    });

    // --- Backup (stage + commit + push) ---
    this.addCommand({
      id: "git-backup",
      name: "Backup vault (stage all, commit, push)",
      callback: async () => {
        await this.runGitOp("Backup", async () => {
          const msg = this.buildCommitMessage();
          await this.gitManager.stageAllAndCommit(msg);
          if (this.settings.pullBeforePush) {
            await this.gitManager.pull();
          }
          await this.push();
          new Notice(`Git: backup complete — "${msg}"`);
          await this.refreshStatus();
        });
      },
    });
  }

  private registerRibbon(): void {
    this.syncRibbonEl = this.addRibbonIcon(
      "refresh-cw",
      "Git Sync (commit, fetch, integrate remote, push)",
      async () => {
        await this.runGitOp("Sync", async () => {
          await this.syncWithRemote();
          await this.refreshStatus();
        });
      }
    );
    this.syncRibbonEl.addClass("obsidian-git-sync-ribbon");

    this.historyRibbonEl = this.addRibbonIcon("git-branch", "Git commit graph", () => {
      void this.openGitHistoryView();
    });
    this.historyRibbonEl.addClass("obsidian-git-sync-ribbon-history");
  }

  /** Open or focus the Git history view (commit graph). */
  async openGitHistoryView(): Promise<void> {
    const leaves = this.app.workspace.getLeavesOfType(GIT_HISTORY_VIEW_TYPE);
    if (leaves.length > 0) {
      const leaf = leaves[0];
      const view = leaf.view;
      if (view instanceof GitHistoryView) {
        await view.reload();
      }
      this.app.workspace.revealLeaf(leaf);
      return;
    }
    const leaf = this.app.workspace.getLeaf(true);
    await leaf.setViewState({ type: GIT_HISTORY_VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  /** Show busy state on open Git history views (toolbar status + disabled buttons). */
  setGitHistoryViewBusy(message: string | null): void {
    let leaves = this.app.workspace.getLeavesOfType(GIT_HISTORY_VIEW_TYPE);
    if (leaves.length === 0) {
      const found: WorkspaceLeaf[] = [];
      this.app.workspace.iterateAllLeaves((leaf) => {
        if (leaf.view.getViewType?.() === GIT_HISTORY_VIEW_TYPE) {
          found.push(leaf);
        }
      });
      leaves = found;
    }
    for (const leaf of leaves) {
      const view = leaf.view;
      if (view instanceof GitHistoryView) {
        view.setToolbarBusy(message);
      }
    }
  }

  /** Reload open Git history views after repo-changing operations. */
  async refreshGitHistoryView(): Promise<void> {
    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, 0);
    });

    let leaves = this.app.workspace.getLeavesOfType(GIT_HISTORY_VIEW_TYPE);
    if (leaves.length === 0) {
      const found: WorkspaceLeaf[] = [];
      this.app.workspace.iterateAllLeaves((leaf) => {
        if (leaf.view.getViewType?.() === GIT_HISTORY_VIEW_TYPE) {
          found.push(leaf);
        }
      });
      leaves = found;
    }

    for (const leaf of leaves) {
      const view = leaf.view as GitHistoryView;
      await view.reload();
    }
  }

  /** Git history view toolbar: same behavior as the command palette entries. */
  async runHistoryToolbarFetch(): Promise<void> {
    this.setGitHistoryViewBusy("Fetching from remote…");
    try {
      await this.runGitOp("Fetch", async () => {
        await this.gitManager.fetch();
        new Notice("Git: fetch complete.");
        await this.refreshStatus();
        await this.refreshGitHistoryView();
      });
    } finally {
      this.setGitHistoryViewBusy(null);
    }
  }

  /**
   * Git history toolbar only: stage all and commit locally.
   * Does not fetch, pull, rebase, or push (unlike command palette / auto-push settings).
   */
  async runHistoryToolbarCommitAll(): Promise<void> {
    this.setGitHistoryViewBusy("Staging and committing…");
    try {
      await this.runGitOp("Stage all & commit", async () => {
        const msg = this.buildCommitMessage();
        await this.gitManager.stageAllAndCommit(msg);
        new Notice(`Git: staged & committed — "${msg}"`);
        await this.refreshStatus();
        await this.refreshGitHistoryView();
      });
    } finally {
      this.setGitHistoryViewBusy(null);
    }
  }

  async runHistoryToolbarRebase(): Promise<void> {
    this.setGitHistoryViewBusy("Rebasing…");
    try {
      await this.runGitOp("Rebase", async () => {
        await this.gitManager.rebase();
        new Notice("Git: rebase complete.");
        await this.refreshStatus();
        await this.refreshGitHistoryView();
      });
    } finally {
      this.setGitHistoryViewBusy(null);
    }
  }

  async runHistoryToolbarPush(): Promise<void> {
    // When settings "Pull before push" is on (default), we run pull() = fetch + integrate — not push-only.
    this.setGitHistoryViewBusy(
      this.settings.pullBeforePush ? "Fetching & integrating remote, then pushing…" : "Pushing…"
    );
    try {
      await this.runGitOp("Push", async () => {
        if (this.settings.pullBeforePush) {
          await this.gitManager.pull();
          this.setGitHistoryViewBusy("Pushing…");
        }
        await this.push();
        await this.refreshStatus();
        await this.refreshGitHistoryView();
      });
    } finally {
      this.setGitHistoryViewBusy(null);
    }
  }

  // -------------------------------------------------------------------------
  // Auto-commit
  // -------------------------------------------------------------------------

  setupAutoCommit(): void {
    this.clearAutoCommit();
    if (!this.settings.autoCommitEnabled || this.settings.autoCommitIntervalMinutes < 1) {
      return;
    }
    const ms = this.settings.autoCommitIntervalMinutes * 60 * 1000;
    this.autoCommitIntervalId = window.setInterval(async () => {
      await this.runGitOp("Auto-commit", async () => {
        const status = await this.gitManager.status();
        const hasChanges =
          status.modified.length > 0 ||
          status.not_added.length > 0 ||
          status.deleted.length > 0 ||
          status.renamed.length > 0;

        if (!hasChanges) return;

        const msg = this.buildCommitMessage();
        await this.gitManager.stageAllAndCommit(msg);
        new Notice(`Git auto-commit: "${msg}"`);

        if (this.settings.autoPushOnCommit) {
          await this.push();
        }
        await this.refreshStatus();
      });
    }, ms);
  }

  private clearAutoCommit(): void {
    if (this.autoCommitIntervalId !== null) {
      window.clearInterval(this.autoCommitIntervalId);
      this.autoCommitIntervalId = null;
    }
  }

  // -------------------------------------------------------------------------
  // Status bar
  // -------------------------------------------------------------------------

  private setupStatusRefresh(): void {
    this.clearStatusRefresh();
    // Refresh every 30 seconds
    this.statusRefreshIntervalId = window.setInterval(() => {
      this.refreshStatus();
    }, 30 * 1000);
  }

  private clearStatusRefresh(): void {
    if (this.statusRefreshIntervalId !== null) {
      window.clearInterval(this.statusRefreshIntervalId);
      this.statusRefreshIntervalId = null;
    }
  }

  updateStatusBarVisibility(): void {
    if (this.settings.showStatusBar && !this.statusBarItem) {
      this.statusBarItem = this.addStatusBarItem();
      this.refreshStatus();
    } else if (!this.settings.showStatusBar && this.statusBarItem) {
      this.statusBarItem.remove();
      this.statusBarItem = null;
    }
  }

  private async refreshStatus(): Promise<void> {
    if (!this.statusBarItem) return;
    try {
      const isRepo = await this.gitManager.isGitRepository();
      if (!isRepo) {
        this.statusBarItem.setText("Git: not a repo");
        return;
      }
      const status = await this.gitManager.status();
      const branch = status.current ?? "?";
      const changed =
        status.modified.length +
        status.not_added.length +
        status.deleted.length +
        status.staged.length;
      const ahead = status.ahead ?? 0;
      const behind = status.behind ?? 0;

      let text = `Git: ${branch}`;
      if (changed > 0) text += ` (${changed}✎)`;
      if (ahead > 0) text += ` ↑${ahead}`;
      if (behind > 0) text += ` ↓${behind}`;
      this.statusBarItem.setText(text);
    } catch {
      this.statusBarItem.setText("Git: error");
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private buildCommitMessage(): string {
    const date = moment().format("YYYY-MM-DD HH:mm:ss");
    return expandCommitMessageTemplate(this.settings.commitMessageTemplate, date);
  }

  private async appendDebugLog(message: string): Promise<void> {
    if (!this.settings?.debugLogEnabled) {
      return;
    }

    const line = `[${moment().format("YYYY-MM-DD HH:mm:ss")}] ${message}\n`;
    const adapter = this.app.vault.adapter as any;
    try {
      if (typeof adapter.append === "function") {
        await adapter.append(this.debugLogPath, line);
        return;
      }

      let existing = "";
      try {
        existing = await adapter.read(this.debugLogPath);
      } catch {
        existing = "";
      }
      await adapter.write(this.debugLogPath, `${existing}${line}`);
    } catch (e) {
      console.error("[Obsidian Git] failed to write debug log", e);
    }
  }

  private logStatusSnapshot(label: string, status: GitStatus): void {
    console.info(`[Obsidian Git] ${label}`, {
      current: status.current,
      ahead: status.ahead,
      behind: status.behind,
      staged: status.staged,
      modified: status.modified,
      not_added: status.not_added,
      deleted: status.deleted,
      renamed: status.renamed,
      conflicted: status.conflicted,
    });

    const changedFiles = [
      ...status.staged.map((filepath) => `staged:${filepath}`),
      ...status.modified.map((filepath) => `modified:${filepath}`),
      ...status.not_added.map((filepath) => `untracked:${filepath}`),
      ...status.deleted.map((filepath) => `deleted:${filepath}`),
      ...status.renamed.map((filepath) => `renamed:${filepath}`),
      ...status.conflicted.map((filepath) => `conflicted:${filepath}`),
    ];
    console.info(`[Obsidian Git] ${label} changed files`, changedFiles);
  }

  private collectPendingFiles(status: GitStatus): Set<string> {
    return new Set([
      ...status.staged,
      ...status.modified,
      ...status.not_added,
      ...status.deleted,
      ...status.renamed,
    ]);
  }

  private pendingStillUnstaged(pending: Set<string>, status: GitStatus): string[] {
    const staged = new Set(status.staged);
    const unstagedNow = new Set([
      ...status.modified,
      ...status.not_added,
      ...status.deleted,
      ...status.renamed,
    ]);
    return [...pending].filter((file) => unstagedNow.has(file) && !staged.has(file));
  }

  private async push(): Promise<void> {
    if (!this.settings.remoteUrl?.trim()) {
      new Notice("Git: remote URL not configured. Skipping push.");
      return;
    }
    await this.gitManager.push();
    new Notice("Git: push complete.");
  }

  private async syncWithRemote(): Promise<void> {
    // Unified sync (desktop + mobile, isomorphic-git):
    // 1) stage & commit all local changes (.gitignore respected; .git/ never staged)
    // 2) fetch
    // 3) integrate remote (rebase-style: fast-forward, else merge; true rebase N/A in engine)
    // 4) push
    // Conflicts: merge/rebase step throws; user must resolve, stage, sync again.

    // On first-time mobile setup (or after git init without commits) the repo
    // has no local HEAD.  Bootstrap from remote automatically so the user
    // doesn't have to run "Force sync" manually.
    const hasHead = await this.gitManager.isGitRepository();
    if (!hasHead) {
      if (!this.settings.remoteUrl) {
        throw new Error(
          "No local git repository found and no remote URL configured.\n" +
            "Set the remote URL in settings, then sync again."
        );
      }
      new Notice("Git: No local commits found. Fetching from remote to set up repository…");
      await this.gitManager.forceSyncFromRemote();
      new Notice("Git: Repository initialized from remote. Future syncs will use the normal flow.");
      return;
    }

    try {
      const before = await this.gitManager.status();
      this.logStatusSnapshot("sync before", before);
      const hasLocalChanges =
        before.modified.length > 0 ||
        before.not_added.length > 0 ||
        before.deleted.length > 0 ||
        before.renamed.length > 0 ||
        before.staged.length > 0;

      if (hasLocalChanges) {
        const msg = this.buildCommitMessage();
        const pending = this.collectPendingFiles(before);
        let staged = before;
        const maxStageAttempts = 3;

        for (let attempt = 1; attempt <= maxStageAttempts; attempt++) {
          await this.gitManager.stageAll();
          staged = await this.gitManager.status();
          this.logStatusSnapshot(`sync after stageAll attempt ${attempt} before commit`, staged);

          const remaining = this.pendingStillUnstaged(pending, staged);
          if (remaining.length === 0) {
            break;
          }

          if (attempt < maxStageAttempts) {
            console.warn("[Obsidian Git] stageAll left files unstaged; retrying", {
              attempt,
              remaining,
            });
          } else {
            console.warn("[Obsidian Git] some files remained unstaged before commit", {
              remaining,
            });
          }
        }

        await this.gitManager.commit(msg);
        const committed = await this.gitManager.status();
        this.logStatusSnapshot("sync after local commit", committed);
        new Notice(`Git sync: committed local changes — "${msg}"`);
      } else {
        console.info("[Obsidian Git] sync skipped local commit: no local changes detected");
      }

      if (!this.settings.remoteUrl?.trim()) {
        new Notice("Git sync: local commit only (no remote URL configured).");
        return;
      }

      await this.gitManager.fetch();
      const afterFetch = await this.gitManager.status();
      this.logStatusSnapshot("sync after fetch", afterFetch);

      await this.gitManager.integrateRemoteAfterFetch({ integration: "rebase" });

      const after = await this.gitManager.status();
      this.logStatusSnapshot("sync after integrate remote", after);
      if (after.conflicted.length > 0) {
        throw new Error(
          this.buildConflictHelp(
            `Conflict in: ${after.conflicted.join(", ")}. Resolve markers in those files, then stage and sync again.`
          )
        );
      }

      await this.push();
      const afterPush = await this.gitManager.status();
      this.logStatusSnapshot("sync after push", afterPush);
      new Notice("Git sync: complete.");
    } catch (e) {
      const code = typeof e === "object" && e !== null ? (e as { code?: string }).code : undefined;
      if (code === "MergeConflictError" || code === "CheckoutConflictError") {
        throw new Error(
          this.buildConflictHelp(
            e instanceof Error ? e.message : "Merge conflict with remote. Resolve the conflicted files below."
          )
        );
      }
      const raw = e instanceof Error ? e.message : String(e);
      if (this.isConflictError(raw)) {
        throw new Error(this.buildConflictHelp(raw));
      }
      throw e;
    }
  }

  private isConflictError(message: string): boolean {
    const m = message.toLowerCase();
    return (
      m.includes("conflict") ||
      m.includes("could not apply") ||
      m.includes("merge failed") ||
      m.includes("unmerged")
    );
  }

  private buildConflictHelp(reason: string): string {
    return [
      `${reason}`,
      "Conflict resolution:",
      "1) Open the listed files and fix <<<<<<< / ======= / >>>>>>> sections.",
      "2) Run command: \"Git: Stage all changes\" (or stage in your editor).",
      "3) Run command: \"Git: Sync with remote (commit, fetch, rebase, push)\" again.",
    ].join("\n");
  }

  /**
   * Wrapper that catches errors and shows a Notice instead of throwing.
   * Returns true on success, false on failure.
   */
  private async runGitOp(opName: string, fn: () => Promise<void>): Promise<boolean> {
    await this.appendDebugLog(`START ${opName}`);
    try {
      await fn();
      if (opName === "Status") {
        const status = await this.gitManager.status();
        await this.appendDebugLog(
          `STATUS snapshot staged=${status.staged.length} modified=${status.modified.length} untracked=${status.not_added.length} deleted=${status.deleted.length}`
        );
        await this.appendDebugLog(
          `STATUS files ${[
            ...status.staged.map((f) => `staged:${f}`),
            ...status.modified.map((f) => `modified:${f}`),
            ...status.not_added.map((f) => `untracked:${f}`),
            ...status.deleted.map((f) => `deleted:${f}`),
          ].join(", ")}`
        );
      }
      await this.appendDebugLog(`SUCCESS ${opName}`);
      return true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      new Notice(`Git ${opName} failed:\n${msg}`, 10000);
      console.error(`[Obsidian Git] ${opName} failed:`, e);
      await this.appendDebugLog(`FAILED ${opName}: ${msg}`);
      return false;
    }
  }
}
