import { ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveTaskDeskNavigation } from "./resolveTaskDeskNavigation.ts";

const task = (id: string, title: string, objective: string, voiceAliases: string[] = []) => ({
  threadId: ThreadId.make(id),
  projectId: ProjectId.make("project-jarvis"),
  title,
  objective,
  state: "running" as const,
  voiceAliases,
});

describe("resolveTaskDeskNavigation", () => {
  const tasks = [
    task("thread-rivvl", "Rivvl authentication review", "Review the authentication flow"),
    task("thread-voice", "Jarvis voice workflow", "Improve voice routing", ["voice work"]),
  ];

  it.each([
    ["Go back", { action: "back" }],
    ["move forward", { action: "forward" }],
    ["Start another conversation", { action: "new-conversation" }],
  ])("resolves %s to a typed navigation command", (utterance, navigation) => {
    expect(resolveTaskDeskNavigation({ utterance, tasks })).toEqual({
      status: "resolved",
      navigation,
    });
  });

  it("resolves task language only to an existing task ID", () => {
    expect(
      resolveTaskDeskNavigation({ utterance: "Switch to the Rivvl review task", tasks }),
    ).toEqual({
      status: "resolved",
      navigation: { action: "focus", threadId: ThreadId.make("thread-rivvl") },
    });
    expect(resolveTaskDeskNavigation({ utterance: "Focus on voice work task", tasks })).toEqual({
      status: "resolved",
      navigation: { action: "focus", threadId: ThreadId.make("thread-voice") },
    });
  });

  it("returns bounded choices instead of guessing an unknown task", () => {
    const result = resolveTaskDeskNavigation({ utterance: "Switch to the payments task", tasks });
    expect(result).toMatchObject({
      status: "needs-input",
      choices: tasks.map(
        (item, index) => `${index + 1}. ${item.title} — ${item.state}: ${item.objective}`,
      ),
    });
  });

  it("does not intercept ordinary file or project instructions", () => {
    expect(
      resolveTaskDeskNavigation({ utterance: "Go to src/auth.ts and fix the bug", tasks }),
    ).toEqual({ status: "not-navigation" });
    expect(resolveTaskDeskNavigation({ utterance: "Switch to the Rivvl project", tasks })).toEqual({
      status: "not-navigation",
    });
    expect(resolveTaskDeskNavigation({ utterance: "Focus on cat task", tasks })).toMatchObject({
      status: "needs-input",
    });
  });
});
