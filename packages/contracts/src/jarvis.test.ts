import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  JarvisCancelRequestInput,
  JarvisCancelRequestResult,
  JarvisExecuteInput,
  JarvisExecutionCancelled,
  JarvisExecutionResult,
  JarvisExecutionStarted,
  JarvisExpectedReply,
  JarvisInterpretInput,
  JarvisNeedsInput,
  JarvisNodeId,
  JarvisOriginMetadata,
  JarvisProjectAlias,
  JarvisProjectClarificationFrame,
  JarvisProjectVocabularyEntry,
  JarvisProjectRef,
  JarvisRequestMetadata,
  JarvisSemanticProposal,
  JarvisTaskCreatedActivityPayload,
  JarvisTaskClarificationFrame,
  JarvisTaskDeskTask,
  JarvisTaskDeskTaskView,
  JarvisFocusTaskInput,
  JarvisTaskRef,
  JarvisPresentationEvent,
  JarvisPushToken,
  JarvisPushRegistrationInput,
} from "./jarvis.ts";

const decodeProposal = Schema.decodeUnknownSync(JarvisSemanticProposal);
const decodeInterpretInput = Schema.decodeUnknownSync(JarvisInterpretInput);
const decodeNodeId = Schema.decodeUnknownSync(JarvisNodeId);
const decodeCancelRequestInput = Schema.decodeUnknownSync(JarvisCancelRequestInput);
const decodeCancelRequestResult = Schema.decodeUnknownSync(JarvisCancelRequestResult);
const decodeExecutionCancelled = Schema.decodeUnknownSync(JarvisExecutionCancelled);
const decodeExecutionResult = Schema.decodeUnknownSync(JarvisExecutionResult);
const decodeProjectRef = Schema.decodeUnknownSync(JarvisProjectRef);
const decodeTaskRef = Schema.decodeUnknownSync(JarvisTaskRef);
const decodeOriginMetadata = Schema.decodeUnknownSync(JarvisOriginMetadata);
const decodeRequestMetadata = Schema.decodeUnknownSync(JarvisRequestMetadata);
const decodeExecuteInput = Schema.decodeUnknownSync(JarvisExecuteInput);
const decodeExpectedReply = Schema.decodeUnknownSync(JarvisExpectedReply);
const decodeNeedsInput = Schema.decodeUnknownSync(JarvisNeedsInput);
const decodeExecutionStarted = Schema.decodeUnknownSync(JarvisExecutionStarted);
const decodeTaskDeskTask = Schema.decodeUnknownSync(JarvisTaskDeskTask);
const decodeTaskDeskTaskView = Schema.decodeUnknownSync(JarvisTaskDeskTaskView);
const decodeTaskClarificationFrame = Schema.decodeUnknownSync(JarvisTaskClarificationFrame);
const decodeProjectClarificationFrame = Schema.decodeUnknownSync(JarvisProjectClarificationFrame);
const decodeFocusTaskInput = Schema.decodeUnknownSync(JarvisFocusTaskInput);
const decodeTaskCreatedActivityPayload = Schema.decodeUnknownSync(JarvisTaskCreatedActivityPayload);
const decodePresentation = Schema.decodeUnknownSync(JarvisPresentationEvent);
const decodeProjectAlias = Schema.decodeUnknownSync(JarvisProjectAlias);
const decodeProjectVocabularyEntry = Schema.decodeUnknownSync(JarvisProjectVocabularyEntry);
const decodePushToken = Schema.decodeUnknownSync(JarvisPushToken);
const decodePushRegistration = Schema.decodeUnknownSync(JarvisPushRegistrationInput);

describe("Jarvis node-qualified references", () => {
  it("rejects unqualified or malformed push registrations", () => {
    expect(() => decodePushToken("not-an-expo-token")).toThrow();
    expect(() =>
      decodePushRegistration({ token: "not-an-expo-token", deviceId: "device-1" }),
    ).toThrow();
  });

  it("uses the stable environment identity for a project reference", () => {
    expect(decodeNodeId(" node-1 ")).toBe("node-1");
    expect(decodeProjectRef({ nodeId: "node-1", projectId: "project-1" })).toEqual({
      nodeId: "node-1",
      projectId: "project-1",
    });
  });

  it("decodes a node-qualified thread identity", () => {
    expect(
      decodeTaskRef({
        executionNodeId: "node-1",
        threadId: "thread-1",
      }),
    ).toEqual({
      executionNodeId: "node-1",
      threadId: "thread-1",
    });
  });

  it("keeps request identity separate from the originating interaction", () => {
    expect(
      decodeRequestMetadata({
        requestId: "request-1",
        origin: {
          originNodeId: "node-1",
          originInteractionId: "interaction-1",
        },
      }),
    ).toEqual({
      requestId: "request-1",
      origin: {
        originNodeId: "node-1",
        originInteractionId: "interaction-1",
      },
    });
    expect(decodeOriginMetadata({})).toEqual({});
  });

  it("carries optional routing metadata through execution requests and starts", () => {
    const requestMetadata = {
      requestId: "request-1",
      origin: { originNodeId: "node-origin", originInteractionId: "interaction-1" },
    };
    const taskRef = {
      executionNodeId: "node-1",
      threadId: "thread-1",
    };

    expect(
      decodeExecuteInput({
        projectId: "project-1",
        projectRef: { nodeId: "node-1", projectId: "project-1" },
        requestMetadata,
        utterance: "Fix the failing tests.",
      }),
    ).toMatchObject({
      kind: "control",
      projectRef: { nodeId: "node-1", projectId: "project-1" },
      requestMetadata,
    });

    expect(decodeExecuteInput({ kind: "converse", utterance: "What is new today?" })).toMatchObject(
      {
        kind: "converse",
        utterance: "What is new today?",
      },
    );

    expect(
      decodeExecutionStarted({
        status: "started",
        threadId: "thread-1",
        objective: "Fix the failing tests.",
        modelSelection: { instanceId: "codex_personal", model: "gpt-5" },
        taskRef,
        requestMetadata,
      }),
    ).toMatchObject({ taskRef, requestMetadata });
  });

  it("keeps persisted task records to qualified identity and derives a required live view", () => {
    const taskRef = {
      executionNodeId: "node-1",
      threadId: "thread-1",
    };
    const requestMetadata = { requestId: "request-1" };

    expect(() =>
      decodeTaskDeskTask({
        threadId: "thread-legacy",
        projectId: "project-1",
        title: "Legacy task",
        objective: "Keep this record readable.",
        state: "ready",
        voiceAliases: [],
      }),
    ).toThrow();
    expect(
      decodeTaskDeskTask({
        threadId: "thread-1",
        taskRef,
        projectRef: { nodeId: "node-1", projectId: "project-1" },
      }),
    ).toEqual({
      threadId: "thread-1",
      taskRef,
      projectRef: { nodeId: "node-1", projectId: "project-1" },
    });
    expect(
      decodeTaskDeskTaskView({
        threadId: "thread-1",
        taskRef,
        projectRef: { nodeId: "node-1", projectId: "project-1" },
        title: "Routed task",
        objective: "Run on the selected node.",
        state: "running",
        modelSelection: { instanceId: "codex_personal", model: "gpt-5" },
      }),
    ).toMatchObject({ taskRef, state: "running" });

    expect(
      decodeTaskCreatedActivityPayload({
        objective: "Run on the selected node.",
        taskRef,
        requestMetadata,
      }),
    ).toMatchObject({ taskRef, requestMetadata });

    expect(
      decodePresentation({
        presentationId: "presentation-1",
        projectId: "project-1",
        threadId: "thread-1",
        kind: "completed",
        threadTitle: "Routed task",
        providerName: "Codex",
        text: "Done.",
        createdAt: "2026-01-01T00:00:00.000Z",
        taskRef,
        origin: { originNodeId: "node-origin", originInteractionId: "interaction-1" },
      }),
    ).toMatchObject({ taskRef, origin: { originNodeId: "node-origin" } });
    expect(
      decodePresentation({
        presentationId: "presentation-2",
        projectId: "project-1",
        threadId: "thread-1",
        kind: "completed",
        threadTitle: "Routed task",
        providerName: "Codex",
        text: "Done.",
        createdAt: "2026-01-01T00:00:00.000Z",
        taskRef,
        origin: { originNodeId: "node-origin", originInteractionId: "interaction-1" },
        requestId: "request-1",
      }),
    ).toMatchObject({ requestId: "request-1" });
  });

  it("qualifies aliases and vocabulary entries without breaking local records", () => {
    expect(
      decodeProjectAlias({
        projectId: "project-1",
        nodeId: "node-1",
        alias: "Rivvl",
        kind: "user-defined",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toMatchObject({ nodeId: "node-1", projectId: "project-1" });

    expect(
      decodeProjectVocabularyEntry({
        nodeId: "node-1",
        projectId: "project-1",
        title: "Rivvl",
        workspaceRoot: "/workspace/rivvl",
        repositoryNames: [],
        aliases: ["Rivvl"],
        aliasDetails: [{ alias: "Rivvl", kind: "user-defined" }],
      }),
    ).toMatchObject({ nodeId: "node-1", projectId: "project-1" });

    expect(
      decodeProjectAlias({
        projectId: "project-legacy",
        alias: "Legacy",
        kind: "confirmed-pronunciation",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    ).not.toHaveProperty("nodeId");
  });

  it("keeps task clarification and focus targets node-aware", () => {
    const taskRef = {
      executionNodeId: "node-1",
      threadId: "thread-1",
    };

    expect(
      decodeTaskClarificationFrame({
        originalUtterance: "What is it doing?",
        candidates: [{ threadId: "thread-1", label: "Routed task", taskRef }],
        createdAt: "2026-01-01T00:00:00.000Z",
        expiresAt: "2026-01-01T00:05:00.000Z",
      }),
    ).toMatchObject({ candidates: [{ taskRef }] });

    expect(
      decodeFocusTaskInput({
        threadId: "thread-1",
        taskRef,
      }),
    ).toMatchObject({ taskRef });
  });

  it("pins answers to the exact pending request across turns", () => {
    expect(decodeExpectedReply({ kind: "approval", requestId: "request-1" })).toEqual({
      kind: "approval",
      requestId: "request-1",
    });
    expect(() => decodeExpectedReply({ kind: "approval" })).toThrow();

    expect(
      decodeExecuteInput({
        projectId: "project-1",
        utterance: "Allow it.",
        expectedReply: { kind: "approval", requestId: "request-1" },
      }),
    ).toMatchObject({
      kind: "control",
      expectedReply: { kind: "approval", requestId: "request-1" },
    });
    expect(decodeExecuteInput({ projectId: "project-1", utterance: "Fix it." })).not.toHaveProperty(
      "expectedReply",
    );

    expect(
      decodeNeedsInput({
        status: "needs-input",
        reason: "control-target-required",
        prompt: "That approval is still waiting. Say allow or deny.",
        choices: ["allow", "deny"],
        expectedReply: { kind: "approval", requestId: "request-1" },
      }),
    ).toMatchObject({ expectedReply: { kind: "approval", requestId: "request-1" } });

    expect(
      decodeTaskDeskTaskView({
        threadId: "thread-1",
        taskRef: {
          executionNodeId: "node-1",
          threadId: "thread-1",
        },
        projectRef: { nodeId: "node-1", projectId: "project-1" },
        title: "Routed task",
        objective: "Run on the selected node.",
        state: "waiting-for-approval",
        modelSelection: { instanceId: "codex_personal", model: "gpt-5" },
        pendingReply: { kind: "approval", requestId: "request-1" },
      }),
    ).toMatchObject({ pendingReply: { kind: "approval", requestId: "request-1" } });
  });

  it("keeps request identity attached while a project choice is pending", () => {
    expect(
      decodeProjectClarificationFrame({
        originalUtterance: "Run that in Rivvl",
        originProjectId: "project-current",
        candidates: [{ projectId: "project-rivvl", label: "Rivvl" }],
        requestMetadata: {
          requestId: "request-1",
          origin: { originInteractionId: "interaction-1" },
        },
        createdAt: "2026-01-01T00:00:00.000Z",
        expiresAt: "2026-01-01T00:05:00.000Z",
      }),
    ).toMatchObject({ requestMetadata: { requestId: "request-1" } });
  });
});

describe("Jarvis semantic proposal bridge", () => {
  it("keeps proposals to spans, roles, and answer without IDs", () => {
    const source = "Check PRs in Rivvl";
    const start = source.indexOf("in Rivvl");
    expect(
      decodeProposal({
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
      }),
    ).toMatchObject({ action: "start" });
    expect(() =>
      decodeProposal({ action: "start", refs: [], model: null, effort: null }),
    ).toThrow();
  });

  it("passes untrusted mesh evidence without pins or IDs", () => {
    expect(
      decodeInterpretInput({
        utterance: "Check PRs in Rivvl",
        projects: [{ title: "Rivvl", names: ["Rivvl", "rv"] }],
        tasks: [],
        providers: [{ name: "Codex" }],
      }),
    ).toMatchObject({ utterance: "Check PRs in Rivvl" });
    // Verbatim preserves whitespace byte-for-byte for span authority; the
    // host maps non-letter input to unsupported instead of rejecting wire.
    expect(
      decodeInterpretInput({
        utterance: "   ",
        projects: [],
        tasks: [],
        providers: [],
      }),
    ).toMatchObject({ utterance: "   " });
    expect(() =>
      decodeInterpretInput({
        utterance: "",
        projects: [],
        tasks: [],
        providers: [],
      }),
    ).toThrow();
  });

  it("carries a proposal plus verbatim source through execute without authorizing", () => {
    const source = "Check PRs in Rivvl";
    const start = source.indexOf("in Rivvl");
    expect(
      decodeExecuteInput({
        projectId: "project-1",
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
      }),
    ).toMatchObject({ sourceUtterance: source });
  });

  it("correlates accepted speech by turn without reading wording", () => {
    expect(
      decodeExecutionStarted({
        status: "started",
        threadId: "thread-1",
        objective: "Fix it.",
        modelSelection: { instanceId: "codex_personal", model: "gpt-5" },
        turnId: "turn-1",
      }),
    ).toMatchObject({ turnId: "turn-1" });
    expect(
      decodeExecutionStarted({
        status: "started",
        threadId: "thread-1",
        objective: "Fix it.",
        modelSelection: { instanceId: "codex_personal", model: "gpt-5" },
      }),
    ).not.toHaveProperty("turnId");
  });

  it("carries request identity on converse for pre-accept cancellation", () => {
    expect(
      decodeExecuteInput({
        kind: "converse",
        utterance: "What is new today?",
        requestMetadata: {
          requestId: "request-converse-1",
          origin: { originInteractionId: "interaction-1" },
        },
      }),
    ).toMatchObject({ requestMetadata: { requestId: "request-converse-1" } });
    // Legacy callers omit identity and stay untracked.
    expect(decodeExecuteInput({ kind: "converse", utterance: "What is new today?" })).toMatchObject(
      { kind: "converse" },
    );
  });
});

describe("Jarvis pre-accept request cancellation", () => {
  it("pins a cancel to the exact request identity", () => {
    expect(
      decodeCancelRequestInput({
        requestId: "request-1",
        origin: { originNodeId: "node-1", originInteractionId: "interaction-1" },
      }),
    ).toEqual({
      requestId: "request-1",
      origin: { originNodeId: "node-1", originInteractionId: "interaction-1" },
    });
    expect(() => decodeCancelRequestInput({ requestId: "   " })).toThrow();
  });

  it("keeps cancelled distinct from already-accepted with its exact task identity", () => {
    expect(decodeCancelRequestResult({ status: "cancelled", requestId: "request-1" })).toEqual({
      status: "cancelled",
      requestId: "request-1",
    });
    expect(
      decodeCancelRequestResult({
        status: "already-accepted",
        requestId: "request-1",
        threadId: "thread-1",
        taskRef: { executionNodeId: "node-1", threadId: "thread-1" },
        projectId: "project-1",
      }),
    ).toMatchObject({ status: "already-accepted", threadId: "thread-1" });
    expect(
      decodeCancelRequestResult({ status: "already-accepted", requestId: "request-1" }),
    ).toMatchObject({ status: "already-accepted" });
    expect(decodeCancelRequestResult({ status: "unknown", requestId: "request-1" })).toEqual({
      status: "unknown",
      requestId: "request-1",
    });
  });

  it("reports a pre-accept cancel through the ordinary execution result", () => {
    expect(decodeExecutionCancelled({ status: "cancelled", requestId: "request-1" })).toEqual({
      status: "cancelled",
      requestId: "request-1",
    });
    expect(decodeExecutionResult({ status: "cancelled", requestId: "request-1" })).toMatchObject({
      status: "cancelled",
    });
  });
});
