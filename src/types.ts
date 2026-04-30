/**
 * Normalised git status returned by both desktop (simple-git) and
 * mobile (isomorphic-git) implementations.
 */
export interface GitStatus {
  current: string | null;
  ahead: number;
  behind: number;
  staged: string[];
  modified: string[];
  not_added: string[];
  deleted: string[];
  renamed: string[];
  conflicted: string[];
}

/** Plugin settings interface */
export interface ObsidianGitSettings {
  /** Remote repository URL (e.g. https://github.com/user/repo.git or git@github.com:user/repo.git) */
  remoteUrl: string;

  /** Remote name, defaults to "origin" */
  remoteName: string;

  /** Branch to push/pull, defaults to "main" */
  branch: string;

  /** Authentication: username for HTTPS remotes */
  authUsername: string;

  /**
   * Authentication: personal access token or password for HTTPS remotes.
   * For SSH remotes leave this empty and rely on the system SSH agent.
   */
  authToken: string;

  /** Commit message template. Use {{date}} for the current date/time. */
  commitMessageTemplate: string;

  /** Whether auto-commit is enabled */
  autoCommitEnabled: boolean;

  /** Auto-commit interval in minutes (0 = disabled) */
  autoCommitIntervalMinutes: number;

  /** Whether to automatically push after each commit */
  autoPushOnCommit: boolean;

  /** Whether to pull (rebase) before pushing */
  pullBeforePush: boolean;

  /** Pull strategy: merge or rebase */
  pullStrategy: "merge" | "rebase";

  /** Allow destructive force sync from remote to local */
  enableForceSync: boolean;

  /** Show status in the status bar */
  showStatusBar: boolean;

  /** Enable verbose debug logging and persist logs to debug.log */
  debugLogEnabled: boolean;
}

/** View type id for the Git history / graph pane */
export const GIT_HISTORY_VIEW_TYPE = "vault-git-sync-git-history";

/** One commit row for history / graph UI */
export interface GitLogCommit {
  oid: string;
  shortOid: string;
  message: string;
  messageTitle: string;
  authorName: string;
  authorEmail: string;
  /** UTC milliseconds */
  committedDate: number;
  parents: string[];
}

/** Per-file diff stats for history / working tree detail */
export interface GitChangeFileStat {
  path: string;
  status: "modified" | "added" | "deleted";
  additions: number;
  deletions: number;
  binary?: boolean;
}

export interface GitDiffSummary {
  additions: number;
  deletions: number;
  filesChanged: number;
}

/** Uncommitted changes detail (HEAD vs working tree) */
export interface WorkingTreeDetail {
  headOid: string | null;
  branch: string | null;
  files: GitChangeFileStat[];
  summary: GitDiffSummary;
}

/** Single commit vs first parent (or root vs empty) */
export interface CommitDetailInfo {
  oid: string;
  shortOid: string;
  message: string;
  authorName: string;
  authorEmail: string;
  committedDate: number;
  parents: string[];
  compareOid: string | null;
  compareLabel: string;
  files: GitChangeFileStat[];
  summary: GitDiffSummary;
}

export const DEFAULT_SETTINGS: ObsidianGitSettings = {
  remoteUrl: "",
  remoteName: "origin",
  branch: "main",
  authUsername: "",
  authToken: "",
  commitMessageTemplate: "vault backup: {{date}}",
  autoCommitEnabled: false,
  autoCommitIntervalMinutes: 30,
  autoPushOnCommit: false,
  pullBeforePush: true,
  pullStrategy: "rebase",
  enableForceSync: false,
  showStatusBar: true,
  debugLogEnabled: false,
};
