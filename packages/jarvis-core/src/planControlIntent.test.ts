import { describe, expect, it } from "@effect/vitest";

import { planControlIntent } from "./planControlIntent.ts";

const running = {
  threadId: "thread-1",
  projectId: "project-jarvis",
  projectTitle: "Jarvis",
  threadTitle: "Fix authentication",
  objective: "Fix the authentication bug",
  state: "running" as const,
  activeTurnId: "turn-1",
};

describe("planControlIntent", () => {
  it("focuses the project resolved by the transport", () => {
    expect(
      planControlIntent({
        utterance: "switch to the Fable project",
        targetProjectId: "project-fable",
      }),
    ).toEqual({ action: "focus-project", projectId: "project-fable" });
  });
  it("steers a running focused task", () => {
    expect(
      planControlIntent({
        utterance: "also add regression tests",
        targetProjectId: "project-jarvis",
        focused: running,
      }),
    ).toEqual({ action: "steer", threadId: "thread-1", instruction: "add regression tests" });
  });

  it("queues a follow-up without sending it into the active turn", () => {
    expect(
      planControlIntent({
        utterance: "after that update the docs",
        targetProjectId: "project-jarvis",
        focused: running,
      }),
    ).toEqual({ action: "queue", threadId: "thread-1", instruction: "update the docs" });
  });

  it("interrupts and replays the original objective when rerouted", () => {
    expect(
      planControlIntent({
        utterance: "do that last run in Fable",
        targetProjectId: "project-fable",
        focused: running,
      }),
    ).toEqual({
      action: "reroute",
      sourceThreadId: "thread-1",
      targetProjectId: "project-fable",
      objective: "Fix the authentication bug",
      interrupt: { threadId: "thread-1", turnId: "turn-1" },
    });
  });

  it("reports useful state without creating a task", () => {
    expect(
      planControlIntent({
        utterance: "what is it doing",
        targetProjectId: "project-jarvis",
        focused: running,
      }),
    ).toEqual({
      action: "status",
      threadId: "thread-1",
      message: "Fix authentication is still running in Jarvis.",
    });
  });

  it("reports a blocked approval before generic running state", () => {
    expect(
      planControlIntent({
        utterance: "what is it doing",
        targetProjectId: "project-jarvis",
        focused: { ...running, waitingFor: "approval", queuedFollowUps: 1 },
      }),
    ).toMatchObject({
      action: "status",
      message: "Fix authentication is waiting for your approval in Jarvis.",
    });
  });

  it("asks for focus rather than guessing a referential control command", () => {
    expect(
      planControlIntent({ utterance: "stop that", targetProjectId: "project-jarvis" }),
    ).toEqual({
      action: "needs-focus",
      prompt: "I don't have a recent Jarvis task to apply that to.",
    });
  });
});
