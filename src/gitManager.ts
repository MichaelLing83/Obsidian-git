/**
 * GitManager
 *
 * Platform-aware git operations.
 * - Desktop (Electron / Node.js): uses simple-git (calls the native git binary).
 * - Mobile (iOS / Android): uses isomorphic-git (pure JavaScript, no binary
 *   required) with ObsidianFsAdapter as the file-system layer.
 *
 * Both paths return the shared GitStatus type so that main.ts never needs to
 * know which backend is in use.
 *
 * Mobile limitations vs desktop:
 * - Only HTTPS remotes are supported (no SSH on iOS/Android).
 * - Rebase falls back to merge (isomorphic-git does not implement rebase).
 * - Stash is not available; syncWithRemote uses commit-before-merge instead.
 */

import { DataAdapter, Platform } from "obsidian";
import { ObsidianGitSettings, GitStatus } from "./types";
import { ObsidianFsAdapter } from "./fsAdapter";

// Desktop backend
import simpleGit, { SimpleGit, SimpleGitOptions } from "simple-git";

// Mobile backend
import * as git from "isomorphic-git";
import http from "isomorphic-git/http/web";

export class GitManager {
  private vaultPath: string;
  private settings: ObsidianGitSettings;

  // Desktop backend instance
  private simpleGitInstance: SimpleGit | null = null;

  // Mobile backend fs adapter
  private isoFs: ObsidianFsAdapter | null = null;

  constructor(vaultPath: string, settings: ObsidianGitSettings, adapter?: DataAdapter) {
    this.vaultPath = vaultPath;
    this.settings = settings;

    if (Platform.isMobile && adapter) {
      this.isoFs = new ObsidianFsAdapter(adapter);
    } else {
      this.simpleGitInstance = this.createSimpleGit();
    }
  }

  updateSettings(settings: ObsidianGitSettings): void {
    this.settings = settings;
    if (this.simpleGitInstance) {
      this.simpleGitInstance = this.createSimpleGit();
    }
  }

  /** True when running on desktop (simple-git backend). */
  get isDesktop(): boolean {
    return !Platform.isMobile;
  }

  // ── Desktop helper ──────────────────────────────────────────────────────────

  private createSimpleGit(): SimpleGit {
    const options: Partial<SimpleGitOptions> = {
      baseDir: this.vaultPath,
      binary: "git",
      maxConcurrentProcesses: 6,
      trimmed: false,
    };
    return simpleGit(options);
  }

  // ── Auth helpers ────────────────────────────────────────────────────────────

  /** Build an authenticated HTTPS URL (desktop — embeds credentials in URL). */
  private buildAuthenticatedUrl(url: string): string {
    if (!url) return url;
    if (url.startsWith("git@") || url.startsWith("ssh://")) return url;
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

  /** isomorphic-git onAuth callback — provides credentials for HTTPS. */
  private isoOnAuth = (): { username: string; password: string } => ({
    username: this.settings.authUsername || this.settings.authToken,
    password: this.settings.authToken,
  });

  // ── Public API ──────────────────────────────────────────────────────────────

  async isGitRepository(): Promise<boolean> {
    if (this.isDesktop) {
      try { await this.sg.status(); return true; } catch { return false; }
    } else {
      try {
        await git.resolveRef({ fs: this.fs, dir: this.vaultPath, ref: "HEAD" });
        return true;
      } catch { return false; }
    }
  }

  async init(): Promise<void> {
    if (this.isDesktop) {
      await this.sg.init();
    } else {
      await git.init({ fs: this.fs, dir: this.vaultPath });
    }
  }

  async status(): Promise<GitStatus> {
    return this.isDesktop ? this.desktopStatus() : this.mobileStatus();
  }

  async stageAll(): Promise<void> {
    if (this.isDesktop) {
      await this.sg.add("-A");
    } else {
      await this.mobileStageAll();
    }
  }

  async stageFiles(files: string[]): Promise<void> {
    if (this.isDesktop) {
      await this.sg.add(files);
    } else {
      for (const f of files) {
        await git.add({ fs: this.fs, dir: this.vaultPath, filepath: f });
      }
    }
  }

  async commit(message: string): Promise<void> {
    if (this.isDesktop) {
      await this.sg.commit(message);
    } else {
      await git.commit({
        fs: this.fs,
        dir: this.vaultPath,
        message,
        author: { name: this.settings.authUsername || "Obsidian", email: "" },
      });
    }
  }

  async stageAllAndCommit(message: string): Promise<string> {
    await this.stageAll();
    await this.commit(message);
    return message;
  }

  async push(force = false): Promise<void> {
    const { remoteName, branch, remoteUrl } = this.settings;
    if (this.isDesktop) {
      const authUrl = this.buildAuthenticatedUrl(remoteUrl);
      if (authUrl && authUrl !== remoteUrl) {
        await this.sg.remote(["set-url", remoteName, authUrl]);
      }
      try {
        if (force) {
          await this.sg.push([remoteName, branch, "--force"]);
        } else {
          await this.sg.push(remoteName, branch);
        }
      } finally {
        if (authUrl && authUrl !== remoteUrl && remoteUrl) {
          await this.sg.remote(["set-url", remoteName, remoteUrl]);
        }
      }
    } else {
      await git.push({
        fs: this.fs,
        http,
        dir: this.vaultPath,
        remote: remoteName,
        remoteRef: branch,
        force,
        onAuth: this.isoOnAuth,
      });
    }
  }

  async fetch(): Promise<void> {
    const { remoteName, branch, remoteUrl } = this.settings;
    if (this.isDesktop) {
      const authUrl = this.buildAuthenticatedUrl(remoteUrl);
      if (authUrl && authUrl !== remoteUrl) {
        await this.sg.remote(["set-url", remoteName, authUrl]);
      }
      try {
        await this.sg.fetch(remoteName);
      } finally {
        if (authUrl && authUrl !== remoteUrl && remoteUrl) {
          await this.sg.remote(["set-url", remoteName, remoteUrl]);
        }
      }
    } else {
      await git.fetch({
        fs: this.fs,
        http,
        dir: this.vaultPath,
        remote: remoteName,
        remoteRef: branch,
        onAuth: this.isoOnAuth,
      });
    }
  }

  /**
   * Pull: desktop respects pullStrategy (merge/rebase); mobile always merges
   * because isomorphic-git does not implement rebase.
   */
  async pull(): Promise<void> {
    const { remoteName, branch, pullStrategy } = this.settings;
    if (this.isDesktop) {
      const options = pullStrategy === "rebase" ? ["--rebase"] : [];
      await this.sg.pull(remoteName, branch, options);
    } else {
      await git.merge({
        fs: this.fs,
        dir: this.vaultPath,
        ours: branch,
        theirs: `${remoteName}/${branch}`,
        fastForwardOnly: false,
        author: { name: this.settings.authUsername || "Obsidian", email: "" },
      });
    }
  }

  /**
   * Rebase onto the remote branch (desktop only).
   * Mobile falls back to merge.
   */
  async rebase(): Promise<void> {
    if (this.isDesktop) {
      const { remoteName, branch } = this.settings;
      await this.sg.rebase([`${remoteName}/${branch}`]);
    } else {
      await this.pull();
    }
  }

  /** Destructive one-way sync: remote → local, discarding all local differences. */
  async forceSyncFromRemote(): Promise<void> {
    const { remoteName, remoteUrl, branch } = this.settings;
    if (!remoteUrl) throw new Error("Remote URL is empty. Configure it before force sync.");

    const isRepo = await this.isGitRepository();

    if (this.isDesktop) {
      if (!isRepo) await this.sg.init();
      await this.setRemote(remoteName, remoteUrl);
      await this.fetch();
      await this.sg.raw(["checkout", "-B", branch, `${remoteName}/${branch}`]);
      await this.sg.raw(["reset", "--hard", `${remoteName}/${branch}`]);
      // Preserve .obsidian/ so the running vault isn't broken.
      await this.sg.raw(["clean", "-fd", "-e", ".obsidian/"]);
    } else {
      if (!isRepo) await this.init();
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
      await git.checkout({ fs: this.fs, dir: this.vaultPath, ref: branch, force: true });
    }
  }

  /** Stash local changes including untracked files (desktop only). */
  async stashPush(message: string): Promise<void> {
    if (!this.isDesktop) throw new Error("Stash is not supported on mobile.");
    await this.sg.raw(["stash", "push", "-u", "-m", message]);
  }

  /** Restore the latest stash (desktop only). */
  async stashPop(): Promise<void> {
    if (!this.isDesktop) throw new Error("Stash is not supported on mobile.");
    await this.sg.raw(["stash", "pop"]);
  }

  async setRemote(name: string, url: string): Promise<void> {
    if (this.isDesktop) {
      const remotes = await this.sg.getRemotes(false);
      const exists = remotes.some((r) => r.name === name);
      if (exists) {
        await this.sg.remote(["set-url", name, url]);
      } else {
        await this.sg.addRemote(name, url);
      }
    } else {
      const remotes = await git.listRemotes({ fs: this.fs, dir: this.vaultPath });
      const exists = remotes.some((r) => r.remote === name);
      if (exists) {
        await git.deleteRemote({ fs: this.fs, dir: this.vaultPath, remote: name });
      }
      await git.addRemote({ fs: this.fs, dir: this.vaultPath, remote: name, url });
    }
  }

  async getRemotes(): Promise<Array<{ name: string; refs: { fetch: string; push: string } }>> {
    if (this.isDesktop) {
      return this.sg.getRemotes(true);
    } else {
      const remotes = await git.listRemotes({ fs: this.fs, dir: this.vaultPath });
      return remotes.map((r) => ({ name: r.remote, refs: { fetch: r.url, push: r.url } }));
    }
  }

  async getLastCommitHash(): Promise<string> {
    if (this.isDesktop) {
      const log = await this.sg.log(["--max-count=1"]);
      return log.latest?.hash?.slice(0, 7) ?? "";
    } else {
      try {
        const sha = await git.resolveRef({ fs: this.fs, dir: this.vaultPath, ref: "HEAD" });
        return sha.slice(0, 7);
      } catch { return ""; }
    }
  }

  async getCurrentBranch(): Promise<string> {
    if (this.isDesktop) {
      const s = await this.sg.status();
      return s.current ?? "";
    } else {
      try {
        return (await git.currentBranch({ fs: this.fs, dir: this.vaultPath })) ?? "";
      } catch { return ""; }
    }
  }

  async listBranches(): Promise<string[]> {
    if (this.isDesktop) {
      const summary = await this.sg.branchLocal();
      return summary.all;
    } else {
      return git.listBranches({ fs: this.fs, dir: this.vaultPath });
    }
  }

  async checkout(branch: string, create = false): Promise<void> {
    if (this.isDesktop) {
      if (create) {
        await this.sg.checkoutLocalBranch(branch);
      } else {
        await this.sg.checkout(branch);
      }
    } else {
      if (create) {
        await git.branch({ fs: this.fs, dir: this.vaultPath, ref: branch });
      }
      await git.checkout({ fs: this.fs, dir: this.vaultPath, ref: branch });
    }
  }

  // ── Private accessors ───────────────────────────────────────────────────────

  private get sg(): SimpleGit {
    if (!this.simpleGitInstance) throw new Error("simple-git not available on mobile.");
    return this.simpleGitInstance;
  }

  private get fs(): ObsidianFsAdapter {
    if (!this.isoFs) throw new Error("ObsidianFsAdapter not available on desktop.");
    return this.isoFs;
  }

  // ── Desktop status ──────────────────────────────────────────────────────────

  private async desktopStatus(): Promise<GitStatus> {
    const s = await this.sg.status();
    return {
      current: s.current ?? null,
      ahead: s.ahead ?? 0,
      behind: s.behind ?? 0,
      staged: s.staged,
      modified: s.modified,
      not_added: s.not_added,
      deleted: s.deleted,
      renamed: s.renamed.map((r) => r.to),
      conflicted: s.conflicted,
    };
  }

  // ── Mobile status ───────────────────────────────────────────────────────────

  private async mobileStatus(): Promise<GitStatus> {
    const { remoteName, branch } = this.settings;

    let currentBranch: string | null = null;
    try {
      currentBranch = (await git.currentBranch({ fs: this.fs, dir: this.vaultPath })) ?? null;
    } catch { /* empty repo */ }

    const staged: string[] = [];
    const modified: string[] = [];
    const not_added: string[] = [];
    const deleted: string[] = [];
    const conflicted: string[] = [];

    try {
      const matrix = await git.statusMatrix({ fs: this.fs, dir: this.vaultPath });
      for (const [filepath, head, workdir, stage] of matrix) {
        if (head === 0 && workdir === 0 && stage === 0) continue;
        if (head === 0 && workdir === 2 && stage === 0) { not_added.push(filepath as string); continue; }
        if (head === 0 && workdir === 2 && stage === 2) { staged.push(filepath as string); continue; }
        if (head === 1 && workdir === 1 && stage === 1) continue;
        if (head === 1 && workdir === 2 && stage === 1) { modified.push(filepath as string); continue; }
        if (head === 1 && workdir === 2 && stage === 2) { staged.push(filepath as string); continue; }
        if (head === 1 && workdir === 0) { deleted.push(filepath as string); continue; }
        if (head === 1 && workdir === 1 && stage === 0) { staged.push(filepath as string); continue; }
        if (stage === 3) { conflicted.push(filepath as string); }
      }
    } catch { /* empty repo */ }

    let ahead = 0;
    let behind = 0;
    try {
      const localOid = await git.resolveRef({ fs: this.fs, dir: this.vaultPath, ref: `refs/heads/${branch}` });
      const remoteOid = await git.resolveRef({ fs: this.fs, dir: this.vaultPath, ref: `refs/remotes/${remoteName}/${branch}` });
      if (localOid !== remoteOid) {
        const bases = await git.findMergeBase({ fs: this.fs, dir: this.vaultPath, oids: [localOid, remoteOid] });
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
    } catch { /* remote tracking ref may not exist yet */ }

    return { current: currentBranch, ahead, behind, staged, modified, not_added, deleted, renamed: [], conflicted };
  }

  // ── Mobile: stage all ───────────────────────────────────────────────────────

  private async mobileStageAll(): Promise<void> {
    const matrix = await git.statusMatrix({ fs: this.fs, dir: this.vaultPath });
    for (const [filepath, head, workdir] of matrix) {
      if (head === 1 && workdir === 0) {
        await git.remove({ fs: this.fs, dir: this.vaultPath, filepath: filepath as string });
      } else if (workdir !== 0) {
        await git.add({ fs: this.fs, dir: this.vaultPath, filepath: filepath as string });
      }
    }
  }
}
