import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, type ObsidianGitSettings } from "../src/types";

describe("DEFAULT_SETTINGS", () => {
  it("has stable keys expected by the settings UI and GitManager", () => {
    const keys = Object.keys(DEFAULT_SETTINGS).sort();
    expect(keys).toEqual(
      [
        "authToken",
        "authUsername",
        "autoCommitEnabled",
        "autoCommitIntervalMinutes",
        "autoPushOnCommit",
        "branch",
        "commitMessageTemplate",
        "debugLogEnabled",
        "enableForceSync",
        "pullBeforePush",
        "pullStrategy",
        "remoteName",
        "remoteUrl",
        "showStatusBar",
      ].sort()
    );
  });

  it("merges with partial user data without dropping keys", () => {
    const merged: ObsidianGitSettings = Object.assign({}, DEFAULT_SETTINGS, {
      branch: "develop",
    });
    expect(merged.branch).toBe("develop");
    expect(merged.remoteName).toBe(DEFAULT_SETTINGS.remoteName);
  });
});
