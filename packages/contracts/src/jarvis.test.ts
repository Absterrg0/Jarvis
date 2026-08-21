import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { EnvironmentJarvisExecuteInput } from "./environmentHttp.ts";
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
  JarvisTaskDeskNavigation,
  JarvisTaskRef,
  JarvisVoiceReport,
} from "./jarvis.ts";

const decodeNodeId = Schema.decodeUnknownSync(JarvisNodeId);
const decodeProjectRef = Schema.decodeUnknownSync(JarvisProjectRef);
const decodeTaskRef = Schema.decodeUnknownSync(JarvisTaskRef);
const decodeOriginMetadata = Schema.decodeUnknownSync(JarvisOriginMetadata);
const decodeRequestMetadata = Schema.decodeUnknownSync(JarvisRequestMetadata);
const decodeExecuteInput = Schema.decodeUnknownSync(JarvisExecuteInput);
const decodeExecutionStarted = Schema.decodeUnknownSync(JarvisExecutionStarted);
const decodeTaskDeskTask = Schema.decodeUnknownSync(JarvisTaskDeskTask);
const decodeTaskClarificationFrame = Schema.decodeUnknownSync(JarvisTaskClarificationFrame);
const decodeProjectClarificationFrame = Schema.decodeUnknownSync(JarvisProjectClarificationFrame);
const decodeTaskDeskNavigation = Schema.decodeUnknownSync(JarvisTaskDeskNavigation);
const decodeTaskCreatedActivityPayload = Schema.decodeUnknownSync(JarvisTaskCreatedActivityPayload);
const decodeVoiceReport = Schema.decodeUnknownSync(JarvisVoiceReport);
const decodeProjectAlias = Schema.decodeUnknownSync(JarvisProjectAlias);
const decodeProjectVocabularyEntry = Schema.decodeUnknownSync(JarvisProjectVocabularyEntry);
const decodeEnvironmentExecuteInput = Schema.decodeUnknownSync(EnvironmentJarvisExecuteInput);

describe("Jarvis node-qualified references", () => {
  it("uses the stable environment identity for a project reference", () => {
    expect(decodeNodeId(" node-1 ")).toBe("node-1");
    expect(decodeProjectRef({ nodeId: "node-1", projectId: "project-1" })).toEqual({
      nodeId: "node-1",
      projectId: "project-1",
    });
  });

  it("decodes a task reference with optional remote details", () => {
    expect(
      decodeTaskRef({
        executionNodeId: "node-1",
        remoteTaskId: "task-1",
        remoteThreadId: "thread-1",
        projectId: "project-1",
        providerId: "codex_personal",
      }),
    ).toEqual({
      executionNodeId: "node-1",
      remoteTaskId: "task-1",
      remoteThreadId: "thread-1",
      projectId: "project-1",
      providerId: "codex_personal",
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
      remoteTaskId: "task-1",
      remoteThreadId: "thread-1",
      projectId: "project-1",
      providerId: "codex_personal",
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

  it("keeps legacy task desk and report records decodable while qualifying routed work", () => {
    const taskRef = {
      executionNodeId: "node-1",
      remoteTaskId: "task-1",
      remoteThreadId: "thread-1",
      projectId: "project-1",
      providerId: "codex_personal",
    };
    const requestMetadata = { requestId: "request-1" };

    expect(
      decodeTaskDeskTask({
        threadId: "thread-legacy",
        projectId: "project-1",
        title: "Legacy task",
        objective: "Keep this record readable.",
        state: "ready",
        voiceAliases: [],
      }),
    ).not.toHaveProperty("taskRef");
    expect(
      decodeTaskDeskTask({
        threadId: "thread-1",
        projectId: "project-1",
        title: "Routed task",
        objective: "Run on the selected node.",
        state: "running",
        voiceAliases: [],
        taskRef,
      }),
    ).toMatchObject({ taskRef });

    expect(
      decodeTaskCreatedActivityPayload({
        objective: "Run on the selected node.",
        taskRef,
        requestMetadata,
      }),
    ).toMatchObject({ taskRef, requestMetadata });

    expect(
      decodeVoiceReport({
        reportId: "report-1",
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

  it("allows the HTTP execution boundary to carry a qualified target and request metadata", () => {
    expect(
      decodeEnvironmentExecuteInput({
        projectRef: { nodeId: "node-1", projectId: "project-1" },
        requestMetadata: { requestId: "request-1" },
        utterance: "Run the tests.",
      }),
    ).toMatchObject({
      projectRef: { nodeId: "node-1", projectId: "project-1" },
      requestMetadata: { requestId: "request-1" },
    });
  });

  it("keeps task clarification and focus targets node-aware", () => {
    const taskRef = {
      executionNodeId: "node-1",
      remoteTaskId: "task-1",
      remoteThreadId: "thread-1",
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
      decodeTaskDeskNavigation({
        action: "focus",
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
