import { App, Modal, moment } from "obsidian";
import type { CommitDetailInfo, GitChangeFileStat, WorkingTreeDetail } from "./types";

export class GitDetailModal extends Modal {
  constructor(
    app: App,
    private readonly kind: "working" | "commit",
    private readonly detail: WorkingTreeDetail | CommitDetailInfo
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("vault-git-detail-modal");

    if (this.kind === "working") {
      const d = this.detail as WorkingTreeDetail;
      contentEl.createEl("h2", { text: "Uncommitted changes", cls: "vault-git-detail-h2" });
      const sub = contentEl.createDiv({ cls: "vault-git-detail-sub" });
      if (d.headOid) {
        sub.createSpan({ text: `HEAD ${d.headOid.slice(0, 7)}` });
      } else {
        sub.createSpan({ text: "No commits yet (no HEAD)" });
      }
      if (d.branch) {
        sub.createSpan({ text: ` · ${d.branch}`, cls: "vault-git-detail-branch" });
      }
      this.renderSummary(contentEl, d.summary);
      this.renderFileTable(contentEl, d.files);
      return;
    }

    const d = this.detail as CommitDetailInfo;
    const title = d.message.split("\n")[0]?.trim() || d.shortOid;
    contentEl.createEl("h2", { text: title, cls: "vault-git-detail-h2" });
    const meta = contentEl.createDiv({ cls: "vault-git-detail-meta" });
    meta.createDiv({
      text: `${d.shortOid} · ${moment(d.committedDate).format("YYYY-MM-DD HH:mm")}`,
    });
    meta.createDiv({ text: `${d.authorName} <${d.authorEmail}>`, cls: "vault-git-detail-author" });
    meta.createDiv({
      text: `Compared to: ${d.compareLabel}`,
      cls: "vault-git-detail-compare",
    });
    if (d.message.includes("\n")) {
      contentEl.createEl("pre", {
        cls: "vault-git-detail-message",
        text: d.message.trim(),
      });
    }
    this.renderSummary(contentEl, d.summary);
    this.renderFileTable(contentEl, d.files);
  }

  private renderSummary(
    container: HTMLElement,
    summary: { additions: number; deletions: number; filesChanged: number }
  ): void {
    const s = container.createDiv({ cls: "vault-git-detail-summary" });
    const parts: string[] = [];
    parts.push(`${summary.filesChanged} file${summary.filesChanged === 1 ? "" : "s"} changed`);
    if (summary.additions > 0) parts.push(`${summary.additions} insertion${summary.additions === 1 ? "" : "s"}(+)`);
    if (summary.deletions > 0) parts.push(`${summary.deletions} deletion${summary.deletions === 1 ? "" : "s"}(-)`);
    s.setText(parts.join(", "));
  }

  private renderFileTable(container: HTMLElement, files: GitChangeFileStat[]): void {
    if (files.length === 0) {
      container.createDiv({ cls: "vault-git-detail-empty", text: "No file changes." });
      return;
    }

    const wrap = container.createDiv({ cls: "vault-git-detail-table-wrap" });
    const table = wrap.createEl("table", { cls: "vault-git-detail-table" });
    const thead = table.createEl("thead");
    const hr = thead.createEl("tr");
    hr.createEl("th", { text: "Path" });
    hr.createEl("th", { text: "Status" });
    hr.createEl("th", { text: "+", cls: "vault-git-detail-num" });
    hr.createEl("th", { text: "−", cls: "vault-git-detail-num" });

    const tbody = table.createEl("tbody");
    for (const f of files) {
      const tr = tbody.createEl("tr");
      tr.createEl("td", { text: f.path, cls: "vault-git-detail-path" });
      const st = f.binary ? `${f.status} (binary)` : f.status;
      tr.createEl("td", { text: st });
      tr.createEl("td", { text: String(f.additions), cls: "vault-git-detail-num vault-git-detail-add" });
      tr.createEl("td", { text: String(f.deletions), cls: "vault-git-detail-num vault-git-detail-del" });
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
