/**
 * GitManager
 *
 * Uses isomorphic-git for both desktop and mobile to avoid runtime dependency
 * issues with external native wrappers. Desktop uses Node's fs client,
 * while mobile uses Obsidian's DataAdapter wrapper.
 */

import { DataAdapter, Platform } from "obsidian";
import { STAGE, TREE, WORKDIR, walk } from "isomorphic-git";
import * as git from "isomorphic-git";
import { lineDiffStats, isProbablyBinaryUtf8 } from "./diffLineStats";
import obsidianHttpTransport from "./httpTransport";
import { ObsidianFsAdapter } from "./fsAdapter";
import type {
  CommitDetailInfo,
  GitChangeFileStat,
  GitDiffSummary,
  GitLogCommit,
  ObsidianGitSettings,
  WorkingTreeDetail,
  GitStatus,
} from "./types";

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

  /**
   * Walk commit history from ref (default HEAD), newest first.
   */
  async getCommitLog(options?: { depth?: number; ref?: string }): Promise<GitLogCommit[]> {
    const depth = options?.depth ?? 200;
    const ref = options?.ref ?? "HEAD";
    const isRepo = await this.isGitRepository();
    if (!isRepo) return [];
    try {
      const rows = await git.log({ fs: this.fs, dir: this.vaultPath, ref, depth });
      return rows.map((r) => {
        const msg = r.commit.message.trim();
        const title = msg.split("\n")[0]?.trim() ?? "";
        return {
          oid: r.oid,
          shortOid: r.oid.slice(0, 7),
          message: msg,
          messageTitle: title || msg.slice(0, 80),
          authorName: r.commit.author.name,
          authorEmail: r.commit.author.email,
          committedDate: r.commit.committer.timestamp * 1000,
          parents: [...(r.commit.parent ?? [])],
        };
      });
    } catch {
      return [];
    }
  }

  /**
   * Map commit oid → local branch names whose tips point at that commit.
   */
  async getBranchTipsByOid(): Promise<Map<string, string[]>> {
    const map = new Map<string, string[]>();
    const isRepo = await this.isGitRepository();
    if (!isRepo) return map;
    let names: string[] = [];
    try {
      names = await git.listBranches({ fs: this.fs, dir: this.vaultPath });
    } catch {
      return map;
    }
    for (const name of names) {
      try {
        const oid = await git.resolveRef({
          fs: this.fs,
          dir: this.vaultPath,
          ref: `refs/heads/${name}`,
        });
        const list = map.get(oid) ?? [];
        list.push(name);
        map.set(oid, list);
      } catch {
        /* skip */
      }
    }
    for (const [, labels] of map) {
      labels.sort((a, b) => a.localeCompare(b));
    }
    return map;
  }

  /**
   * Map commit oid → remote-tracking branch labels (`origin/main`, etc.).
   */
  async getRemoteBranchTipsByOid(): Promise<Map<string, string[]>> {
    const map = new Map<string, string[]>();
    const isRepo = await this.isGitRepository();
    if (!isRepo) return map;

    try {
      const remotes = await git.listRemotes({ fs: this.fs, dir: this.vaultPath });
      for (const { remote } of remotes) {
        let branchNames: string[] = [];
        try {
          branchNames = await git.listBranches({ fs: this.fs, dir: this.vaultPath, remote });
        } catch {
          continue;
        }
        for (const branchName of branchNames) {
          try {
            const oid = await git.resolveRef({
              fs: this.fs,
              dir: this.vaultPath,
              ref: `refs/remotes/${remote}/${branchName}`,
            });
            const label = `${remote}/${branchName}`;
            const list = map.get(oid) ?? [];
            if (!list.includes(label)) {
              list.push(label);
              map.set(oid, list);
            }
          } catch {
            /* skip missing ref */
          }
        }
      }
    } catch {
      return map;
    }

    for (const [, labels] of map) {
      labels.sort((a, b) => a.localeCompare(b));
    }
    return map;
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

  /** True if working tree has staged/unstaged/untracked/conflicted changes. */
  async hasUncommittedChanges(): Promise<boolean> {
    const s = await this.status();
    return (
      s.staged.length +
        s.modified.length +
        s.not_added.length +
        s.deleted.length +
        s.renamed.length +
        s.conflicted.length >
      0
    );
  }

  /** HEAD vs working tree (like git status + diff --stat). */
  async getWorkingTreeDiffDetail(): Promise<WorkingTreeDetail | null> {
    const isRepo = await this.isGitRepository();
    if (!isRepo) return null;

    let headOid: string | null = null;
    try {
      headOid = await git.resolveRef({ fs: this.fs, dir: this.vaultPath, ref: "HEAD" });
    } catch {
      const files = await this.collectWorkingTreeFilesWithoutHead();
      return {
        headOid: null,
        branch: (await this.getCurrentBranch()) || null,
        files,
        summary: this.summarizeFiles(files),
      };
    }

    const files = await this.walkHeadVsWorkdir();
    return {
      headOid,
      branch: (await this.getCurrentBranch()) || null,
      files,
      summary: this.summarizeFiles(files),
    };
  }

  /** Commit vs first parent (merge commits: diff vs first parent only). */
  async getCommitDiffDetail(oid: string): Promise<CommitDetailInfo | null> {
    const isRepo = await this.isGitRepository();
    if (!isRepo) return null;

    let commit: Awaited<ReturnType<typeof git.readCommit>>;
    try {
      commit = await git.readCommit({ fs: this.fs, dir: this.vaultPath, oid });
    } catch {
      return null;
    }

    const parents = [...(commit.commit.parent ?? [])];
    let files: GitChangeFileStat[];
    let compareOid: string | null = parents[0] ?? null;
    let compareLabel: string;

    if (parents.length === 0) {
      files = await this.walkInitialCommit(oid);
      compareOid = null;
      compareLabel = "empty tree (initial commit)";
    } else {
      files = await this.walkTwoTrees(parents[0], oid);
      compareLabel = `first parent ${parents[0].slice(0, 7)}`;
      if (parents.length > 1) {
        compareLabel += ` (+${parents.length - 1} merge parent${parents.length > 2 ? "s" : ""})`;
      }
    }

    const msg = commit.commit.message.trim();
    return {
      oid,
      shortOid: oid.slice(0, 7),
      message: msg,
      authorName: commit.commit.author.name,
      authorEmail: commit.commit.author.email,
      committedDate: commit.commit.committer.timestamp * 1000,
      parents,
      compareOid,
      compareLabel,
      files,
      summary: this.summarizeFiles(files),
    };
  }

  /**
   * Paths under `.git/` are the repository metadata (objects, refs, …), not project files.
   * WORKDIR walks the filesystem and would otherwise report them as untracked vs HEAD.
   */
  private isUnderGitMetadataDir(filepath: string): boolean {
    const n = filepath.replace(/\\/g, "/").replace(/^\.\//, "");
    return n === ".git" || n.startsWith(".git/");
  }

  /** Join vault root with repo-relative path (works with desktop absolute base or mobile ""). */
  private vaultJoin(filepath: string): string {
    const fp = filepath.replace(/\\/g, "/");
    if (!this.vaultPath) return fp;
    const base = this.vaultPath.replace(/\\/g, "/").replace(/\/$/, "");
    return `${base}/${fp.replace(/^\//, "")}`;
  }

  private summarizeFiles(files: GitChangeFileStat[]): GitDiffSummary {
    let additions = 0;
    let deletions = 0;
    for (const f of files) {
      additions += f.additions;
      deletions += f.deletions;
    }
    return { additions, deletions, filesChanged: files.length };
  }

  private async readVaultFileBytes(filepath: string): Promise<Uint8Array | null> {
    try {
      const base = this.vaultJoin(filepath);
      const raw = await this.fs.promises.readFile(base);
      if (raw instanceof Uint8Array) return raw;
      if (typeof raw === "string") return new TextEncoder().encode(raw);
      return new Uint8Array(raw as ArrayBuffer);
    } catch {
      return null;
    }
  }

  private diffStatFromBytes(
    oldB: Uint8Array | null,
    newB: Uint8Array | null
  ): { additions: number; deletions: number; binary: boolean } {
    const oldBuf = oldB ?? new Uint8Array();
    const newBuf = newB ?? new Uint8Array();
    if (isProbablyBinaryUtf8(oldBuf) || isProbablyBinaryUtf8(newBuf)) {
      return {
        additions: newBuf.byteLength ? 1 : 0,
        deletions: oldBuf.byteLength ? 1 : 0,
        binary: true,
      };
    }
    const oldStr = new TextDecoder("utf-8").decode(oldBuf);
    const newStr = new TextDecoder("utf-8").decode(newBuf);
    const { additions, deletions } = lineDiffStats(oldStr, newStr);
    return { additions, deletions, binary: false };
  }

  private async entryBlobBytes(entry: any): Promise<Uint8Array | null> {
    if (!entry) return null;
    if ((await entry.type()) !== "blob") return null;
    const c = await entry.content();
    if (c == null) return new Uint8Array();
    if (c instanceof Uint8Array) return c;
    if (typeof c === "string") return new TextEncoder().encode(c);
    return new Uint8Array(c as ArrayBuffer);
  }

  private async walkHeadVsWorkdir(): Promise<GitChangeFileStat[]> {
    const files: GitChangeFileStat[] = [];
    const dir = this.vaultPath;
    await walk({
      fs: this.fs,
      dir,
      trees: [TREE({ ref: "HEAD" }), WORKDIR(), STAGE()],
      map: async (filepath: string, [headEn, workEn, stageEn]: [any, any, any]) => {
        if (filepath === ".") return;
        if (this.isUnderGitMetadataDir(filepath)) return;
        const th = headEn ? await headEn.type() : null;
        const tw = workEn ? await workEn.type() : null;
        const ts = stageEn ? await stageEn.type() : null;
        if (th === "tree" || tw === "tree" || ts === "tree") return;

        const oidHead = headEn ? await headEn.oid() : null;
        const oidWork = workEn ? await workEn.oid() : null;

        // Same rule as git.statusMatrix({ ignored: false }): skip paths only in the
        // working tree (not in HEAD, not staged) that match .gitignore / exclude.
        if (!headEn && !stageEn && workEn) {
          try {
            if (await git.isIgnored({ fs: this.fs, dir: this.vaultPath, filepath })) {
              return;
            }
          } catch {
            /* treat as not ignored if helper fails */
          }
        }

        if (oidHead === oidWork) return;

        let status: GitChangeFileStat["status"];
        if (!oidHead && oidWork) status = "added";
        else if (oidHead && !oidWork) status = "deleted";
        else status = "modified";

        const oldBuf = await this.entryBlobBytes(headEn);
        const newBuf = await this.entryBlobBytes(workEn);
        const stat = this.diffStatFromBytes(oldBuf, newBuf);
        files.push({
          path: filepath,
          status,
          additions: stat.additions,
          deletions: stat.deletions,
          ...(stat.binary ? { binary: true } : {}),
        });
      },
    });
    return files.sort((a, b) => a.path.localeCompare(b.path));
  }

  private async walkTwoTrees(parentOid: string, commitOid: string): Promise<GitChangeFileStat[]> {
    const files: GitChangeFileStat[] = [];
    await walk({
      fs: this.fs,
      dir: this.vaultPath,
      trees: [TREE({ ref: parentOid }), TREE({ ref: commitOid })],
      map: async (filepath: string, [A, B]: [any, any]) => {
        if (filepath === ".") return;
        const ta = A ? await A.type() : null;
        const tb = B ? await B.type() : null;
        if (ta === "tree" || tb === "tree") return;

        const oidA = A ? await A.oid() : null;
        const oidB = B ? await B.oid() : null;
        if (oidA === oidB) return;

        let status: GitChangeFileStat["status"];
        if (!oidA && oidB) status = "added";
        else if (oidA && !oidB) status = "deleted";
        else status = "modified";

        let oldBuf = await this.entryBlobBytes(A);
        let newBuf = await this.entryBlobBytes(B);
        if (!oldBuf && oidA) {
          const { blob } = await git.readBlob({ fs: this.fs, dir: this.vaultPath, oid: oidA });
          oldBuf = blob instanceof Uint8Array ? blob : new Uint8Array(blob as ArrayBuffer);
        }
        if (!newBuf && oidB) {
          const { blob } = await git.readBlob({ fs: this.fs, dir: this.vaultPath, oid: oidB });
          newBuf = blob instanceof Uint8Array ? blob : new Uint8Array(blob as ArrayBuffer);
        }

        const stat = this.diffStatFromBytes(oldBuf, newBuf);
        files.push({
          path: filepath,
          status,
          additions: stat.additions,
          deletions: stat.deletions,
          ...(stat.binary ? { binary: true } : {}),
        });
      },
    });
    return files.sort((a, b) => a.path.localeCompare(b.path));
  }

  private async walkInitialCommit(commitOid: string): Promise<GitChangeFileStat[]> {
    const files: GitChangeFileStat[] = [];
    await walk({
      fs: this.fs,
      dir: this.vaultPath,
      trees: [TREE({ ref: commitOid })],
      map: async (filepath: string, [E]: [any]) => {
        if (filepath === ".") return;
        if ((await E.type()) === "tree") return;
        const oid = await E.oid();
        const { blob } = await git.readBlob({ fs: this.fs, dir: this.vaultPath, oid });
        const buf = blob instanceof Uint8Array ? blob : new Uint8Array(blob as ArrayBuffer);
        const stat = this.diffStatFromBytes(null, buf);
        files.push({
          path: filepath,
          status: "added",
          additions: stat.additions,
          deletions: 0,
          ...(stat.binary ? { binary: true } : {}),
        });
      },
    });
    return files.sort((a, b) => a.path.localeCompare(b.path));
  }

  /** Repo with no HEAD commit: approximate stats from working tree only. */
  private async collectWorkingTreeFilesWithoutHead(): Promise<GitChangeFileStat[]> {
    const files: GitChangeFileStat[] = [];
    const matrix = await git.statusMatrix({ fs: this.fs, dir: this.vaultPath });
    for (const [filepath, head, workdir, stage] of matrix) {
      const fp = filepath as string;
      if (this.isUnderGitMetadataDir(fp)) continue;
      if (head !== 0 || workdir !== 2) continue;
      if (stage !== 0 && stage !== 2) continue;
      const buf = await this.readVaultFileBytes(fp);
      if (!buf) continue;
      const stat = this.diffStatFromBytes(null, buf);
      files.push({
        path: fp,
        status: "added",
        additions: stat.additions,
        deletions: 0,
        ...(stat.binary ? { binary: true } : {}),
      });
    }
    return files.sort((a, b) => a.path.localeCompare(b.path));
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
