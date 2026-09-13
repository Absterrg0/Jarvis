import {
  EnvironmentId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationThread,
} from "@t3tools/contracts";
import { interpretPendingCirceReply, type CirceCommandTask } from "@circe/core/command";
import { resolveCirceLiveContextTask } from "@circe/client-runtime/circe/commandContext";
import { getPendingCirceReplyState, isExpectedPendingReply } from "@circe/core/confirmation";
import { describe, expect, it } from "vite-plus/test";

import {
  attachMobileCirceTask,
  buildMobileCirceExecuteInput,
  classifyServerFrameCancel,
  createMobileCirceTurn,
  resolveMobileFocusContextTask,
  resolveRetainedFrameId,
  restoreMobileFocusFromDesk,
  routeMobileCirceTurn,
} from "./mobileCirceTurn";

describe("mobile Circe turn routing", () => {
  it("keeps the routed execution project on the turn", () => {
    const executionNodeId = EnvironmentId.make("vps");
    const draft = createMobileCirceTurn({
      originInteractionId: "mobile-turn-a",
      inputMode: "text",
    });
    const turn = routeMobileCirceTurn(draft, {
      nodeId: executionNodeId,
      projectId: ProjectId.make("circe"),
    });

    expect(turn).toMatchObject({
      projectRef: { nodeId: executionNodeId },
      inputMode: "text",
    });
  });

  it("snapshots node-qualified task context at routing time", () => {
    const projectRef = {
      nodeId: EnvironmentId.make("desktop"),
      projectId: ProjectId.make("circe"),
    };
    const threadId = ThreadId.make("thread-context");
    const draft = createMobileCirceTurn({
      originInteractionId: "mobile-turn-context",
      inputMode: "text",
    });
    const turn = routeMobileCirceTurn(draft, projectRef, {
      threadId,
      taskRef: { executionNodeId: projectRef.nodeId, threadId },
      projectRef,
    });

    expect(turn).toMatchObject({
      contextThreadId: threadId,
      referenceThreadId: threadId,
    });
  });

  it("clears task context when the resolved project overrides the focused task project", () => {
    const projectRef = {
      nodeId: EnvironmentId.make("desktop"),
      projectId: ProjectId.make("alertify"),
    };
    const focusedThreadId = ThreadId.make("thread-focused");
    const focusedProjectRef = {
      nodeId: EnvironmentId.make("desktop"),
      projectId: ProjectId.make("circe"),
    };
    const draft = createMobileCirceTurn({
      originInteractionId: "mobile-turn-override",
      inputMode: "text",
    });
    const turn = routeMobileCirceTurn(draft, projectRef, {
      threadId: focusedThreadId,
      taskRef: { executionNodeId: focusedProjectRef.nodeId, threadId: focusedThreadId },
      projectRef: focusedProjectRef,
    });

    expect(turn.contextThreadId).toBeUndefined();
    expect(turn.referenceThreadId).toBeUndefined();
  });

  it("carries the routed focus through the execute builder into the pending-reply decision", () => {
    const projectId = ProjectId.make("circe");
    const projectRef = { nodeId: EnvironmentId.make("desktop"), projectId };
    const threadId = ThreadId.make("thread-focus");
    const turn = routeMobileCirceTurn(
      createMobileCirceTurn({
        originInteractionId: "mobile-turn-execute",
        inputMode: "text",
      }),
      projectRef,
      { threadId, taskRef: { executionNodeId: projectRef.nodeId, threadId }, projectRef },
    );
    const execute = buildMobileCirceExecuteInput({
      turn,
      projectRef,
      utterance: "Allow it.",
      requestId: "request-execute-1",
    });

    expect(execute.contextThreadId).toBe(threadId);
    expect(execute.referenceThreadId).toBe(threadId);
    expect(execute.requestMetadata).toMatchObject({
      requestId: "request-execute-1",
      origin: { originInteractionId: "mobile-turn-execute" },
    });

    const baseThread: OrchestrationThread = {
      id: threadId,
      projectId,
      title: "Authentication review",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.6-sol",
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      latestTurn: null,
      createdAt: "2026-08-30T00:00:00.000Z",
      updatedAt: "2026-08-30T00:00:00.000Z",
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      pullRequests: [],
      deletedAt: null,
      messages: [],
      proposedPlans: [],
      activities: [],
      checkpoints: [],
      session: null,
    };
    const contextTask: CirceCommandTask = {
      threadId,
      projectId,
      projectTitle: "Circe",
      title: "Authentication review",
      objective: "Fix authentication",
      state: "running",
    };
    const replyContext = (utterance: string, contextThread: OrchestrationThread) => ({
      utterance,
      currentProjectId: projectId,
      projects: [],
      aliases: [],
      tasks: [],
      contextThread,
      contextTask,
      providers: [],
      supervisorModelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.6-sol",
      },
      continueContext: false,
    });
    const approvalThread: OrchestrationThread = {
      ...baseThread,
      activities: [
        {
          id: EventId.make("approval-request"),
          tone: "approval",
          kind: "approval.requested",
          summary: "Allow command",
          payload: { requestId: "approval-1" },
          turnId: null,
          createdAt: "2026-08-30T00:00:00.000Z",
        },
      ],
    };
    expect(
      interpretPendingCirceReply(replyContext(execute.utterance, approvalThread), "continue"),
    ).toMatchObject({
      status: "command",
      command: {
        type: "answer",
        reply: { type: "approval", requestId: "approval-1", decision: "accept" },
      },
    });
    expect(
      interpretPendingCirceReply(replyContext("Deny it.", approvalThread), "continue"),
    ).toMatchObject({
      status: "command",
      command: {
        type: "answer",
        reply: { type: "approval", requestId: "approval-1", decision: "decline" },
      },
    });

    const inputThread: OrchestrationThread = {
      ...baseThread,
      activities: [
        {
          id: EventId.make("input-request"),
          tone: "info",
          kind: "user-input.requested",
          summary: "Need input",
          payload: { requestId: "input-1", questions: [{ id: "choice" }] },
          turnId: null,
          createdAt: "2026-08-30T00:00:00.000Z",
        },
      ],
    };
    expect(
      interpretPendingCirceReply(replyContext("Use the safe option.", inputThread), "continue"),
    ).toMatchObject({
      status: "command",
      command: {
        type: "answer",
        reply: { type: "input", requestId: "input-1", questionIds: ["choice"] },
      },
    });
  });

  it("resolves a newly arrived approval from the live desk through the shared policy", () => {
    const projectId = ProjectId.make("circe");
    const projectRef = { nodeId: EnvironmentId.make("desktop"), projectId };
    const threadId = ThreadId.make("thread-late-approval");
    // Routed before the provider asked: the snapshot holds no pin.
    const turn = routeMobileCirceTurn(
      createMobileCirceTurn({
        originInteractionId: "mobile-turn-late",
        inputMode: "text",
      }),
      projectRef,
      { threadId, taskRef: { executionNodeId: projectRef.nodeId, threadId }, projectRef },
    );
    expect(turn.expectedReply).toBeUndefined();
    // The approval arrives later. The shared policy merges the live pin
    // without changing the retained identity, and the execute builder
    // carries it as the answer pin.
    const live = resolveCirceLiveContextTask({
      selected: {
        threadId,
        taskRef: { executionNodeId: projectRef.nodeId, threadId },
        projectRef,
      },
      deskTasks: [
        {
          threadId,
          taskRef: { executionNodeId: projectRef.nodeId, threadId },
          projectRef,
          pendingReply: { kind: "approval" as const, requestId: "approval-live" },
        },
      ],
    });
    expect(live).toMatchObject({
      threadId,
      pendingReply: { kind: "approval", requestId: "approval-live" },
    });
    const answered = routeMobileCirceTurn(
      createMobileCirceTurn({
        originInteractionId: "mobile-turn-late-answer",
        inputMode: "text",
      }),
      projectRef,
      live ?? undefined,
    );
    const execute = buildMobileCirceExecuteInput({
      turn: answered,
      projectRef,
      utterance: "Allow it.",
      requestId: "request-live-1",
    });
    expect(execute.contextThreadId).toBe(threadId);
    expect(execute.expectedReply).toEqual({ kind: "approval", requestId: "approval-live" });
  });

  it("pins the expected reply so a closed request answered late never matches its replacement", () => {
    const projectRef = {
      nodeId: EnvironmentId.make("desktop"),
      projectId: ProjectId.make("circe"),
    };
    const threadId = ThreadId.make("thread-stale");
    const turn = routeMobileCirceTurn(
      createMobileCirceTurn({
        originInteractionId: "mobile-turn-stale",
        inputMode: "text",
      }),
      projectRef,
      {
        threadId,
        taskRef: { executionNodeId: projectRef.nodeId, threadId },
        projectRef,
        pendingReply: { kind: "approval", requestId: "request-a" },
      },
    );
    const execute = buildMobileCirceExecuteInput({
      turn,
      projectRef,
      utterance: "Allow it.",
      requestId: "request-stale-1",
    });
    expect(execute.expectedReply).toEqual({ kind: "approval", requestId: "request-a" });

    const liveAfterReplacement = getPendingCirceReplyState([
      {
        id: EventId.make("approval-a"),
        tone: "approval",
        kind: "approval.requested",
        summary: "First approval",
        payload: { requestId: "request-a" },
        turnId: null,
        createdAt: "2026-08-30T00:00:00.000Z",
      },
      {
        id: EventId.make("approval-a-resolved"),
        tone: "info",
        kind: "approval.resolved",
        summary: "First approval resolved",
        payload: { requestId: "request-a" },
        turnId: null,
        createdAt: "2026-08-30T00:00:01.000Z",
      },
      {
        id: EventId.make("approval-b"),
        tone: "approval",
        kind: "approval.requested",
        summary: "Second approval",
        payload: { requestId: "request-b" },
        turnId: null,
        createdAt: "2026-08-30T00:00:02.000Z",
      },
    ]);
    const pinned = execute.expectedReply;
    if (pinned === undefined || pinned === null) {
      throw new Error("Expected the builder to retain the pinned reply.");
    }
    expect(isExpectedPendingReply(liveAfterReplacement, pinned)).toBe(false);
  });

  it("binds answers and cancels to the exact server frame", () => {
    const projectRef = {
      nodeId: EnvironmentId.make("desktop"),
      projectId: ProjectId.make("circe"),
    };
    const turn = routeMobileCirceTurn(
      createMobileCirceTurn({
        originInteractionId: "mobile-turn-frame",
        inputMode: "text",
      }),
      projectRef,
    );
    const answer = buildMobileCirceExecuteInput({
      turn,
      projectRef,
      utterance: "the second one",
      clarificationFrameId: "frame-1",
      requestId: "request-frame-1",
    });
    expect(answer.clarificationFrameId).toBe("frame-1");
    expect(answer.utterance).toBe("the second one");

    const cancel = buildMobileCirceExecuteInput({
      turn,
      projectRef,
      utterance: "cancel",
      clarificationFrameId: "frame-1",
      requestId: "request-frame-2",
    });
    expect(cancel).toMatchObject({ utterance: "cancel", clarificationFrameId: "frame-1" });

    const fresh = buildMobileCirceExecuteInput({
      turn,
      projectRef,
      utterance: "Fix it.",
      requestId: "request-fresh-1",
    });
    expect(fresh).not.toHaveProperty("clarificationFrameId");
  });

  it("carries an explicit null pin when the snapshot saw no unique pending request", () => {
    const projectRef = {
      nodeId: EnvironmentId.make("desktop"),
      projectId: ProjectId.make("circe"),
    };
    const threadId = ThreadId.make("thread-quiet");
    const turn = routeMobileCirceTurn(
      createMobileCirceTurn({
        originInteractionId: "mobile-turn-quiet",
        inputMode: "text",
      }),
      projectRef,
      {
        threadId,
        taskRef: { executionNodeId: projectRef.nodeId, threadId },
        projectRef,
        pendingReply: null,
      },
    );
    const execute = buildMobileCirceExecuteInput({
      turn,
      projectRef,
      utterance: "Continue.",
      requestId: "request-quiet-1",
    });
    expect(execute).toMatchObject({
      contextThreadId: threadId,
      referenceThreadId: threadId,
      expectedReply: null,
    });
  });

  it("reuses the caller requestId verbatim across retries of the same turn", () => {
    const projectRef = {
      nodeId: EnvironmentId.make("desktop"),
      projectId: ProjectId.make("circe"),
    };
    const turn = routeMobileCirceTurn(
      createMobileCirceTurn({
        originInteractionId: "mobile-turn-retry",
        inputMode: "text",
      }),
      projectRef,
    );
    const first = buildMobileCirceExecuteInput({
      turn,
      projectRef,
      utterance: "Implement presence.",
      requestId: "request-retry-1",
    });
    const retry = buildMobileCirceExecuteInput({
      turn,
      projectRef,
      utterance: first.utterance,
      requestId: "request-retry-1",
    });

    expect(retry.requestMetadata.requestId).toBe("request-retry-1");
    expect(retry.requestMetadata.origin?.originInteractionId).toBe("mobile-turn-retry");
  });

  it("carries a proposal plus verbatim source without authorizing", () => {
    const projectRef = {
      nodeId: EnvironmentId.make("laptop"),
      projectId: ProjectId.make("rivvl"),
    };
    const turn = routeMobileCirceTurn(
      createMobileCirceTurn({
        originInteractionId: "mobile-turn-proposal",
        inputMode: "text",
      }),
      projectRef,
    );
    const source = "  Check PRs in Rivvl  ";
    const start = source.indexOf("in Rivvl");
    const execute = buildMobileCirceExecuteInput({
      turn,
      projectRef,
      utterance: "Check PRs in Rivvl",
      sourceUtterance: source,
      semanticProposal: {
        action: "start",
        refs: [
          {
            span: { start, end: start + "in Rivvl".length, text: "in Rivvl" },
            role: "destination",
            value: "Rivvl",
          },
        ],
        model: null,
        effort: null,
        answer: null,
      },
      requestId: "request-proposal-1",
    });
    // Verbatim source preserved for span authority; proposal never carries IDs.
    expect(execute.sourceUtterance).toBe(source);
    expect(execute.semanticProposal).toMatchObject({ action: "start" });
    expect(execute.utterance).toBe("Check PRs in Rivvl");
  });

  it("keeps the retained focus when the desk reports another task", () => {
    const nodeId = EnvironmentId.make("desktop");
    const projectId = ProjectId.make("circe");
    const projectRef = { nodeId, projectId };
    const retainedThreadId = ThreadId.make("thread-retained");
    const otherThreadId = ThreadId.make("thread-other");
    const resolved = resolveMobileFocusContextTask({
      retained: {
        threadId: retainedThreadId,
        taskRef: { executionNodeId: nodeId, threadId: retainedThreadId },
        projectRef,
      },
      deskTasks: [
        {
          threadId: otherThreadId,
          taskRef: { executionNodeId: nodeId, threadId: otherThreadId },
          projectRef,
          pendingReply: { kind: "approval", requestId: "request-other" },
        },
      ],
    });

    expect(resolved).toEqual({
      threadId: retainedThreadId,
      taskRef: { executionNodeId: nodeId, threadId: retainedThreadId },
      projectRef,
    });
    const turn = routeMobileCirceTurn(
      createMobileCirceTurn({
        originInteractionId: "mobile-turn-focus-a",
        inputMode: "text",
      }),
      projectRef,
      resolved,
    );
    expect(turn).toMatchObject({
      contextThreadId: retainedThreadId,
      referenceThreadId: retainedThreadId,
    });
    expect(turn).not.toHaveProperty("expectedReply");
  });

  it("enriches only the same thread with the desk pending pin", () => {
    const nodeId = EnvironmentId.make("desktop");
    const projectId = ProjectId.make("circe");
    const projectRef = { nodeId, projectId };
    const threadId = ThreadId.make("thread-enriched");
    const resolved = resolveMobileFocusContextTask({
      retained: {
        threadId,
        taskRef: { executionNodeId: nodeId, threadId },
        projectRef,
      },
      deskTasks: [
        {
          threadId,
          taskRef: { executionNodeId: nodeId, threadId },
          projectRef,
          pendingReply: { kind: "user-input", requestId: "input-1", questionIds: ["choice"] },
        },
      ],
    });

    expect(resolved).toEqual({
      threadId,
      taskRef: { executionNodeId: nodeId, threadId },
      projectRef,
      pendingReply: { kind: "user-input", requestId: "input-1", questionIds: ["choice"] },
    });
    const turn = routeMobileCirceTurn(
      createMobileCirceTurn({
        originInteractionId: "mobile-turn-focus-b",
        inputMode: "text",
      }),
      projectRef,
      resolved,
    );
    expect(turn).toMatchObject({
      contextThreadId: threadId,
      expectedReply: { kind: "input", requestId: "input-1" },
    });
  });

  it("clears the retained thread on project-only focus", () => {
    expect(
      resolveMobileFocusContextTask({
        retained: null,
        deskTasks: [
          {
            threadId: ThreadId.make("thread-desk"),
            taskRef: {
              executionNodeId: EnvironmentId.make("desktop"),
              threadId: ThreadId.make("thread-desk"),
            },
            projectRef: {
              nodeId: EnvironmentId.make("desktop"),
              projectId: ProjectId.make("circe"),
            },
          },
        ],
      }),
    ).toBeNull();
  });

  it("preserves node, thread, and request snapshots for a remote focused answer", () => {
    const remote = EnvironmentId.make("vps");
    const projectId = ProjectId.make("circe");
    const projectRef = { nodeId: remote, projectId };
    const threadId = ThreadId.make("thread-remote");
    const resolved = resolveMobileFocusContextTask({
      retained: {
        threadId,
        taskRef: { executionNodeId: remote, threadId },
        projectRef,
      },
      deskTasks: [
        {
          threadId,
          taskRef: { executionNodeId: remote, threadId },
          projectRef,
          pendingReply: { kind: "approval", requestId: "request-remote" },
        },
      ],
    });
    const turn = routeMobileCirceTurn(
      createMobileCirceTurn({
        originInteractionId: "mobile-turn-remote",
        inputMode: "text",
      }),
      projectRef,
      resolved,
    );
    const execute = buildMobileCirceExecuteInput({
      turn,
      projectRef,
      utterance: "Allow it.",
      requestId: "request-remote-answer",
    });

    expect(execute.projectRef).toEqual(projectRef);
    expect(execute).toMatchObject({
      contextThreadId: threadId,
      referenceThreadId: threadId,
      expectedReply: { kind: "approval", requestId: "request-remote" },
    });
    expect(
      interpretPendingCirceReply(
        {
          utterance: execute.utterance,
          currentProjectId: projectId,
          projects: [],
          aliases: [],
          tasks: [],
          contextThread: {
            id: threadId,
            projectId,
            title: "Remote review",
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5.6-sol",
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            latestTurn: null,
            createdAt: "2026-08-30T00:00:00.000Z",
            updatedAt: "2026-08-30T00:00:00.000Z",
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            pullRequests: [],
            deletedAt: null,
            messages: [],
            proposedPlans: [],
            activities: [
              {
                id: EventId.make("approval-remote"),
                tone: "approval",
                kind: "approval.requested",
                summary: "Allow command",
                payload: { requestId: "request-remote" },
                turnId: null,
                createdAt: "2026-08-30T00:00:00.000Z",
              },
            ],
            checkpoints: [],
            session: null,
          },
          contextTask: {
            threadId,
            projectId,
            projectTitle: "Circe",
            title: "Remote review",
            objective: "Fix authentication",
            state: "running",
          },
          providers: [],
          supervisorModelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.6-sol",
          },
          continueContext: false,
        },
        "continue",
      ),
    ).toMatchObject({
      status: "command",
      command: {
        type: "answer",
        reply: { type: "approval", requestId: "request-remote", decision: "accept" },
      },
    });
  });

  it("restores an unrestored focus from the first matching desk read", () => {
    const nodeId = EnvironmentId.make("desktop");
    const projectId = ProjectId.make("circe");
    const projectRef = { nodeId, projectId };
    const threadId = ThreadId.make("thread-restored");
    const focusedTask = {
      threadId,
      taskRef: { executionNodeId: nodeId, threadId },
      projectRef,
    };

    expect(
      restoreMobileFocusFromDesk({
        retained: undefined,
        deskFocusedTask: focusedTask,
        deskNodeId: nodeId,
        selectedDeskNodeId: nodeId,
        selectedProjectRef: projectRef,
        preferredProjectRef: undefined,
      }),
    ).toEqual({ threadId, taskRef: focusedTask.taskRef, projectRef });

    // An explicit project-only null stays null; a set identity stays put.
    expect(
      restoreMobileFocusFromDesk({
        retained: null,
        deskFocusedTask: focusedTask,
        deskNodeId: nodeId,
        selectedDeskNodeId: nodeId,
        selectedProjectRef: projectRef,
        preferredProjectRef: undefined,
      }),
    ).toBeNull();

    // A stale-node desk is never adopted, nor is a project mismatch or an
    // empty desk: restoration stays unknown until authoritative state arrives.
    const otherNode = EnvironmentId.make("vps");
    expect(
      restoreMobileFocusFromDesk({
        retained: undefined,
        deskFocusedTask: focusedTask,
        deskNodeId: otherNode,
        selectedDeskNodeId: nodeId,
        selectedProjectRef: projectRef,
        preferredProjectRef: undefined,
      }),
    ).toBeUndefined();
    expect(
      restoreMobileFocusFromDesk({
        retained: undefined,
        deskFocusedTask: focusedTask,
        deskNodeId: nodeId,
        selectedDeskNodeId: nodeId,
        selectedProjectRef: { nodeId, projectId: ProjectId.make("other") },
        preferredProjectRef: undefined,
      }),
    ).toBeUndefined();
    expect(
      restoreMobileFocusFromDesk({
        retained: undefined,
        deskFocusedTask: null,
        deskNodeId: nodeId,
        selectedDeskNodeId: nodeId,
        selectedProjectRef: projectRef,
        preferredProjectRef: undefined,
      }),
    ).toBeUndefined();
  });

  it("keeps a rejected answer bound to its old frame across retries", () => {
    expect(resolveRetainedFrameId(undefined, "frame-a")).toBe("frame-a");
    expect(resolveRetainedFrameId("frame-b", "frame-a")).toBe("frame-b");
    expect(resolveRetainedFrameId(undefined, undefined)).toBeUndefined();

    // A repeated answer after a stale rejection still carries the old frame,
    // and a fresh cancel carries none, so it can never deny unguarded.
    const projectRef = {
      nodeId: EnvironmentId.make("desktop"),
      projectId: ProjectId.make("circe"),
    };
    const turn = routeMobileCirceTurn(
      createMobileCirceTurn({
        originInteractionId: "mobile-turn-reframe",
        inputMode: "text",
      }),
      projectRef,
    );
    const retry = buildMobileCirceExecuteInput({
      turn,
      projectRef,
      utterance: "the second one",
      clarificationFrameId: resolveRetainedFrameId(undefined, "frame-a"),
      requestId: "request-reframe-1",
    });
    expect(retry.clarificationFrameId).toBe("frame-a");
    const freshCancel = buildMobileCirceExecuteInput({
      turn,
      projectRef,
      utterance: "cancel",
      requestId: "request-reframe-2",
    });
    expect(freshCancel).not.toHaveProperty("clarificationFrameId");
  });

  it("classifies frame cancels without claiming false success", () => {
    expect(
      classifyServerFrameCancel({
        status: "acknowledged",
        action: "focused",
        projectId: ProjectId.make("circe"),
        message: "Cancelled selection.",
      }),
    ).toBe("cleared");
    expect(
      classifyServerFrameCancel({
        status: "needs-input",
        reason: "source-output-unavailable",
        prompt: "That question is no longer waiting.",
        choices: [],
      }),
    ).toBe("retired");
    expect(
      classifyServerFrameCancel({
        status: "needs-input",
        reason: "control-target-required",
        prompt: "Which recent task did you mean?",
        choices: [],
      }),
    ).toBe("failed");
    expect(classifyServerFrameCancel(null)).toBe("failed");
    expect(
      classifyServerFrameCancel({
        status: "started",
        threadId: ThreadId.make("thread-1"),
        objective: "Do work.",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
      }),
    ).toBe("failed");
    // A frame-cancel that itself lost the pre-accept race leaves the original
    // frame open: the next instruction must still wait for it, not assume
    // the question went away.
    expect(
      classifyServerFrameCancel({ status: "cancelled", requestId: "request-frame-cancel" }),
    ).toBe("failed");
  });

  it("attaches task identity without changing the pinned presentation route", () => {
    const draft = createMobileCirceTurn({
      originInteractionId: "mobile-turn-b",
      inputMode: "text",
    });
    const turn = routeMobileCirceTurn(draft, {
      nodeId: EnvironmentId.make("desktop"),
      projectId: ProjectId.make("circe"),
    });
    const taskRef = {
      executionNodeId: EnvironmentId.make("desktop"),
      threadId: ThreadId.make("thread-b"),
    };

    expect(attachMobileCirceTask(turn, taskRef)).toEqual({ ...turn, taskRef });
  });

  it("bounds the source utterance once for the payload", () => {
    const projectRef = {
      nodeId: EnvironmentId.make("laptop"),
      projectId: ProjectId.make("rivvl"),
    };
    const turn = routeMobileCirceTurn(
      createMobileCirceTurn({
        originInteractionId: "mobile-turn-long",
        inputMode: "text",
      }),
      projectRef,
    );
    const source = `Start ${"x".repeat(20_000)}`;
    const execute = buildMobileCirceExecuteInput({
      turn,
      projectRef,
      utterance: "Start",
      sourceUtterance: source,
      semanticProposal: {
        action: "start",
        refs: [],
        model: null,
        effort: null,
        answer: null,
      },
      requestId: "request-long-1",
    });
    expect(execute.sourceUtterance).toHaveLength(16_000);
    expect(execute.requestMetadata).toMatchObject({ requestId: "request-long-1" });
    expect("inputMode" in execute.requestMetadata).toBe(false);
  });
});
