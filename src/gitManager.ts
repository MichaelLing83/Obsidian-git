import simpleGit, { SimpleGit, SimpleGitOptions, StatusResult } from "simple-git";
import { ObsidianGitSettings } from "./types";

/**
 * GitManager wraps simple-git and provides high-level git operations that
 * honour the plugin settings (remote URL, authentication, pull strategy, …).
 */
export class GitManager {
  private git: SimpleGit;
  private vaultPath: string;
  private settings: ObsidianGitSettings;

  constructor(vaultPath: string, settings: ObsidianGitSettings) {
    this.vaultPath = vaultPath;
    this.settings = settings;
    this.git = this.createGit();
  }

  /** Re-create the git instance (call after settings change) */
  updateSettings(settings: ObsidianGitSettings): void {
    this.settings = settings;
    this.git = this.createGit();
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private createGit(): SimpleGit {
    const options: Partial<SimpleGitOptions> = {
      baseDir: this.vaultPath,
      binary: "git",
      maxConcurrentProcesses: 6,
      trimmed: false,
    };
    return simpleGit(options);
  }

  /**
   * Build an authenticated remote URL for HTTPS remotes.
   * If no token is set the raw URL is returned unchanged.
   * SSH remotes are returned as-is.
   */
  private buildAuthenticatedUrl(url: string): string {
    if (!url) return url;
    if (url.startsWith("git@") || url.startsWith("ssh://")) {
      return url;
    }
    const { authUsername, authToken } = this.settings;
    if (!authToken) return url;

    try {
      const parsed = new URL(url);
      parsed.username = encodeURIComponent(authUsername || authToken);
      parsed.password = encodeURIComponent(authToken);
      return parsed.toString();
    } catch {
      return url;
    }
  }

  // -------------------------------------------------------------------------
  // Public git operations
  // -------------------------------------------------------------------------

  /** Check whether the vault directory is a valid git repository */
  async isGitRepository(): Promise<boolean> {
    try {
      await this.git.status();
      return true;
    } catch {
      return false;
    }
  }

  /** Initialise a new git repository in the vault */
  async init(): Promise<void> {
    await this.git.init();
  }

  /** Get the current git status */
  async status(): Promise<StatusResult> {
    return this.git.status();
  }

  /** Stage all changes (git add -A) */
  async stageAll(): Promise<void> {
    await this.git.add("-A");
  }

  /** Stage specific files */
  async stageFiles(files: string[]): Promise<void> {
    await this.git.add(files);
  }

  /** Commit staged changes with the given message */
  async commit(message: string): Promise<void> {
    await this.git.commit(message);
  }

  /**
   * Stage all changes and commit.
   * Returns the commit message actually used.
   */
  async stageAllAndCommit(message: string): Promise<string> {
    await this.stageAll();
    await this.commit(message);
    return message;
  }

  /** Push to the configured remote and branch */
  async push(): Promise<void> {
    const { remoteName, branch, remoteUrl } = this.settings;
    const authUrl = this.buildAuthenticatedUrl(remoteUrl);

    if (authUrl && authUrl !== remoteUrl) {
      // Temporarily set the remote URL to include credentials
      await this.git.remote(["set-url", remoteName, authUrl]);
    }

    try {
      await this.git.push(remoteName, branch);
    } finally {
      if (authUrl && authUrl !== remoteUrl && remoteUrl) {
        // Restore the original URL so credentials are not stored on disk
        await this.git.remote(["set-url", remoteName, remoteUrl]);
      }
    }
  }

  /** Fetch from the configured remote */
  async fetch(): Promise<void> {
    const { remoteName, remoteUrl } = this.settings;
    const authUrl = this.buildAuthenticatedUrl(remoteUrl);

    if (authUrl && authUrl !== remoteUrl) {
      await this.git.remote(["set-url", remoteName, authUrl]);
    }

    try {
      await this.git.fetch(remoteName);
    } finally {
      if (authUrl && authUrl !== remoteUrl && remoteUrl) {
        await this.git.remote(["set-url", remoteName, remoteUrl]);
      }
    }
  }

  /** Pull from the configured remote using the configured strategy */
  async pull(): Promise<void> {
    const { remoteName, branch, pullStrategy } = this.settings;
    const options = pullStrategy === "rebase" ? ["--rebase"] : [];
    await this.git.pull(remoteName, branch, options);
  }

  /** Rebase the current branch onto the configured remote branch */
  async rebase(): Promise<void> {
    const { remoteName, branch } = this.settings;
    await this.git.rebase([`${remoteName}/${branch}`]);
  }

  /**
   * Destructive one-way sync from remote to local.
   * Local differences are discarded and local files are aligned to remote branch.
   */
  async forceSyncFromRemote(): Promise<void> {
    const { remoteName, remoteUrl, branch } = this.settings;
    if (!remoteUrl) {
      throw new Error("Remote URL is empty. Configure it before force sync.");
    }

    const isRepo = await this.isGitRepository();
    if (!isRepo) {
      await this.git.init();
    }

    await this.setRemote(remoteName, remoteUrl);
    await this.fetch();

    await this.git.raw(["checkout", "-B", branch, `${remoteName}/${branch}`]);
    await this.git.raw(["reset", "--hard", `${remoteName}/${branch}`]);

    // Keep local Obsidian app configuration to avoid breaking the running vault.
    await this.git.raw(["clean", "-fd", "-e", ".obsidian/"]);
  }

  /** Stash local changes, including untracked files */
  async stashPush(message: string): Promise<void> {
    await this.git.raw(["stash", "push", "-u", "-m", message]);
  }

  /** Restore the latest stashed changes */
  async stashPop(): Promise<void> {
    await this.git.raw(["stash", "pop"]);
  }

  /**
   * Configure (or update) the remote.
   * If the remote already exists it is updated via `set-url`;
   * otherwise it is added via `add`.
   */
  async setRemote(name: string, url: string): Promise<void> {
    const remotes = await this.git.getRemotes(false);
    const exists = remotes.some((r) => r.name === name);
    if (exists) {
      await this.git.remote(["set-url", name, url]);
    } else {
      await this.git.addRemote(name, url);
    }
  }

  /** Return the list of remotes */
  async getRemotes(): Promise<Array<{ name: string; refs: { fetch: string; push: string } }>> {
    return this.git.getRemotes(true);
  }

  /** Get the short hash of the last commit on HEAD */
  async getLastCommitHash(): Promise<string> {
    const log = await this.git.log(["--max-count=1"]);
    return log.latest?.hash?.slice(0, 7) ?? "";
  }

  /** Get the name of the current branch */
  async getCurrentBranch(): Promise<string> {
    const status = await this.git.status();
    return status.current ?? "";
  }

  /** List local branches */
  async listBranches(): Promise<string[]> {
    const summary = await this.git.branchLocal();
    return summary.all;
  }

  /** Checkout or create a branch */
  async checkout(branch: string, create = false): Promise<void> {
    if (create) {
      await this.git.checkoutLocalBranch(branch);
    } else {
      await this.git.checkout(branch);
    }
  }
}
