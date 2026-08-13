import { assert, describe, it } from "@effect/vitest";

import { companionContinuationTarget, resolveCompanionProjectTarget } from "./voice-routing.ts";

const target = { projectId: "project-1", threadId: "thread-1" } as const;

describe("companion voice routing", () => {
  const projects = [
    { id: "jarvis", title: "Jarvis", workspaceRoot: "C:\\work\\Jarvis" },
    { id: "api", title: "Payments API", workspaceRoot: "C:\\work\\payments-api" },
  ] as const;

  it("routes an explicit natural-language project without a setup selection", () => {
    assert.deepEqual(
      resolveCompanionProjectTarget({
        transcript: "In the Jarvis project, fix the voice overlay",
        projects,
      }),
      { kind: "resolved", project: projects[0], source: "spoken" },
    );
    assert.deepEqual(
      resolveCompanionProjectTarget({
        transcript: "For payments api, review the failing tests",
        projects,
      }),
      { kind: "resolved", project: projects[1], source: "spoken" },
    );
    assert.deepEqual(
      resolveCompanionProjectTarget({
        transcript: "Change directory to payments API and review the failing tests",
        projects,
      }),
      { kind: "resolved", project: projects[1], source: "spoken" },
    );
  });

  it("uses one project or the last successful voice project without reading the visible T3 tab", () => {
    assert.deepEqual(
      resolveCompanionProjectTarget({ transcript: "Run the tests", projects: [projects[0]] }),
      { kind: "resolved", project: projects[0], source: "only-project" },
    );
    assert.deepEqual(
      resolveCompanionProjectTarget({
        transcript: "Run the tests",
        projects,
        recentProjectId: "api",
      }),
      { kind: "resolved", project: projects[1], source: "recent" },
    );
  });

  it("asks for a project when routing would otherwise be unsafe", () => {
    assert.deepEqual(resolveCompanionProjectTarget({ transcript: "Run the tests", projects }), {
      kind: "needs-clarification",
      projects,
    });
    assert.deepEqual(
      resolveCompanionProjectTarget({
        transcript: "In the frontend project, run the tests",
        projects,
        recentProjectId: "jarvis",
      }),
      { kind: "needs-clarification", projects },
    );
  });

  it("continues only when continuation mode has an exact target", () => {
    assert.deepEqual(
      companionContinuationTarget({
        conversationMode: "continue-last-thread",
        transcript: "Continue with the migration",
        attentionTarget: target,
      }),
      target,
    );
    assert.isUndefined(
      companionContinuationTarget({
        conversationMode: "continue-last-thread",
        transcript: "Continue with the migration",
      }),
    );
  });

  it("starts explicitly routed provider work instead of contaminating the previous task", () => {
    assert.isUndefined(
      companionContinuationTarget({
        conversationMode: "continue-last-thread",
        transcript: "Use Codex to implement the new dashboard",
        attentionTarget: target,
      }),
    );
    assert.isUndefined(
      companionContinuationTarget({
        conversationMode: "continue-last-thread",
        transcript: "Spin up Claude Code to review the last change",
        attentionTarget: target,
      }),
    );
  });

  it("passes exact task context while leaving control meaning to the Director", () => {
    for (const transcript of [
      "actually use SQLite instead",
      "after that update the docs",
      "what is it doing",
      "do that last task in Payments API project",
    ]) {
      assert.deepEqual(
        companionContinuationTarget({
          conversationMode: "continue-last-thread",
          transcript,
          attentionTarget: target,
        }),
        target,
      );
    }
  });

  it("routes a blocked-task reply exactly even when new-thread mode is selected", () => {
    assert.deepEqual(
      companionContinuationTarget({
        conversationMode: "new-thread",
        transcript: "yes, allow it",
        attentionTarget: { ...target, reportKind: "approval-needed" },
      }),
      { ...target, reportKind: "approval-needed" },
    );
  });
});
