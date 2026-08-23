import { describe, expect, it } from "@effect/vitest";

import { describeApproval } from "./describeApproval.ts";

describe("describeApproval", () => {
  it("describes test commands by purpose instead of reading shell syntax", () => {
    expect(
      describeApproval({
        requestKind: "command",
        detail: "pnpm exec vitest run apps/server/src/jarvis",
        projectTitle: "Jarvis",
      }),
    ).toEqual({
      spoken:
        "The agent wants to run the Jarvis tests. This reads the project and may use extra processing power for a few minutes. Allow it?",
      risk: "read-and-compute",
      rawDetail: "pnpm exec vitest run apps/server/src/jarvis",
    });
  });

  it("calls out destructive file operations without hiding the exact command", () => {
    expect(
      describeApproval({
        requestKind: "command",
        detail: "rm -rf dist/cache",
        projectTitle: "Jarvis",
      }),
    ).toEqual({
      spoken:
        "The agent wants to permanently delete dist/cache in Jarvis. This cannot be undone automatically. Allow it?",
      risk: "destructive",
      rawDetail: "rm -rf dist/cache",
    });
  });

  it("does not invent an explanation for an unknown command", () => {
    expect(
      describeApproval({
        requestKind: "command",
        detail: "custom-tool --opaque-flag",
        projectTitle: "Jarvis",
      }),
    ).toEqual({
      spoken:
        "The agent wants to run a command in Jarvis that I cannot safely summarize. Review the exact command on screen before allowing it.",
      risk: "unknown",
      rawDetail: "custom-tool --opaque-flag",
    });
  });

  it("explains remote and destructive git operations conservatively", () => {
    expect(
      describeApproval({
        requestKind: "command",
        detail: "git push origin main",
        projectTitle: "Jarvis",
      }),
    ).toMatchObject({
      risk: "external-effect",
      spoken: expect.stringContaining("remote repository"),
    });
    expect(
      describeApproval({
        requestKind: "command",
        detail: "git reset --hard HEAD~1",
        projectTitle: "Jarvis",
      }),
    ).toMatchObject({ risk: "destructive", spoken: expect.stringContaining("discard local work") });
  });

  it("classifies cargo install as an external dependency change, not a local build", () => {
    expect(
      describeApproval({
        requestKind: "command",
        detail: "cargo install ripgrep",
        projectTitle: "Jarvis",
      }),
    ).toMatchObject({ risk: "external-effect", spoken: expect.stringContaining("dependencies") });
  });

  it("explains file reads and writes in ordinary language", () => {
    expect(
      describeApproval({ requestKind: "file-read", detail: "src/auth.ts", projectTitle: "API" }),
    ).toMatchObject({
      spoken: "The agent wants to read src/auth.ts in API. Allow it?",
      risk: "read",
    });
    expect(
      describeApproval({ requestKind: "file-change", detail: "src/auth.ts", projectTitle: "API" }),
    ).toMatchObject({
      spoken:
        "The agent wants to modify src/auth.ts in API. The change will remain reviewable in T3. Allow it?",
      risk: "workspace-write",
    });
  });

  it("explains a wrapped read-only repository inspection instead of saying something", () => {
    const description = describeApproval({
      requestKind: "command",
      detail:
        "/usr/bin/bash -lc \"sed -n '1,240p' /home/abstergo/.agents/skills/code-review/SKILL.md && printf '\\\\n--- repo ---\\\\n' && git remote -v && git status --short && git branch --show-current\"",
      projectTitle: "Alertify",
    });

    expect(description).toMatchObject({ risk: "read" });
    expect(description.spoken).toContain("read the code-review instructions");
    expect(description.spoken).toContain("repository remotes, status, and current branch");
    expect(description.spoken).toContain("Alertify");
  });

  it("explains a compound local project inspection from the approval surface", () => {
    const description = describeApproval({
      requestKind: "command",
      detail:
        "/usr/bin/bash -lc \"sed -n '1,220p' package.json && sed -n '1,220p' README.md && find . -maxdepth 2 -type d -not -path './.git*' -print | sort\"",
      projectTitle: "Alertify",
    });

    expect(description).toMatchObject({ risk: "read" });
    expect(description.spoken).toContain("read package.json and README.md");
    expect(description.spoken).toContain("list the top-level project directories");
    expect(description.spoken).toContain("Alertify");
  });
});
