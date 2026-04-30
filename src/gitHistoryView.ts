import { ItemView, WorkspaceLeaf, moment } from "obsidian";
import type ObsidianGitPlugin from "./main";
import { GitDetailModal } from "./gitDetailModal";
import type { GitLogCommit } from "./types";
import { GIT_HISTORY_VIEW_TYPE } from "./types";

const ROW_H = 38;
const GRAPH_W = 56;

function buildOidIndex(commits: GitLogCommit[]): Map<string, number> {
  return new Map(commits.map((c, i) => [c.oid, i]));
}

function createHistorySvg(commits: GitLogCommit[], workingFirst: boolean): SVGSVGElement {
  const rowOffset = workingFirst ? 1 : 0;
  const n = commits.length + (workingFirst ? 1 : 0);
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", String(GRAPH_W));
  svg.setAttribute("height", String(Math.max(n * ROW_H, ROW_H)));
  svg.setAttribute("class", "vault-git-history-svg");
  svg.setAttribute("aria-hidden", "true");

  const idx = buildOidIndex(commits);
  const cxBase = 26;

  if (workingFirst && commits.length > 0) {
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", String(cxBase));
    line.setAttribute("y1", String(ROW_H / 2));
    line.setAttribute("x2", String(cxBase));
    line.setAttribute("y2", String(ROW_H + ROW_H / 2));
    line.setAttribute("class", "vault-git-history-edge vault-git-history-edge-working");
    svg.appendChild(line);
  }

  for (let i = 0; i < commits.length; i++) {
    const parents = commits[i].parents;
    for (let pi = 0; pi < parents.length; pi++) {
      const poid = parents[pi];
      const j = idx.get(poid);
      if (j === undefined || j <= i) continue;
      const xOff = pi === 0 ? 0 : Math.min(14, (pi - 1) * 10 - 5);
      const x1 = cxBase + xOff;
      const x2 = cxBase + (pi === 0 ? 0 : Math.min(14, (pi - 1) * 10 - 5));
      const y1 = (i + rowOffset) * ROW_H + ROW_H / 2;
      const y2 = (j + rowOffset) * ROW_H + ROW_H / 2;
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("x1", String(x1));
      line.setAttribute("y1", String(y1));
      line.setAttribute("x2", String(x2));
      line.setAttribute("y2", String(y2));
      line.setAttribute("class", "vault-git-history-edge");
      svg.appendChild(line);
    }
  }

  if (workingFirst) {
    const cy = ROW_H / 2;
    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    circle.setAttribute("cx", String(cxBase));
    circle.setAttribute("cy", String(cy));
    circle.setAttribute("r", "6");
    circle.setAttribute("class", "vault-git-history-node vault-git-history-node-working");
    svg.appendChild(circle);
  }

  for (let i = 0; i < commits.length; i++) {
    const merge = commits[i].parents.length > 1;
    const cy = (i + rowOffset) * ROW_H + ROW_H / 2;
    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    circle.setAttribute("cx", String(cxBase));
    circle.setAttribute("cy", String(cy));
    circle.setAttribute("r", merge ? "6" : "5");
    circle.setAttribute("class", merge ? "vault-git-history-node vault-git-history-node-merge" : "vault-git-history-node");
    svg.appendChild(circle);
  }

  return svg;
}

export class GitHistoryView extends ItemView {
  private toolbarStatusEl?: HTMLSpanElement;
  private toolbarControlButtons: HTMLButtonElement[] = [];

  constructor(leaf: WorkspaceLeaf, private readonly plugin: ObsidianGitPlugin) {
    super(leaf);
  }

  /** Shows status text and disables toolbar controls while long-running work runs. */
  setToolbarBusy(message: string | null): void {
    const busy = message !== null && message !== "";
    if (this.toolbarStatusEl) {
      this.toolbarStatusEl.setText(message ?? "");
      this.toolbarStatusEl.toggleClass("vault-git-history-toolbar-status-busy", busy);
    }
    for (const b of this.toolbarControlButtons) {
      b.disabled = busy;
    }
  }

  getViewType(): string {
    return GIT_HISTORY_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Git history";
  }

  getIcon(): string {
    return "git-branch";
  }

  async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass("vault-git-history-root");
    this.toolbarControlButtons = [];

    const toolbar = this.contentEl.createDiv({ cls: "vault-git-history-toolbar" });
    const rowTop = toolbar.createDiv({ cls: "vault-git-history-toolbar-row vault-git-history-toolbar-row-top" });
    rowTop.createSpan({ cls: "vault-git-history-title", text: "Commit graph" });
    this.toolbarStatusEl = rowTop.createSpan({ cls: "vault-git-history-toolbar-status" });
    const btn = rowTop.createEl("button", {
      cls: "vault-git-history-refresh",
      text: "Refresh",
    });
    this.toolbarControlButtons.push(btn);
    btn.addEventListener("click", () => {
      void (async () => {
        this.setToolbarBusy("Refreshing graph…");
        try {
          await this.reload();
        } finally {
          this.setToolbarBusy(null);
        }
      })();
    });

    const rowOps = toolbar.createDiv({
      cls: "vault-git-history-toolbar-row vault-git-history-toolbar-row-actions",
    });
    rowOps.createSpan({ cls: "vault-git-history-actions-label", text: "Actions:" });
    const mkOp = (text: string, title: string, run: () => Promise<void>) => {
      const el = rowOps.createEl("button", {
        cls: "vault-git-history-op",
        text,
      });
      this.toolbarControlButtons.push(el);
      el.setAttribute("aria-label", title);
      el.setAttribute("title", title);
      el.addEventListener("click", () => {
        void run();
      });
    };
    mkOp("Fetch", "Fetch from remote", () => this.plugin.runHistoryToolbarFetch());
    mkOp(
      "Commit all",
      "Stage all changes (new, modified, deleted) and commit locally only — no fetch, pull, rebase, or push",
      () => this.plugin.runHistoryToolbarCommitAll()
    );
    mkOp("Rebase", "Rebase onto remote branch (same as command palette)", () => this.plugin.runHistoryToolbarRebase());
    mkOp("Push", "Pull first if enabled in settings, then push to remote", () => this.plugin.runHistoryToolbarPush());

    this.bodyEl = this.contentEl.createDiv({ cls: "vault-git-history-scroll" });
    await this.reload();
  }

  private bodyEl?: HTMLDivElement;

  public async reload(): Promise<void> {
    if (!this.bodyEl) return;
    this.bodyEl.empty();

    const isRepo = await this.plugin.gitManager.isGitRepository();
    if (!isRepo) {
      this.bodyEl.createDiv({
        cls: "vault-git-history-empty",
        text: "This vault folder is not a git repository (no commits yet). Initialize git or open a vault that is already a repo.",
      });
      return;
    }

    const [commits, localTips, remoteTips, hasDirty] = await Promise.all([
      this.plugin.gitManager.getCommitLog({ depth: 250 }),
      this.plugin.gitManager.getBranchTipsByOid(),
      this.plugin.gitManager.getRemoteBranchTipsByOid(),
      this.plugin.gitManager.hasUncommittedChanges(),
    ]);

    if (commits.length === 0 && !hasDirty) {
      this.bodyEl.createDiv({
        cls: "vault-git-history-empty",
        text: "No commits yet and no local changes.",
      });
      return;
    }

    const wrap = this.bodyEl.createDiv({ cls: "vault-git-history-rows-wrap" });
    const inner = wrap.createDiv({ cls: "vault-git-history-rows-inner" });

    inner.appendChild(createHistorySvg(commits, hasDirty));

    const textCol = inner.createDiv({ cls: "vault-git-history-text-col" });

    if (hasDirty) {
      const row = textCol.createDiv({
        cls: "vault-git-history-row vault-git-history-row-uncommitted vault-git-history-row-clickable",
      });
      row.createDiv({ cls: "vault-git-history-uncommitted-label", text: "Uncommitted changes" });
      row.createDiv({
        cls: "vault-git-history-subject vault-git-history-subject-muted",
        text: "Working tree differs from HEAD — click for files & diff stats",
      });
      row.addEventListener("click", () => {
        void this.openWorkingDetail();
      });
    }

    for (let i = 0; i < commits.length; i++) {
      const c = commits[i];
      const row = textCol.createDiv({
        cls: "vault-git-history-row vault-git-history-row-clickable",
      });

      const meta = row.createDiv({ cls: "vault-git-history-meta" });
      meta.createSpan({ cls: "vault-git-history-hash", text: c.shortOid });

      const locals = localTips.get(c.oid);
      const remotes = remoteTips.get(c.oid);
      if ((locals && locals.length > 0) || (remotes && remotes.length > 0)) {
        const tags = meta.createSpan({ cls: "vault-git-history-tags" });
        if (locals) {
          for (const b of locals) {
            tags.createSpan({ cls: "vault-git-history-branch-pill vault-git-history-branch-pill-local", text: b });
          }
        }
        if (remotes) {
          for (const b of remotes) {
            tags.createSpan({ cls: "vault-git-history-branch-pill vault-git-history-branch-pill-remote", text: b });
          }
        }
      }

      meta.createSpan({
        cls: "vault-git-history-date",
        text: moment(c.committedDate).format("YYYY-MM-DD HH:mm"),
      });

      row.createDiv({ cls: "vault-git-history-subject", text: c.messageTitle });

      const authorLine = row.createDiv({ cls: "vault-git-history-author" });
      authorLine.setText(c.authorName || c.authorEmail || "");

      row.addEventListener("click", () => {
        void this.openCommitDetail(c.oid);
      });
    }
  }

  private async openWorkingDetail(): Promise<void> {
    const detail = await this.plugin.gitManager.getWorkingTreeDiffDetail();
    if (!detail) return;
    const modal = new GitDetailModal(this.plugin.app, "working", detail);
    modal.open();
  }

  private async openCommitDetail(oid: string): Promise<void> {
    const detail = await this.plugin.gitManager.getCommitDiffDetail(oid);
    if (!detail) return;
    const modal = new GitDetailModal(this.plugin.app, "commit", detail);
    modal.open();
  }

  async onClose(): Promise<void> {
    this.toolbarStatusEl = undefined;
    this.toolbarControlButtons = [];
    this.contentEl.empty();
    this.bodyEl = undefined;
  }
}
