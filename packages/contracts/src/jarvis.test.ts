import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  JarvisExecuteInput,
  JarvisExecutionStarted,
  JarvisNodeId,
  JarvisOriginMetadata,
  JarvisProjectAlias,
  JarvisProjectClarificationFrame,
  JarvisProjectVocabularyEntry,
  JarvisProjectRef,
  JarvisRequestMetadata,
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

const decodeNodeId = Schema.decodeUnknownSync(JarvisNodeId);
const decodeProjectRef = Schema.decodeUnknownSync(JarvisProjectRef);
const decodeTaskRef = Schema.decodeUnknownSync(JarvisTaskRef);
const decodeOriginMetadata = Schema.decodeUnknownSync(JarvisOriginMetadata);
const decodeRequestMetadata = Schema.decodeUnknownSync(JarvisRequestMetadata);
const decodeExecuteInput = Schema.decodeUnknownSync(JarvisExecuteInput);
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
      projectRef: { nodeId: "node-1", projectId: "project-1" },
      requestMetadata,
    });

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
