import { ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveProviderReplacementTarget } from "./resolveProviderReplacement.ts";

const task = (id: string, title: string, createdAt?: string) => ({
  threadId: ThreadId.make(id),
  projectId: ProjectId.make("project-jarvis"),
  title,
  objective: `Work on ${title}`,
  state: "running" as const,
  voiceAliases: [],
  ...(createdAt === undefined ? {} : { createdAt }),
});

describe("resolveProviderReplacementTarget", () => {
  it("uses creation order instead of MRU order for ordinals", () => {
    const result = resolveProviderReplacementTarget({
      target: { kind: "ordinal", index: 0, label: "first" },
      tasks: [
        task("newer", "Newer task", "2026-08-26T02:00:00.000Z"),
        task("older", "Older task", "2026-08-26T01:00:00.000Z"),
      ],
    });
    expect(result).toMatchObject({ status: "resolved", task: { threadId: "older" } });
  });

  it("requires a name when legacy tasks have no creation metadata", () => {
    expect(
      resolveProviderReplacementTarget({
        target: { kind: "ordinal", index: 0, label: "first" },
        tasks: [task("one", "One task")],
      }),
    ).toMatchObject({ status: "needs-input" });
  });

  it("does not number tasks with tied creation times", () => {
    expect(
      resolveProviderReplacementTarget({
        target: { kind: "ordinal", index: 0, label: "first" },
        tasks: [
          task("one", "One task", "2026-08-26T01:00:00.000Z"),
          task("two", "Two task", "2026-08-26T01:00:00.000Z"),
        ],
      }),
    ).toMatchObject({ status: "needs-input" });
  });

  it("does not let an empty normalized name select every task", () => {
    expect(
      resolveProviderReplacementTarget({
        target: { kind: "named", query: "…" },
        tasks: [task("one", "One task")],
      }),
    ).toMatchObject({ status: "needs-input" });
  });

  it("resolves a unique title or objective query", () => {
    expect(
      resolveProviderReplacementTarget({
        target: { kind: "named", query: "authentication" },
        tasks: [task("auth", "Authentication review"), task("docs", "Documentation")],
      }),
    ).toMatchObject({ status: "resolved", task: { threadId: "auth" } });
  });
});
