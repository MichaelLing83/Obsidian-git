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
import http from "isomorphic-git/http/web";

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
    // On mobile use the fetch-based web transport (no Node APIs available).
    // On desktop Electron use isomorphic-git's Node HTTP transport, loaded via
    // runtime require so it is never bundled (and never breaks the mobile build).
    if (Platform.isMobile) {
      return http;
    }
    const runtimeRequire =
      (globalThis as any).require ??
      (typeof require === "function" ? require : undefined);
    if (typeof runtimeRequire === "function") {
      try {
        // isomorphic-git/http/node is a CJS module; its .request is the export
        const nodeHttp = runtimeRequire("isomorphic-git/http/node");
        return nodeHttp.default ?? nodeHttp;
      } catch {
        // fall back to web transport if for some reason the node module isn't
        // available at runtime (shouldn't happen on desktop Electron)
      }
    }
    return http;
  }

  private get fs(): any {
    return this.fsClient;
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
      await git.add({ fs: this.fs, dir: this.vaultPath, filepath: f });
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
    await git.push({
      fs: this.fs,
      http: httpClient,
      dir: this.vaultPath,
      remote: remoteName,
      remoteRef: branch,
      force,
      onAuth: this.isoOnAuth,
    });
  }

  async fetch(): Promise<void> {
    const { remoteName, branch } = this.settings;
    const httpClient = await this.getHttpClient();
    await git.fetch({
      fs: this.fs,
      http: httpClient,
      dir: this.vaultPath,
      remote: remoteName,
      remoteRef: branch,
      onAuth: this.isoOnAuth,
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
      for (const [filepath, head, workdir, stage] of matrix) {
        if (head === 0 && workdir === 0 && stage === 0) continue;
        if (head === 0 && workdir === 2 && stage === 0) {
          not_added.push(filepath as string);
          continue;
        }
        if (head === 0 && workdir === 2 && stage === 2) {
          staged.push(filepath as string);
          continue;
        }
        if (head === 1 && workdir === 1 && stage === 1) continue;
        if (head === 1 && workdir === 2 && stage === 1) {
          modified.push(filepath as string);
          continue;
        }
        if (head === 1 && workdir === 2 && stage === 2) {
          staged.push(filepath as string);
          continue;
        }
        if (head === 1 && workdir === 0) {
          deleted.push(filepath as string);
          continue;
        }
        if (head === 1 && workdir === 1 && stage === 0) {
          staged.push(filepath as string);
          continue;
        }
        if (stage === 3) {
          conflicted.push(filepath as string);
        }
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
    for (const [filepath, head, workdir] of matrix) {
      if (head === 1 && workdir === 0) {
        await git.remove({ fs: this.fs, dir: this.vaultPath, filepath: filepath as string });
      } else if (workdir !== 0) {
        await git.add({ fs: this.fs, dir: this.vaultPath, filepath: filepath as string });
      }
    }
  }
}
