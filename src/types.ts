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

  /** Show status in the status bar */
  showStatusBar: boolean;
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
  showStatusBar: true,
};
