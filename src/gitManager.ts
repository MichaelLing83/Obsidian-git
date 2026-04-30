/**
 * GitManager
 *
 * Uses isomorphic-git for both desktop and mobile to avoid runtime dependency
 * issues with external native wrappers. Desktop uses Node's fs client,
 * while mobile uses Obsidian's DataAdapter wrapper.
 */

import { DataAdapter, Platform } from "obsidian";
import { ObsidianGitSettings, GitStatus } from "./types";
import { ObsidianFsAdapter } from "./fsAdapter";
import * as git from "isomorphic-git";
import obsidianHttpTransport from "./httpTransport";

export class GitManager {
  private vaultPath: string;
  private settings: ObsidianGitSettings;
  private fsClient: any;

  constructor(vaultPath: string, settings: ObsidianGitSettings, adapter?: DataAdapter) {
    this.vaultPath = vaultPath;
    this.settings = settings;

    if (Platform.isMobile) {
      if (!adapter) {
        throw new Error("Obsidian adapter is required on mobile.");
      }
      this.fsClient = new ObsidianFsAdapter(adapter);
    } else {
      this.fsClient = this.createDesktopFsClient();
    }
  }

  updateSettings(settings: ObsidianGitSettings): void {
    this.settings = settings;
  }

  get isDesktop(): boolean {
    return !Platform.isMobile;
  }

  private createDesktopFsClient(): any {
    const runtimeRequire =
      (globalThis as any).require ??
      (typeof require === "function" ? require : undefined) ??
      (typeof module !== "undefined" && (module as any).require ? (module as any).require : undefined);

    if (typeof runtimeRequire !== "function") {
      throw new Error("Node require is unavailable in desktop runtime.");
    }

    try {
      return runtimeRequire("node:fs");
    } catch {
      return runtimeRequire("fs");
    }
  }

  private isoOnAuth = (): { username: string; password: string } => ({
    username: this.settings.authUsername || this.settings.authToken,
    password: this.settings.authToken,
  });

  private async getHttpClient(): Promise<any> {
    // Use Obsidian's requestUrl-backed transport on all platforms.
    // It bypasses CORS on desktop (Electron net module) and works on mobile.
    return obsidianHttpTransport;
  }

  private get fs(): any {
    return this.fsClient;
  }

  private debugLog(message: string, data?: unknown): void {
    if (!this.settings.debugLogEnabled) return;
    if (data === undefined) {
      console.warn(`[Obsidian Git] ${message}`);
      return;
    }
    console.warn(`[Obsidian Git] ${message}`, data);
  }

  private isTimeoutError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    const m = message.toLowerCase();
    return m.includes("err_timed_out") || m.includes("etimedout") || m.includes("timeout");
  }

  private async wait(ms: number): Promise<void> {
    await new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  private async runNetworkOpWithRetry<T>(opName: string, fn: () => Promise<T>): Promise<T> {
    const maxAttempts = 2;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        console.warn(`[Obsidian Git] ${opName} start`, { attempt, maxAttempts });
        console.error(`[Obsidian Git] ${opName} start`, { attempt, maxAttempts });
        const result = await fn();
        console.warn(`[Obsidian Git] ${opName} success`, { attempt, maxAttempts });
        console.error(`[Obsidian Git] ${opName} success`, { attempt, maxAttempts });
        return result;
      } catch (error) {
        lastError = error;
        console.warn(`[Obsidian Git] ${opName} failed`, {
          attempt,
          maxAttempts,
          error: error instanceof Error ? error.message : String(error),
        });
        console.error(`[Obsidian Git] ${opName} failed`, {
          attempt,
          maxAttempts,
          error: error instanceof Error ? error.message : String(error),
        });
        const isTimeout = this.isTimeoutError(error);
        if (!isTimeout || attempt >= maxAttempts) {
          break;
        }

        console.warn(`[Obsidian Git] ${opName} timed out, retrying`, {
          attempt,
          maxAttempts,
          error: error instanceof Error ? error.message : String(error),
        });
        await this.wait(1000);
      }
    }

    if (this.isTimeoutError(lastError)) {
      const original = lastError instanceof Error ? lastError.message : String(lastError);
      throw new Error(
        `${opName} failed: network timeout (${original}).\n` +
          "Check network/VPN/proxy/firewall, then retry."
      );
    }

    throw lastError;
  }

  async isGitRepository(): Promise<boolean> {
    try {
      await git.resolveRef({ fs: this.fs, dir: this.vaultPath, ref: "HEAD" });
      return true;
    } catch {
      return false;
    }
  }

  async init(): Promise<void> {
    await git.init({ fs: this.fs, dir: this.vaultPath });
  }

  async status(): Promise<GitStatus> {
    return this.computeStatus();
  }

  async stageAll(): Promise<void> {
    await this.stageAllWithStatusMatrix();
  }

  async stageFiles(files: string[]): Promise<void> {
    for (const f of files) {
      await git.add({ fs: this.fs, dir: this.vaultPath, filepath: f, force: true });
    }
  }

  async commit(message: string): Promise<void> {
    await git.commit({
      fs: this.fs,
      dir: this.vaultPath,
      message,
      author: {
        name: this.settings.authUsername || "Obsidian",
        email: "",
      },
    });
  }

  async stageAllAndCommit(message: string): Promise<string> {
    await this.stageAll();
    await this.commit(message);
    return message;
  }

  async push(force = false): Promise<void> {
    const { remoteName, branch } = this.settings;
    const httpClient = await this.getHttpClient();
    await this.runNetworkOpWithRetry("Push", async () => {
      await git.push({
        fs: this.fs,
        http: httpClient,
        dir: this.vaultPath,
        remote: remoteName,
        remoteRef: branch,
        force,
        onAuth: this.isoOnAuth,
      });
    });
  }

  async fetch(): Promise<void> {
    const { remoteName, branch } = this.settings;
    const httpClient = await this.getHttpClient();
    await this.runNetworkOpWithRetry("Fetch", async () => {
      await git.fetch({
        fs: this.fs,
        http: httpClient,
        dir: this.vaultPath,
        remote: remoteName,
        remoteRef: branch,
        onAuth: this.isoOnAuth,
      });
    });
  }

  async pull(): Promise<void> {
    const { remoteName, branch } = this.settings;
    await this.fetch();

    // If the local branch doesn't exist yet (empty repo after init, or after
    // forceSyncFromRemote set up the remote tracking ref but no local branch
    // was created), do a checkout rather than a merge.
    let localBranchExists = false;
    try {
      await git.resolveRef({ fs: this.fs, dir: this.vaultPath, ref: `refs/heads/${branch}` });
      localBranchExists = true;
    } catch {
      // branch doesn't exist yet
    }

    if (!localBranchExists) {
      const remoteRef = `refs/remotes/${remoteName}/${branch}`;
      const sha = await git.resolveRef({ fs: this.fs, dir: this.vaultPath, ref: remoteRef });
      await git.writeRef({ fs: this.fs, dir: this.vaultPath, ref: `refs/heads/${branch}`, value: sha, force: true });
      await git.checkout({ fs: this.fs, dir: this.vaultPath, ref: branch, force: true });
      return;
    }

    await git.merge({
      fs: this.fs,
      dir: this.vaultPath,
      ours: branch,
      theirs: `${remoteName}/${branch}`,
      fastForwardOnly: false,
      author: {
        name: this.settings.authUsername || "Obsidian",
        email: "",
      },
    });
  }

  async rebase(): Promise<void> {
    // isomorphic-git does not support rebase; keep behavior as merge-based pull.
    await this.pull();
  }

  async forceSyncFromRemote(): Promise<void> {
    const { remoteName, remoteUrl, branch } = this.settings;
    if (!remoteUrl) {
      throw new Error("Remote URL is empty. Configure it before force sync.");
    }

    const isRepo = await this.isGitRepository();
    if (!isRepo) {
      await this.init();
    }

    await this.setRemote(remoteName, remoteUrl);
    await this.fetch();

    const remoteRef = `refs/remotes/${remoteName}/${branch}`;
    const sha = await git.resolveRef({ fs: this.fs, dir: this.vaultPath, ref: remoteRef });

    await git.writeRef({
      fs: this.fs,
      dir: this.vaultPath,
      ref: `refs/heads/${branch}`,
      value: sha,
      force: true,
    });

    await git.checkout({
      fs: this.fs,
      dir: this.vaultPath,
      ref: branch,
      force: true,
    });
  }

  async stashPush(_message: string): Promise<void> {
    throw new Error("Stash is not supported in the current git backend.");
  }

  async stashPop(): Promise<void> {
    throw new Error("Stash is not supported in the current git backend.");
  }

  async setRemote(name: string, url: string): Promise<void> {
    const remotes = await git.listRemotes({ fs: this.fs, dir: this.vaultPath });
    const exists = remotes.some((r) => r.remote === name);
    if (exists) {
      await git.deleteRemote({ fs: this.fs, dir: this.vaultPath, remote: name });
    }
    await git.addRemote({ fs: this.fs, dir: this.vaultPath, remote: name, url });
  }

  async getRemotes(): Promise<Array<{ name: string; refs: { fetch: string; push: string } }>> {
    const remotes = await git.listRemotes({ fs: this.fs, dir: this.vaultPath });
    return remotes.map((r) => ({
      name: r.remote,
      refs: { fetch: r.url, push: r.url },
    }));
  }

  async getLastCommitHash(): Promise<string> {
    try {
      const sha = await git.resolveRef({ fs: this.fs, dir: this.vaultPath, ref: "HEAD" });
      return sha.slice(0, 7);
    } catch {
      return "";
    }
  }

  async getCurrentBranch(): Promise<string> {
    try {
      return (await git.currentBranch({ fs: this.fs, dir: this.vaultPath })) ?? "";
    } catch {
      return "";
    }
  }

  async listBranches(): Promise<string[]> {
    return git.listBranches({ fs: this.fs, dir: this.vaultPath });
  }

  async checkout(branch: string, create = false): Promise<void> {
    if (create) {
      await git.branch({ fs: this.fs, dir: this.vaultPath, ref: branch });
    }
    await git.checkout({ fs: this.fs, dir: this.vaultPath, ref: branch });
  }

  private async computeStatus(): Promise<GitStatus> {
    const { remoteName, branch } = this.settings;

    let currentBranch: string | null = null;
    try {
      currentBranch = (await git.currentBranch({ fs: this.fs, dir: this.vaultPath })) ?? null;
    } catch {
      // empty repo
    }

    const staged: string[] = [];
    const modified: string[] = [];
    const not_added: string[] = [];
    const deleted: string[] = [];
    const conflicted: string[] = [];

    try {
      const matrix = await git.statusMatrix({ fs: this.fs, dir: this.vaultPath });
      this.debugLog("statusMatrix entries", { count: matrix.length });
      for (const [filepath, head, workdir, stage] of matrix) {
        if (head === 0 && workdir === 0 && stage === 0) continue;
        if (head === 0 && workdir === 2 && stage !== 2) {
          not_added.push(filepath as string);
          this.debugLog("status untracked", { filepath, head, workdir, stage });
          continue;
        }
        if (head === 0 && workdir === 2 && stage === 2) {
          staged.push(filepath as string);
          this.debugLog("status staged-untracked", { filepath, head, workdir, stage });
          continue;
        }
        if (head === 1 && workdir === 1 && stage === 1) continue;
        if (head === 1 && workdir === 2 && stage === 1) {
          modified.push(filepath as string);
          this.debugLog("status modified", { filepath, head, workdir, stage });
          continue;
        }
        if (head === 1 && workdir === 2 && stage === 2) {
          staged.push(filepath as string);
          this.debugLog("status staged-modified", { filepath, head, workdir, stage });
          continue;
        }
        if (head === 1 && workdir === 0) {
          deleted.push(filepath as string);
          this.debugLog("status deleted", { filepath, head, workdir, stage });
          continue;
        }
        if (head === 1 && workdir === 1 && stage === 0) {
          staged.push(filepath as string);
          this.debugLog("status staged-deleted", { filepath, head, workdir, stage });
          continue;
        }
        if (stage === 3) {
          conflicted.push(filepath as string);
          this.debugLog("status conflicted", { filepath, head, workdir, stage });
          continue;
        }

        this.debugLog("status matrix unclassified", { filepath, head, workdir, stage });
      }
    } catch {
      // empty repo
    }

    let ahead = 0;
    let behind = 0;
    try {
      const localOid = await git.resolveRef({
        fs: this.fs,
        dir: this.vaultPath,
        ref: `refs/heads/${branch}`,
      });
      const remoteOid = await git.resolveRef({
        fs: this.fs,
        dir: this.vaultPath,
        ref: `refs/remotes/${remoteName}/${branch}`,
      });

      if (localOid !== remoteOid) {
        const bases = await git.findMergeBase({
          fs: this.fs,
          dir: this.vaultPath,
          oids: [localOid, remoteOid],
        });
        const baseOid: string = Array.isArray(bases) ? bases[0] : bases;

        const [localLogs, remoteLogs] = await Promise.all([
          git.log({ fs: this.fs, dir: this.vaultPath, ref: localOid }),
          git.log({ fs: this.fs, dir: this.vaultPath, ref: remoteOid }),
        ]);
        const aheadIdx = localLogs.findIndex((c) => c.oid === baseOid);
        const behindIdx = remoteLogs.findIndex((c) => c.oid === baseOid);
        ahead = aheadIdx >= 0 ? aheadIdx : 0;
        behind = behindIdx >= 0 ? behindIdx : 0;
      }
    } catch {
      // remote tracking ref may not exist yet
    }

    return {
      current: currentBranch,
      ahead,
      behind,
      staged,
      modified,
      not_added,
      deleted,
      renamed: [],
      conflicted,
    };
  }

  private async stageAllWithStatusMatrix(): Promise<void> {
    const matrix = await git.statusMatrix({ fs: this.fs, dir: this.vaultPath });
    for (const [filepath, head, workdir, stage] of matrix) {
      if (head === 1 && workdir === 0) {
        console.info("[Obsidian Git] stageAll remove", { filepath, head, workdir, stage });
        await git.remove({ fs: this.fs, dir: this.vaultPath, filepath: filepath as string });
        continue;
      }

      const shouldAddUntracked = head === 0 && workdir === 2 && stage === 0;
      const shouldAddModified = head === 1 && workdir === 2 && stage === 1;

      if (shouldAddUntracked || shouldAddModified) {
        console.info("[Obsidian Git] stageAll add", { filepath, head, workdir, stage });
        const force = head === 1;
        await git.add({ fs: this.fs, dir: this.vaultPath, filepath: filepath as string, force });
      }
    }
  }
}
