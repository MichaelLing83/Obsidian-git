import { Notice, Plugin, moment } from "obsidian";
import { GitManager } from "./gitManager";
import { ObsidianGitSettingTab } from "./settings";
import { DEFAULT_SETTINGS, ObsidianGitSettings } from "./types";

export default class ObsidianGitPlugin extends Plugin {
  settings: ObsidianGitSettings;
  gitManager: GitManager;

  private statusBarItem: HTMLElement | null = null;
  private syncRibbonEl: HTMLElement | null = null;
  private autoCommitIntervalId: number | null = null;
  private statusRefreshIntervalId: number | null = null;

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async onload(): Promise<void> {
    await this.loadSettings();

    const adapter = this.app.vault.adapter;
    const vaultPath = (adapter as any).getBasePath?.() ?? (adapter as any).basePath ?? "";
    this.gitManager = new GitManager(vaultPath, this.settings, adapter);

    this.addSettingTab(new ObsidianGitSettingTab(this.app, this));

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
    // --- Sync (commit + fetch + pull + push) ---
    this.addCommand({
      id: "git-sync",
      name: "Sync with remote (commit, fetch, pull, push)",
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
      "Git Sync (commit, fetch, pull, push)",
      async () => {
        await this.runGitOp("Sync", async () => {
          await this.syncWithRemote();
          await this.refreshStatus();
        });
      }
    );
    this.syncRibbonEl.addClass("obsidian-git-sync-ribbon");
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
    const template = this.settings.commitMessageTemplate || "vault backup: {{date}}";
    const date = moment().format("YYYY-MM-DD HH:mm:ss");
    return template.replace("{{date}}", date);
  }

  private async push(): Promise<void> {
    if (!this.settings.remoteUrl && !this.settings.remoteName) {
      new Notice("Git: remote URL not configured. Skipping push.");
      return;
    }
    await this.gitManager.push();
    new Notice("Git: push complete.");
  }

  private async syncWithRemote(): Promise<void> {
    // Unified sync flow for desktop and mobile:
    // 1) commit local changes, 2) fetch, 3) pull, 4) conflict check, 5) push.
    try {
      const before = await this.gitManager.status();
      const hasLocalChanges =
        before.modified.length > 0 ||
        before.not_added.length > 0 ||
        before.deleted.length > 0 ||
        before.renamed.length > 0 ||
        before.staged.length > 0;

      if (hasLocalChanges) {
        const msg = this.buildCommitMessage();
        await this.gitManager.stageAllAndCommit(msg);
        new Notice(`Git sync: committed local changes — "${msg}"`);
      }

      await this.gitManager.fetch();
      await this.gitManager.pull();

      const after = await this.gitManager.status();
      if (after.conflicted.length > 0) {
        throw new Error(this.buildConflictHelp("Conflict detected after pull."));
      }

      await this.push();
      new Notice("Git sync: complete.");
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      if (this.isConflictError(raw)) {
        throw new Error(this.buildConflictHelp(raw));
      }
      throw e;
    }
  }

  private isConflictError(message: string): boolean {
    const m = message.toLowerCase();
    return m.includes("conflict") || m.includes("could not apply") || m.includes("merge failed");
  }

  private buildConflictHelp(reason: string): string {
    return [
      `${reason}`,
      "Conflict resolution steps:",
      "1) Open conflicted files and resolve <<<<<<< / ======= / >>>>>>> markers.",
      "2) Run command: \"Git: Stage all changes\".",
      "3) If rebase is in progress, continue in terminal: git rebase --continue.",
      "4) Then run command: \"Git: Sync with remote (fetch, rebase, commit, push)\" again.",
      "Tip: If you want to abort current rebase, run: git rebase --abort.",
    ].join("\n");
  }

  /**
   * Wrapper that catches errors and shows a Notice instead of throwing.
   * Returns true on success, false on failure.
   */
  private async runGitOp(opName: string, fn: () => Promise<void>): Promise<boolean> {
    try {
      await fn();
      return true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      new Notice(`Git ${opName} failed:\n${msg}`, 10000);
      console.error(`[Obsidian Git] ${opName} failed:`, e);
      return false;
    }
  }
}
