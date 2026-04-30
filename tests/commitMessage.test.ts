import { describe, expect, it } from "vitest";
import { expandCommitMessageTemplate } from "../src/commitMessage";

describe("expandCommitMessageTemplate", () => {
  it("uses default template when undefined", () => {
    expect(expandCommitMessageTemplate(undefined, "2026-04-30 12:00:00")).toBe(
      "vault backup: 2026-04-30 12:00:00"
    );
  });

  it("replaces {{date}} with the given string", () => {
    expect(expandCommitMessageTemplate("snap: {{date}}", "x")).toBe("snap: x");
  });

  it("replaces every {{date}} occurrence", () => {
    expect(expandCommitMessageTemplate("{{date}} — {{date}}", "t")).toBe("t — t");
  });

  it("treats empty string template as missing and applies default", () => {
    expect(expandCommitMessageTemplate("", "d")).toBe("vault backup: d");
  });
});
