import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  appendJarvisChoice,
  applyJarvisClarificationChoice,
  buildJarvisRequestMetadata,
  desktopVoiceAllowsBrowserFallback,
  desktopVoiceCanCapture,
  desktopVoiceCanRetry,
  desktopVoiceStatusMessage,
  jarvisFullSessionTarget,
  isJarvisShortcut,
  jarvisManagementTasks,
  jarvisManagerCanSubmit,
  jarvisManagerCatalogIsReady,
  jarvisRequestFingerprint,
  jarvisErrorMessage,
  jarvisTaskStateLabel,
  jarvisTaskStartedText,
  jarvisSelectedTargetPresentation,
  jarvisTaskExecutionTarget,
  resolveJarvisRequestId,
} from "./JarvisManager.logic";

describe("Jarvis manager controls", () => {
  it("only exposes capture while native voice is operational", () => {
    expect(desktopVoiceCanCapture(null)).toBe(false);
    expect(desktopVoiceCanCapture({ status: "unavailable", native: false })).toBe(false);
    expect(desktopVoiceCanCapture({ status: "unavailable", native: true })).toBe(false);
    expect(desktopVoiceCanCapture({ status: "error", native: true })).toBe(false);
    expect(desktopVoiceCanCapture({ status: "ready", native: true })).toBe(true);
    expect(desktopVoiceCanCapture({ status: "capturing", native: true })).toBe(true);
    expect(desktopVoiceCanRetry({ status: "error", native: true })).toBe(true);
    expect(desktopVoiceCanRetry({ status: "unavailable", native: true })).toBe(false);
    expect(desktopVoiceCanRetry({ status: "error", native: false })).toBe(false);
    expect(desktopVoiceStatusMessage({ status: "unavailable", native: true })).toContain(
      "Reinstall Jarvis",
    );
    expect(desktopVoiceStatusMessage({ status: "error", native: true })).toContain("Retry");
  });

  it("never silently moves a failing native Full node to browser speech", () => {
    expect(desktopVoiceAllowsBrowserFallback({ status: "error", native: true })).toBe(false);
    expect(desktopVoiceAllowsBrowserFallback({ status: "unavailable", native: true })).toBe(false);
    expect(desktopVoiceAllowsBrowserFallback({ status: "unavailable", native: false })).toBe(true);
  });

  it("routes only after a fresh catalog is available", () => {
    expect(
      jarvisManagerCatalogIsReady({
        catalogLoaded: true,
        catalogPending: false,
        catalogError: null,
      }),
    ).toBe(true);
    expect(
      jarvisManagerCatalogIsReady({
        catalogLoaded: true,
        catalogPending: true,
        catalogError: null,
      }),
    ).toBe(false);
    expect(
      jarvisManagerCatalogIsReady({
        catalogLoaded: false,
        catalogPending: false,
        catalogError: "Could not refresh",
      }),
    ).toBe(false);
  });

  it("blocks every submit path until the catalog is ready", () => {
    expect(
      jarvisManagerCanSubmit({ catalogReady: false, instruction: "run this", submitting: false }),
    ).toBe(false);
    expect(
      jarvisManagerCanSubmit({ catalogReady: true, instruction: "run this", submitting: false }),
    ).toBe(true);
    expect(
      jarvisManagerCanSubmit({ catalogReady: true, instruction: "   ", submitting: false }),
    ).toBe(false);
  });

  it("opens only for the exact non-repeating Cmd/Ctrl+Shift+J shortcut", () => {
    expect(
      isJarvisShortcut({
        key: "J",
        metaKey: true,
        ctrlKey: false,
        shiftKey: true,
        altKey: false,
      }),
    ).toBe(true);
    expect(
      isJarvisShortcut({
        key: "j",
        metaKey: false,
        ctrlKey: true,
        shiftKey: true,
        altKey: false,
      }),
    ).toBe(true);
    expect(
      isJarvisShortcut({
        key: "j",
        metaKey: false,
        ctrlKey: true,
        shiftKey: false,
        altKey: false,
      }),
    ).toBe(false);
    expect(
      isJarvisShortcut({
        key: "j",
        metaKey: true,
        ctrlKey: false,
        shiftKey: true,
        altKey: false,
        repeat: true,
      }),
    ).toBe(false);
  });

  it("adds a clarification choice without discarding the original instruction", () => {
    expect(appendJarvisChoice("Review this change", "Codex")).toBe("Review this change\nCodex");
    expect(appendJarvisChoice("", "Codex")).toBe("Codex");
  });

  it("reuses request ids only for the same utterance and selected target", () => {
    const base = {
      utterance: "Review the current changes.",
      projectRef: { nodeId: EnvironmentId.make("desktop"), projectId: ProjectId.make("rivvl") },
      referenceThreadId: "thread-1",
    };
    const fingerprint = jarvisRequestFingerprint(base);
    const createRequestId = vi.fn(() => "request-2");

    expect(
      resolveJarvisRequestId({
        currentRequestId: "request-1",
        currentFingerprint: fingerprint,
        nextFingerprint: fingerprint,
        createRequestId,
      }),
    ).toBe("request-1");
    expect(
      resolveJarvisRequestId({
        currentRequestId: "request-1",
        currentFingerprint: fingerprint,
        nextFingerprint: jarvisRequestFingerprint({
          ...base,
          utterance: "Review the tests too.",
        }),
        createRequestId,
      }),
    ).toBe("request-2");
    expect(
      resolveJarvisRequestId({
        currentRequestId: "request-1",
        currentFingerprint: fingerprint,
        nextFingerprint: jarvisRequestFingerprint({
          ...base,
          projectRef: {
            nodeId: EnvironmentId.make("laptop"),
            projectId: ProjectId.make("rivvl"),
          },
        }),
        createRequestId,
      }),
    ).toBe("request-2");
    expect(createRequestId).toHaveBeenCalledTimes(2);
  });

  it("records the originating node when the interaction has one", () => {
    expect(
      buildJarvisRequestMetadata({
        requestId: "request-1",
        originInteractionId: "browser-1",
        originNodeId: EnvironmentId.make("laptop"),
      }),
    ).toEqual({
      requestId: "request-1",
      origin: {
        originInteractionId: "browser-1",
        originNodeId: "laptop",
      },
    });

    expect(
      buildJarvisRequestMetadata({
        requestId: "request-2",
        originInteractionId: "controller-1",
        originNodeId: null,
      }),
    ).toEqual({
      requestId: "request-2",
      origin: { originInteractionId: "controller-1" },
    });
  });

  it("keeps completed task history visible after active work", () => {
    const tasks = jarvisManagementTasks([
      {
        threadId: ThreadId.make("completed-thread"),
        projectId: ProjectId.make("rivvl"),
        title: "Completed task",
        objective: "Ship it",
        state: "ready",
        voiceAliases: [],
      },
      {
        threadId: ThreadId.make("running-thread"),
        projectId: ProjectId.make("rivvl"),
        title: "Running task",
        objective: "Test it",
        state: "running",
        voiceAliases: [],
      },
      {
        threadId: ThreadId.make("failed-thread"),
        projectId: ProjectId.make("rivvl"),
        title: "Failed task",
        objective: "Try it",
        state: "failed",
        voiceAliases: [],
      },
    ]);

    expect(tasks.map((task) => task.threadId)).toEqual([
      "running-thread",
      "completed-thread",
      "failed-thread",
    ]);
    expect(jarvisTaskStateLabel(tasks[1]!.state)).toBe("completed");
    expect(jarvisTaskStateLabel("waiting-for-input")).toBe("waiting for input");
  });

  it("opens the execution node's remote thread for routed task history", () => {
    const target = jarvisFullSessionTarget(EnvironmentId.make("controller"), {
      threadId: ThreadId.make("origin-thread"),
      projectId: ProjectId.make("rivvl"),
      title: "Remote task",
      objective: "Run remotely",
      state: "ready",
      voiceAliases: [],
      taskRef: {
        executionNodeId: EnvironmentId.make("vps"),
        remoteTaskId: "remote-task",
        remoteThreadId: ThreadId.make("vps-thread"),
      },
    });

    expect(target).toEqual({ environmentId: "vps", threadId: "vps-thread" });
  });

  it("replaces the invalid selection while preserving the objective", () => {
    expect(
      applyJarvisClarificationChoice(
        "Jarvis, use ImpossibleProvider to implement presence.",
        {
          status: "needs-input",
          reason: "provider-not-found",
          prompt: "Choose a provider.",
          choices: ["codex"],
        },
        "codex",
      ),
    ).toBe("Jarvis, use codex to implement presence.");
    expect(
      applyJarvisClarificationChoice(
        "Use Codex Unknown high to implement presence.",
        {
          status: "needs-input",
          reason: "model-unavailable",
          prompt: "Choose a model.",
          choices: ["gpt-5.6-sol"],
        },
        "gpt-5.6-sol",
      ),
    ).toBe("Use Codex gpt-5.6-sol high to implement presence.");
    expect(
      applyJarvisClarificationChoice(
        "Use Codex to implement presence.",
        {
          status: "needs-input",
          reason: "model-unavailable",
          prompt: "Choose a model.",
          choices: ["gpt-5.6-sol"],
        },
        "gpt-5.6-sol",
      ),
    ).toBe("Use Codex gpt-5.6-sol to implement presence.");
  });

  it("keeps server errors useful and provides a concise fallback", () => {
    expect(jarvisErrorMessage({ message: "Provider is unavailable." })).toBe(
      "Provider is unavailable.",
    );
    expect(jarvisErrorMessage(null)).toBe(
      "T3 couldn’t start that task. Check the connection and try again.",
    );
  });

  it("confirms the selected provider, model, and effort before hiding Companion", () => {
    expect(
      jarvisTaskStartedText({
        instanceId: "codex",
        model: "sol",
        options: [{ id: "reasoningEffort", value: "high" }],
      }),
    ).toBe("Starting codex sol at high effort.");
  });

  it("presents selected targets with friendly labels instead of internal IDs", () => {
    expect(
      jarvisSelectedTargetPresentation({
        targetTitle: "Review presence",
        projectTitle: "Jarvis",
        nodeLabel: "Laptop",
        providerLabel: "Codex",
        taskState: "running",
      }),
    ).toEqual({
      title: "Review presence",
      detail: "Jarvis · Laptop · Codex · running",
    });
    expect(
      jarvisSelectedTargetPresentation({
        projectTitle: "Jarvis",
        nodeLabel: "Laptop",
      }),
    ).toEqual({ title: "Jarvis", detail: "Jarvis · Laptop" });
  });

  it("resolves routed task metadata to the execution node", () => {
    expect(
      jarvisTaskExecutionTarget(EnvironmentId.make("controller"), {
        threadId: ThreadId.make("local-thread"),
        projectId: ProjectId.make("legacy-project"),
        taskRef: {
          executionNodeId: EnvironmentId.make("desktop"),
          remoteTaskId: "remote-task",
          remoteThreadId: ThreadId.make("remote-thread"),
          projectId: ProjectId.make("remote-project"),
          providerId: ProviderInstanceId.make("codex"),
        },
        title: "Remote task",
        objective: "Run remotely",
        state: "running",
        voiceAliases: [],
      }),
    ).toEqual({
      environmentId: EnvironmentId.make("desktop"),
      projectId: ProjectId.make("remote-project"),
    });
    expect(
      jarvisTaskExecutionTarget(EnvironmentId.make("controller"), {
        threadId: ThreadId.make("local-thread"),
        projectId: ProjectId.make("legacy-project"),
        title: "Local task",
        objective: "Run locally",
        state: "ready",
        voiceAliases: [],
      }),
    ).toEqual({
      environmentId: EnvironmentId.make("controller"),
      projectId: ProjectId.make("legacy-project"),
    });
  });
});
