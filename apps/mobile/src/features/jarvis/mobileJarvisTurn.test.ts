import {
  EnvironmentId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationThread,
} from "@t3tools/contracts";
import { interpretPendingJarvisReply, type JarvisCommandTask } from "@t3tools/jarvis-core/command";
import { resolveJarvisLiveContextTask } from "@t3tools/jarvis-client-runtime/jarvis/commandContext";
import {
  getPendingJarvisReplyState,
  isExpectedPendingReply,
} from "@t3tools/jarvis-core/confirmation";
import { describe, expect, it } from "vite-plus/test";

import {
  attachMobileJarvisTask,
  buildMobileJarvisExecuteInput,
  classifyServerFrameCancel,
  createMobileJarvisVoiceTurn,
  resolveMobileFocusContextTask,
  resolveRetainedFrameId,
  restoreMobileFocusFromDesk,
  routeMobileJarvisTurn,
} from "./mobileJarvisTurn";

describe("mobile Jarvis turn routing", () => {
  it("pins execution and voice nodes independently for the lifetime of a voice turn", () => {
    const executionNodeId = EnvironmentId.make("vps");
    const voiceNodeId = EnvironmentId.make("desktop");
    const draft = createMobileJarvisVoiceTurn({
      originInteractionId: "mobile-turn-a",
      voiceNodeId,
    });
    const turn = routeMobileJarvisTurn(draft, {
      nodeId: executionNodeId,
      projectId: ProjectId.make("jarvis"),
    });

    expect(turn).toMatchObject({
      projectRef: { nodeId: executionNodeId },
      voiceNodeId,
      speechEnabled: true,
    });
  });

  it("snapshots node-qualified task context at routing time", () => {
    const projectRef = {
      nodeId: EnvironmentId.make("desktop"),
      projectId: ProjectId.make("jarvis"),
    };
    const threadId = ThreadId.make("thread-context");
    const draft = createMobileJarvisVoiceTurn({
      originInteractionId: "mobile-turn-context",
      voiceNodeId: EnvironmentId.make("laptop"),
    });
    const turn = routeMobileJarvisTurn(draft, projectRef, {
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
      projectId: ProjectId.make("jarvis"),
    };
    const draft = createMobileJarvisVoiceTurn({
      originInteractionId: "mobile-turn-override",
      voiceNodeId: EnvironmentId.make("laptop"),
    });
    const turn = routeMobileJarvisTurn(draft, projectRef, {
      threadId: focusedThreadId,
      taskRef: { executionNodeId: focusedProjectRef.nodeId, threadId: focusedThreadId },
      projectRef: focusedProjectRef,
    });

    expect(turn.contextThreadId).toBeUndefined();
    expect(turn.referenceThreadId).toBeUndefined();
  });

  it("carries the routed focus through the execute builder into the pending-reply decision", () => {
    const projectId = ProjectId.make("jarvis");
    const projectRef = { nodeId: EnvironmentId.make("desktop"), projectId };
    const threadId = ThreadId.make("thread-focus");
    const turn = routeMobileJarvisTurn(
      createMobileJarvisVoiceTurn({
        originInteractionId: "mobile-turn-execute",
        voiceNodeId: EnvironmentId.make("laptop"),
      }),
      projectRef,
      { threadId, taskRef: { executionNodeId: projectRef.nodeId, threadId }, projectRef },
    );
    const execute = buildMobileJarvisExecuteInput({
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
      deletedAt: null,
      messages: [],
      proposedPlans: [],
      activities: [],
      checkpoints: [],
      session: null,
    };
    const contextTask: JarvisCommandTask = {
      threadId,
      projectId,
      projectTitle: "Jarvis",
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
      interpretPendingJarvisReply(replyContext(execute.utterance, approvalThread), "continue"),
    ).toMatchObject({
      status: "command",
      command: {
        type: "answer",
        reply: { type: "approval", requestId: "approval-1", decision: "accept" },
      },
    });
    expect(
      interpretPendingJarvisReply(replyContext("Deny it.", approvalThread), "continue"),
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
      interpretPendingJarvisReply(replyContext("Use the safe option.", inputThread), "continue"),
    ).toMatchObject({
      status: "command",
      command: {
        type: "answer",
        reply: { type: "input", requestId: "input-1", questionIds: ["choice"] },
      },
    });
  });

  it("resolves a newly arrived approval from the live desk through the shared policy", () => {
    const projectId = ProjectId.make("jarvis");
    const projectRef = { nodeId: EnvironmentId.make("desktop"), projectId };
    const threadId = ThreadId.make("thread-late-approval");
    // Routed before the provider asked: the snapshot holds no pin.
    const turn = routeMobileJarvisTurn(
      createMobileJarvisVoiceTurn({
        originInteractionId: "mobile-turn-late",
        voiceNodeId: EnvironmentId.make("laptop"),
      }),
      projectRef,
      { threadId, taskRef: { executionNodeId: projectRef.nodeId, threadId }, projectRef },
    );
    expect(turn.expectedReply).toBeUndefined();
    // The approval arrives later. The shared policy merges the live pin
    // without changing the retained identity, and the execute builder
    // carries it as the answer pin.
    const live = resolveJarvisLiveContextTask({
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
    const answered = routeMobileJarvisTurn(
      createMobileJarvisVoiceTurn({
        originInteractionId: "mobile-turn-late-answer",
        voiceNodeId: EnvironmentId.make("laptop"),
      }),
      projectRef,
      live ?? undefined,
    );
    const execute = buildMobileJarvisExecuteInput({
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
      projectId: ProjectId.make("jarvis"),
    };
    const threadId = ThreadId.make("thread-stale");
    const turn = routeMobileJarvisTurn(
      createMobileJarvisVoiceTurn({
        originInteractionId: "mobile-turn-stale",
        voiceNodeId: EnvironmentId.make("laptop"),
      }),
      projectRef,
      {
        threadId,
        taskRef: { executionNodeId: projectRef.nodeId, threadId },
        projectRef,
        pendingReply: { kind: "approval", requestId: "request-a" },
      },
    );
    const execute = buildMobileJarvisExecuteInput({
      turn,
      projectRef,
      utterance: "Allow it.",
      requestId: "request-stale-1",
    });
    expect(execute.expectedReply).toEqual({ kind: "approval", requestId: "request-a" });

    const liveAfterReplacement = getPendingJarvisReplyState([
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
      projectId: ProjectId.make("jarvis"),
    };
    const turn = routeMobileJarvisTurn(
      createMobileJarvisVoiceTurn({
        originInteractionId: "mobile-turn-frame",
        voiceNodeId: EnvironmentId.make("laptop"),
      }),
      projectRef,
    );
    const answer = buildMobileJarvisExecuteInput({
      turn,
      projectRef,
      utterance: "the second one",
      clarificationFrameId: "frame-1",
      requestId: "request-frame-1",
    });
    expect(answer.clarificationFrameId).toBe("frame-1");
    expect(answer.utterance).toBe("the second one");

    const cancel = buildMobileJarvisExecuteInput({
      turn,
      projectRef,
      utterance: "cancel",
      clarificationFrameId: "frame-1",
      requestId: "request-frame-2",
    });
    expect(cancel).toMatchObject({ utterance: "cancel", clarificationFrameId: "frame-1" });

    const fresh = buildMobileJarvisExecuteInput({
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
      projectId: ProjectId.make("jarvis"),
    };
    const threadId = ThreadId.make("thread-quiet");
    const turn = routeMobileJarvisTurn(
      createMobileJarvisVoiceTurn({
        originInteractionId: "mobile-turn-quiet",
        voiceNodeId: EnvironmentId.make("laptop"),
      }),
      projectRef,
      {
        threadId,
        taskRef: { executionNodeId: projectRef.nodeId, threadId },
        projectRef,
        pendingReply: null,
      },
    );
    const execute = buildMobileJarvisExecuteInput({
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
      projectId: ProjectId.make("jarvis"),
    };
    const turn = routeMobileJarvisTurn(
      createMobileJarvisVoiceTurn({
        originInteractionId: "mobile-turn-retry",
        voiceNodeId: EnvironmentId.make("laptop"),
      }),
      projectRef,
    );
    const first = buildMobileJarvisExecuteInput({
      turn,
      projectRef,
      utterance: "Implement presence.",
      requestId: "request-retry-1",
    });
    const retry = buildMobileJarvisExecuteInput({
      turn,
      projectRef,
      utterance: first.utterance,
      requestId: "request-retry-1",
    });

    expect(retry.requestMetadata.requestId).toBe("request-retry-1");
    expect(retry.requestMetadata.origin?.originInteractionId).toBe("mobile-turn-retry");
  });

  it("keeps the retained focus when the desk reports another task", () => {
    const nodeId = EnvironmentId.make("desktop");
    const projectId = ProjectId.make("jarvis");
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
    const turn = routeMobileJarvisTurn(
      createMobileJarvisVoiceTurn({
        originInteractionId: "mobile-turn-focus-a",
        voiceNodeId: EnvironmentId.make("laptop"),
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
    const projectId = ProjectId.make("jarvis");
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
    const turn = routeMobileJarvisTurn(
      createMobileJarvisVoiceTurn({
        originInteractionId: "mobile-turn-focus-b",
        voiceNodeId: EnvironmentId.make("laptop"),
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
              projectId: ProjectId.make("jarvis"),
            },
          },
        ],
      }),
    ).toBeNull();
  });

  it("preserves node, thread, and request snapshots for a remote focused answer", () => {
    const remote = EnvironmentId.make("vps");
    const projectId = ProjectId.make("jarvis");
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
    const turn = routeMobileJarvisTurn(
      createMobileJarvisVoiceTurn({
        originInteractionId: "mobile-turn-remote",
        voiceNodeId: EnvironmentId.make("laptop"),
      }),
      projectRef,
      resolved,
    );
    const execute = buildMobileJarvisExecuteInput({
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
      interpretPendingJarvisReply(
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
            projectTitle: "Jarvis",
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
    const projectId = ProjectId.make("jarvis");
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
      projectId: ProjectId.make("jarvis"),
    };
    const turn = routeMobileJarvisTurn(
      createMobileJarvisVoiceTurn({
        originInteractionId: "mobile-turn-reframe",
        voiceNodeId: EnvironmentId.make("laptop"),
      }),
      projectRef,
    );
    const retry = buildMobileJarvisExecuteInput({
      turn,
      projectRef,
      utterance: "the second one",
      clarificationFrameId: resolveRetainedFrameId(undefined, "frame-a"),
      requestId: "request-reframe-1",
    });
    expect(retry.clarificationFrameId).toBe("frame-a");
    const freshCancel = buildMobileJarvisExecuteInput({
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
        projectId: ProjectId.make("jarvis"),
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
  });

  it("attaches task identity without changing the pinned presentation route", () => {
    const draft = createMobileJarvisVoiceTurn({
      originInteractionId: "mobile-turn-b",
      voiceNodeId: EnvironmentId.make("laptop"),
    });
    const turn = routeMobileJarvisTurn(draft, {
      nodeId: EnvironmentId.make("desktop"),
      projectId: ProjectId.make("jarvis"),
    });
    const taskRef = {
      executionNodeId: EnvironmentId.make("desktop"),
      threadId: ThreadId.make("thread-b"),
    };

    expect(attachMobileJarvisTask(turn, taskRef)).toEqual({ ...turn, taskRef });
  });
});
