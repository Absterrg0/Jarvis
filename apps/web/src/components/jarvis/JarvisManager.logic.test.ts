import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  appendJarvisChoice,
  applyJarvisClarificationChoice,
  buildJarvisRequestMetadata,
  createJarvisVoiceSubmissionQueue,
  desktopVoiceAllowsBrowserFallback,
  desktopVoiceCanCapture,
  desktopVoiceCanStartCapture,
  desktopVoiceCanRetry,
  desktopVoiceStatusMessage,
  jarvisFullSessionTarget,
  isJarvisShortcut,
  isJarvisLocalVoiceRoute,
  jarvisManagementTasks,
  jarvisManagerCanSubmit,
  jarvisManagerCatalogIsReady,
  jarvisManagerHeaderState,
  jarvisManagerNodeCapabilities,
  jarvisRequestFingerprint,
  resolveJarvisDesktopMenuAction,
  resolveJarvisVoiceProjectChoice,
  resolveJarvisVoiceDefaultTarget,
  shouldHandleJarvisShortcutInRenderer,
  shouldSubmitJarvisVoiceTranscript,
  isJarvisVoiceGarbageTranscript,
  jarvisErrorMessage,
  jarvisTaskStateLabel,
  jarvisTaskStartedText,
  jarvisExecutionSpeechText,
  jarvisSelectedTargetPresentation,
  jarvisTaskExecutionTarget,
  resolveJarvisRequestId,
} from "./JarvisManager.logic";

describe("Jarvis manager controls", () => {
  it("does not let the open desktop renderer steal the global voice shortcut", () => {
    expect(shouldHandleJarvisShortcutInRenderer(true)).toBe(false);
    expect(shouldHandleJarvisShortcutInRenderer(false)).toBe(true);
  });

  it("keeps desktop voice actions on the dedicated voice surface", () => {
    expect(resolveJarvisDesktopMenuAction("jarvis.toggle")).toBe("open-control-center");
    expect(resolveJarvisDesktopMenuAction("jarvis.voice-toggle")).toBe("voice-toggle");
    expect(resolveJarvisDesktopMenuAction("jarvis.voice-start")).toBe("voice-start");
    expect(resolveJarvisDesktopMenuAction("jarvis.voice-release")).toBe("voice-release");
    expect(resolveJarvisDesktopMenuAction("open-settings")).toBeNull();
  });

  it("never submits diagnostic microphone transcripts to task execution", () => {
    expect(shouldSubmitJarvisVoiceTranscript("command")).toBe(true);
    expect(shouldSubmitJarvisVoiceTranscript(undefined)).toBe(true);
    expect(shouldSubmitJarvisVoiceTranscript("diagnostic")).toBe(false);
    expect(isJarvisVoiceGarbageTranscript("")).toBe(true);
    expect(isJarvisVoiceGarbageTranscript("uh")).toBe(true);
    expect(isJarvisVoiceGarbageTranscript("open rivvl")).toBe(false);
    expect(isJarvisVoiceGarbageTranscript("no")).toBe(false);
    expect(isJarvisVoiceGarbageTranscript("go")).toBe(false);
    expect(isJarvisVoiceGarbageTranscript("ok")).toBe(false);
    expect(isJarvisVoiceGarbageTranscript("1")).toBe(false);
  });

  it("keeps voice captures FIFO while the first submission is unresolved", async () => {
    let releaseFirst!: () => void;
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const submitted: string[] = [];
    const queue = createJarvisVoiceSubmissionQueue({
      submit: async ({ transcript }) => {
        submitted.push(transcript);
        if (transcript === "first") await first;
      },
    });

    expect(queue.enqueue({ captureId: "capture-1", transcript: "first" })).toBe("enqueued");
    await Promise.resolve();
    expect(queue.enqueue({ captureId: "capture-2", transcript: "second" })).toBe("enqueued");
    expect(submitted).toEqual(["first"]);

    releaseFirst();
    await queue.drain();
    expect(submitted).toEqual(["first", "second"]);
  });

  it("defers captures until the catalog and target gate is ready", async () => {
    let ready = false;
    const submitted: string[] = [];
    const queue = createJarvisVoiceSubmissionQueue({
      canSubmit: () => ready,
      submit: async ({ transcript }) => {
        submitted.push(transcript);
      },
    });

    expect(queue.enqueue({ captureId: "capture-1", transcript: "queued" })).toBe("enqueued");
    expect(submitted).toEqual([]);
    ready = true;
    await queue.drain();
    expect(submitted).toEqual(["queued"]);
  });

  it("continues with the next capture when a voice submission fails", async () => {
    const submitted: string[] = [];
    const requestIds: Array<string | undefined> = [];
    const queue = createJarvisVoiceSubmissionQueue({
      submit: async ({ transcript, requestId }) => {
        submitted.push(transcript);
        requestIds.push(requestId);
        if (transcript === "first") throw new Error("offline");
      },
    });

    expect(
      queue.enqueue({ captureId: "capture-1", requestId: "request-1", transcript: "first" }),
    ).toBe("enqueued");
    expect(
      queue.enqueue({ captureId: "capture-2", requestId: "request-2", transcript: "second" }),
    ).toBe("enqueued");
    await queue.drain();
    expect(submitted).toEqual(["first", "second"]);
    expect(queue.failed()).toEqual({
      captureId: "capture-1",
      requestId: "request-1",
      transcript: "first",
    });

    await queue.retryFailed();
    expect(submitted).toEqual(["first", "second", "first"]);
    expect(requestIds).toEqual(["request-1", "request-2", "request-1"]);
  });

  it("deduplicates a finalized capture by capture id, including identical text", async () => {
    const submitted: string[] = [];
    const queue = createJarvisVoiceSubmissionQueue({
      submit: async ({ transcript }) => {
        submitted.push(transcript);
      },
    });

    expect(queue.enqueue({ captureId: "capture-1", transcript: "same" })).toBe("enqueued");
    expect(queue.enqueue({ captureId: "capture-1", transcript: "same" })).toBe("duplicate");
    await queue.drain();
    expect(submitted).toEqual(["same"]);
  });

  it("keeps the original voice request when a spoken project clarification is answered", () => {
    const project = ProjectId.make("rivvl");
    const choice = resolveJarvisVoiceProjectChoice({
      instruction: "fix the login tests",
      answer: "Rivvl",
      candidates: [
        {
          ref: { nodeId: EnvironmentId.make("laptop"), projectId: ProjectId.make("other") },
          title: "Other",
        },
        { ref: { nodeId: EnvironmentId.make("laptop"), projectId: project }, title: "Rivvl" },
      ],
    });
    expect(choice).toEqual({
      instruction: "fix the login tests",
      projectRef: { nodeId: EnvironmentId.make("laptop"), projectId: project },
    });
  });

  it("reports a full FIFO separately from a duplicate capture", () => {
    const queue = createJarvisVoiceSubmissionQueue({
      maxPending: 1,
      canSubmit: () => false,
      submit: async () => undefined,
    });
    expect(queue.enqueue({ captureId: "capture-1", transcript: "first" })).toBe("enqueued");
    expect(queue.enqueue({ captureId: "capture-2", transcript: "second" })).toBe("full");
    expect(queue.enqueue({ captureId: "capture-1", transcript: "first" })).toBe("duplicate");
  });

  it("counts retryable failures toward the bounded voice backlog", async () => {
    const queue = createJarvisVoiceSubmissionQueue({
      maxPending: 1,
      submit: async () => {
        throw new Error("offline");
      },
    });
    expect(queue.enqueue({ captureId: "capture-1", transcript: "first" })).toBe("enqueued");
    await queue.drain();
    expect(queue.size()).toBe(1);
    expect(queue.enqueue({ captureId: "capture-2", transcript: "second" })).toBe("full");
  });

  it("counts the active voice request toward the bounded backlog", async () => {
    let finish: (() => void) | undefined;
    const queue = createJarvisVoiceSubmissionQueue({
      maxPending: 1,
      submit: () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    });
    expect(queue.enqueue({ captureId: "capture-1", transcript: "first" })).toBe("enqueued");
    expect(queue.size()).toBe(1);
    expect(queue.enqueue({ captureId: "capture-2", transcript: "second" })).toBe("full");
    finish?.();
    await queue.drain();
  });

  it("allows the first capture request to boot native voice", () => {
    expect(desktopVoiceCanCapture(null)).toBe(false);
    expect(desktopVoiceCanCapture({ status: "unavailable", native: false })).toBe(false);
    expect(desktopVoiceCanCapture({ status: "unavailable", native: true })).toBe(false);
    expect(desktopVoiceCanCapture({ status: "error", native: true })).toBe(false);
    expect(desktopVoiceCanStartCapture({ status: "error", native: true })).toBe(true);
    expect(desktopVoiceCanStartCapture({ status: "unavailable", native: true })).toBe(false);
    expect(desktopVoiceCanCapture({ status: "starting", native: true })).toBe(true);
    expect(desktopVoiceCanCapture({ status: "ready", native: true })).toBe(true);
    expect(desktopVoiceCanCapture({ status: "capturing", native: true })).toBe(true);
    expect(desktopVoiceCanCapture({ status: "speaking", native: true })).toBe(true);
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

  it("defaults an unqualified voice instruction to this full node's focused task", () => {
    const laptop = EnvironmentId.make("laptop");
    const focusedThread = ThreadId.make("focused-thread");
    const focusedProject = ProjectId.make("rivvl");

    expect(
      resolveJarvisVoiceDefaultTarget({
        originNodeId: laptop,
        nodes: [
          {
            nodeId: laptop,
            reachability: "online",
            capabilities: {
              preset: "full",
              ui: true,
              parakeet: true,
              kokoro: true,
              execution: true,
              projects: true,
              providers: true,
            },
          },
          {
            nodeId: EnvironmentId.make("remote"),
            reachability: "online",
            capabilities: {
              preset: "full",
              ui: true,
              parakeet: true,
              kokoro: true,
              execution: true,
              projects: true,
              providers: true,
            },
          },
        ],
        projects: [
          { ref: { nodeId: laptop, projectId: focusedProject } },
          {
            ref: {
              nodeId: EnvironmentId.make("remote"),
              projectId: ProjectId.make("remote-project"),
            },
          },
        ],
        taskDesks: [
          {
            nodeId: laptop,
            focusedThreadId: focusedThread,
            tasks: [
              {
                threadId: focusedThread,
                projectId: focusedProject,
                title: "Focused task",
                objective: "Keep working locally",
                state: "ready",
                voiceAliases: [],
              },
            ],
          },
        ],
      }),
    ).toEqual({
      kind: "task",
      nodeId: laptop,
      task: expect.objectContaining({ threadId: focusedThread, projectId: focusedProject }),
    });
  });

  it("keeps remote execution explicit and falls back only to one local project", () => {
    const laptop = EnvironmentId.make("laptop");
    const remote = EnvironmentId.make("remote");
    const fullCapabilities = {
      preset: "full" as const,
      ui: true,
      parakeet: true,
      kokoro: true,
      execution: true,
      projects: true,
      providers: true,
    };
    const localProject = { nodeId: laptop, projectId: ProjectId.make("local-project") };

    expect(
      resolveJarvisVoiceDefaultTarget({
        originNodeId: laptop,
        nodes: [
          { nodeId: laptop, reachability: "online", capabilities: fullCapabilities },
          { nodeId: remote, reachability: "online", capabilities: fullCapabilities },
        ],
        projects: [
          { ref: localProject },
          { ref: { nodeId: remote, projectId: ProjectId.make("remote-project") } },
        ],
        taskDesks: [],
      }),
    ).toEqual({ kind: "project", projectRef: localProject });

    expect(
      resolveJarvisVoiceDefaultTarget({
        originNodeId: laptop,
        nodes: [{ nodeId: laptop, reachability: "online", capabilities: fullCapabilities }],
        projects: [
          { ref: localProject },
          { ref: { nodeId: laptop, projectId: ProjectId.make("second-local-project") } },
        ],
        taskDesks: [],
      }),
    ).toBeNull();
  });

  it("does not let the currently viewed remote route become an implicit voice target", () => {
    const laptop = EnvironmentId.make("laptop");
    expect(isJarvisLocalVoiceRoute(laptop, laptop)).toBe(true);
    expect(isJarvisLocalVoiceRoute(laptop, EnvironmentId.make("remote"))).toBe(false);
    expect(isJarvisLocalVoiceRoute(null, laptop)).toBe(false);
  });

  it("ignores stale local tasks when no task is focused", () => {
    const laptop = EnvironmentId.make("laptop");
    const projectId = ProjectId.make("local-project");
    expect(
      resolveJarvisVoiceDefaultTarget({
        originNodeId: laptop,
        nodes: [
          {
            nodeId: laptop,
            reachability: "online",
            capabilities: {
              preset: "full",
              ui: true,
              parakeet: true,
              kokoro: true,
              execution: true,
              projects: true,
              providers: true,
            },
          },
        ],
        projects: [{ ref: { nodeId: laptop, projectId } }],
        taskDesks: [
          {
            nodeId: laptop,
            focusedThreadId: null,
            tasks: [
              {
                threadId: ThreadId.make("stale-thread"),
                projectId,
                title: "Old task",
                objective: "Do not continue implicitly",
                state: "ready",
                voiceAliases: [],
              },
            ],
          },
        ],
      }),
    ).toEqual({ kind: "project", projectRef: { nodeId: laptop, projectId } });
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

  it("does not call the command surface ready before its target can execute", () => {
    expect(
      jarvisManagerHeaderState({
        catalogReady: false,
        catalogPending: true,
        catalogError: null,
        hasTarget: false,
        targetExecutionAvailable: false,
      }),
    ).toEqual({ kind: "loading", label: "Loading capabilities" });
    expect(
      jarvisManagerHeaderState({
        catalogReady: false,
        catalogPending: false,
        catalogError: "Node unavailable",
        hasTarget: false,
        targetExecutionAvailable: false,
      }),
    ).toEqual({ kind: "unavailable", label: "Capabilities unavailable" });
    expect(
      jarvisManagerHeaderState({
        catalogReady: true,
        catalogPending: false,
        catalogError: null,
        hasTarget: false,
        targetExecutionAvailable: false,
      }),
    ).toEqual({ kind: "target-required", label: "Choose a project" });
    expect(
      jarvisManagerHeaderState({
        catalogReady: true,
        catalogPending: false,
        catalogError: null,
        hasTarget: true,
        targetExecutionAvailable: false,
      }),
    ).toEqual({ kind: "execution-unavailable", label: "Execution unavailable" });
    expect(
      jarvisManagerHeaderState({
        catalogReady: true,
        catalogPending: false,
        catalogError: null,
        hasTarget: true,
        targetExecutionAvailable: true,
      }),
    ).toEqual({ kind: "ready", label: "Ready to run" });
  });

  it("keeps capability status unknown when a node catalog failed", () => {
    expect(jarvisManagerNodeCapabilities({})).toBeNull();
    expect(
      jarvisManagerNodeCapabilities({
        catalogError: "Catalog unavailable",
      }),
    ).toBeNull();
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
      "Jarvis couldn’t start that task. Check the connection and try again.",
    );
  });

  it("does not duplicate the immediate acknowledgement after Host acceptance", () => {
    expect(
      jarvisTaskStartedText({
        instanceId: "codex",
        model: "sol",
        options: [{ id: "reasoningEffort", value: "high" }],
      }),
    ).toBe("Starting codex sol at high effort.");
    expect(
      jarvisExecutionSpeechText({
        status: "started",
        threadId: ThreadId.make("thread-1"),
        objective: "Implement voice routing",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "sol" },
      }),
    ).toBe("");
  });

  it("speaks clarification and acknowledgement responses on every Jarvis surface", () => {
    expect(
      jarvisExecutionSpeechText({
        status: "needs-input",
        reason: "objective-missing",
        prompt: "Which project should I use?",
        choices: ["Jarvis", "rivvl"],
      }),
    ).toBe("Which project should I use?");
    expect(
      jarvisExecutionSpeechText({
        status: "acknowledged",
        action: "focused",
        projectId: ProjectId.make("jarvis"),
        message: "Focused Jarvis.",
      }),
    ).toBe("Focused Jarvis.");
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
