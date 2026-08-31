import { describe, expect, it } from "vite-plus/test";

import { jarvisSemanticEvalCorpus } from "./jarvisSemanticEvalCorpus.ts";

describe("Jarvis semantic eval corpus", () => {
  it("keeps a representative, uniquely named 50-case command corpus", () => {
    expect(jarvisSemanticEvalCorpus).toHaveLength(50);
    expect(new Set(jarvisSemanticEvalCorpus.map((entry) => entry.id)).size).toBe(50);
    expect(new Set(jarvisSemanticEvalCorpus.map((entry) => entry.action))).toEqual(
      new Set([
        "start",
        "continue",
        "steer",
        "queue",
        "stop",
        "status",
        "review",
        "reroute",
        "focus-project",
        "focus-task",
        "list-projects",
      ]),
    );
  });
});
