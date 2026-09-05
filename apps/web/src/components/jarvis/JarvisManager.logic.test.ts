import {
  EnvironmentId,
  JarvisTaskDeskTaskView,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  jarvisNodeCapabilitiesForPreset,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { groundJarvisVoiceProjectMention } from "./JarvisNativeCapture";
import {
  appendJarvisChoice,
  applyJarvisClarificationChoice,
  buildJarvisRequestMetadata,
  createJarvisVoiceSubmissionQueue,
  isJarvisVoiceClarificationDiscard,
  desktopVoiceAllowsBrowserFallback,
  isJarvisShortcut,
  isJarvisLocalVoiceRoute,
  jarvisManagerCatalogIsReady,
  resolveJarvisDesktopMenuAction,
  resolveJarvisVoiceProjectChoice,
  resolveJarvisVoiceDefaultTarget,
  resolveJarvisVoiceMentionTarget,
  shouldHandleJarvisShortcutInRenderer,
  shouldSubmitJarvisVoiceTranscript,
  isJarvisVoiceGarbageTranscript,
  jarvisErrorMessage,
  jarvisExecutionFeedback,
} from "./JarvisManager.logic";

describe("Jarvis manager controls", () => {
  const taskView = (input: {
    readonly threadId: ThreadId;
    readonly projectId: ProjectId;
    readonly title: string;
    readonly objective: string;
    readonly state: JarvisTaskDeskTaskView["state"];
    readonly taskRef?: Partial<JarvisTaskDeskTaskView["taskRef"]>;
  }): JarvisTaskDeskTaskView => ({
    threadId: input.threadId,
    projectRef: {
      nodeId: input.taskRef?.executionNodeId ?? EnvironmentId.make("laptop"),
      projectId: input.projectId,
    },
    taskRef: {
      executionNodeId: input.taskRef?.executionNodeId ?? EnvironmentId.make("laptop"),
      threadId: input.taskRef?.threadId ?? input.threadId,
    },
    title: input.title,
    objective: input.objective,
    state: input.state,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "sol" },
  });

  it("recognizes explicit clarification discards without swallowing new instructions", () => {
    for (const reply of [
      "no",
      "No, thanks.",
      "cancel that",
      "discard it",
      "never mind",
      "forget it",
    ]) {
      expect(isJarvisVoiceClarificationDiscard(reply)).toBe(true);
    }
    expect(isJarvisVoiceClarificationDiscard("no, use the second project")).toBe(false);
    expect(isJarvisVoiceClarificationDiscard("stop the running task")).toBe(false);
  });

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

  it("grounds a capture against the fresh catalog at dequeue time", async () => {
    const nodeId = EnvironmentId.make("laptop");
    const projectId = ProjectId.make("rivvl");
    let ready = false;
    let projects: Parameters<typeof groundJarvisVoiceProjectMention>[0]["projects"] = [];
    const results: Array<ReturnType<typeof groundJarvisVoiceProjectMention>> = [];
    const queue = createJarvisVoiceSubmissionQueue({
      canSubmit: () => ready,
      submit: async ({ transcript }) => {
        results.push(groundJarvisVoiceProjectMention({ transcript, projects }));
      },
    });

    queue.enqueue({ captureId: "capture-before-catalog", transcript: "check out Zivil" });
    projects = [
      {
        projectId,
        ref: { nodeId, projectId },
        nodeLabel: "Laptop",
        title: "Rivvl",
        workspaceRoot: "/work/rivvl",
        repositoryNames: [],
        aliases: [],
        aliasDetails: [],
      },
    ];
    ready = true;
    await queue.drain();

    expect(results).toMatchObject([
      {
        status: "needs-confirmation",
        project: { title: "Rivvl" },
        heard: "Zivil",
      },
    ]);
  });

  it("keeps an unresolved capture at the head of the FIFO until it is resumed", async () => {
    let clarified = false;
    const submitted: string[] = [];
    const queue = createJarvisVoiceSubmissionQueue({
      canSubmit: () => !clarified,
      submit: async ({ transcript }) => {
        submitted.push(transcript);
        if (transcript === "check out Zivil") {
          clarified = true;
          return "pause";
        }
      },
    });

    expect(queue.enqueue({ captureId: "capture-1", transcript: "check out Zivil" })).toBe(
      "enqueued",
    );
    expect(queue.enqueue({ captureId: "capture-2", transcript: "later request" })).toBe("enqueued");
    await queue.drain();
    expect(submitted).toEqual(["check out Zivil"]);
    expect(queue.size()).toBe(2);

    clarified = false;
    expect(
      queue.resume("capture-1", {
        captureId: "capture-1",
        transcript: "check out Rivvl",
      }),
    ).toBe("resumed");
    await queue.drain();
    expect(submitted).toEqual(["check out Zivil", "check out Rivvl", "later request"]);
    expect(queue.size()).toBe(0);
  });

  it("can discard a declined clarification without stranding later captures", async () => {
    let paused = true;
    const submitted: string[] = [];
    const queue = createJarvisVoiceSubmissionQueue({
      canSubmit: () => !paused,
      submit: async ({ transcript }) => {
        submitted.push(transcript);
        if (transcript === "uncertain") {
          paused = true;
          return "pause";
        }
      },
    });
    paused = false;
    queue.enqueue({ captureId: "capture-1", transcript: "uncertain" });
    queue.enqueue({ captureId: "capture-2", transcript: "next" });
    await queue.drain();

    paused = false;
    expect(queue.discard("capture-1")).toBe(true);
    await queue.drain();
    expect(submitted).toEqual(["uncertain", "next"]);
  });

  it("rejects a reply that does not belong to the paused FIFO item", async () => {
    const queue = createJarvisVoiceSubmissionQueue({
      submit: async () => "pause",
    });
    queue.enqueue({ captureId: "capture-1", transcript: "uncertain" });
    await queue.drain();

    expect(
      queue.resume("different-capture", {
        captureId: "different-capture",
        transcript: "yes",
      }),
    ).toBe("missing");
    expect(queue.size()).toBe(1);
    expect(queue.discard("capture-1")).toBe(true);
  });

  it("clears safely while a submission is still resolving", async () => {
    let finish: (() => void) | undefined;
    const queue = createJarvisVoiceSubmissionQueue({
      submit: () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    });
    queue.enqueue({ captureId: "capture-1", transcript: "in flight" });
    queue.clear();
    finish?.();
    await queue.drain();
    expect(queue.size()).toBe(0);
    expect(queue.resume("capture-1", { captureId: "capture-1", transcript: "stale" })).toBe(
      "missing",
    );
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

  it("accepts an affirmation only for a single-candidate confirmation", () => {
    const candidate = {
      ref: { nodeId: EnvironmentId.make("laptop"), projectId: ProjectId.make("rivvl") },
      title: "Rivvl",
    };
    expect(
      resolveJarvisVoiceProjectChoice({
        instruction: "check the authentication in Rebel",
        answer: "yes",
        candidates: [candidate],
        acceptsAffirmation: true,
      }),
    ).toEqual({
      instruction: "check the authentication in Rebel",
      projectRef: candidate.ref,
    });
    expect(
      resolveJarvisVoiceProjectChoice({
        instruction: "check the authentication in Rebel",
        answer: "yes",
        candidates: [
          candidate,
          {
            ref: { nodeId: EnvironmentId.make("laptop"), projectId: ProjectId.make("other") },
            title: "Other",
          },
        ],
        acceptsAffirmation: true,
      }),
    ).toBeNull();
    expect(
      resolveJarvisVoiceProjectChoice({
        instruction: "check the authentication in Rebel",
        answer: "yes",
        candidates: [candidate],
        acceptsAffirmation: false,
      }),
    ).toBeNull();
  });

  it("keeps the active task when a spoken follow-up names its project", () => {
    const laptop = EnvironmentId.make("laptop");
    const alertify = ProjectId.make("alertify");
    const activeTask = {
      projectRef: { nodeId: laptop, projectId: alertify },
      projectTitle: "Alertify",
      contextThreadId: ThreadId.make("alertify-task"),
      contextThreadTitle: "Explore Alertify",
      referenceThreadId: ThreadId.make("alertify-provider-thread"),
    };

    expect(
      resolveJarvisVoiceMentionTarget({
        projectRef: { nodeId: laptop, projectId: alertify },
        projectTitle: "Alertify",
        currentTarget: activeTask,
      }),
    ).toEqual(activeTask);

    expect(
      resolveJarvisVoiceMentionTarget({
        projectRef: { nodeId: laptop, projectId: ProjectId.make("jarvis") },
        projectTitle: "Jarvis",
        currentTarget: activeTask,
      }),
    ).toEqual({
      projectRef: { nodeId: laptop, projectId: ProjectId.make("jarvis") },
      projectTitle: "Jarvis",
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
            capabilities: jarvisNodeCapabilitiesForPreset("full"),
          },
          {
            nodeId: EnvironmentId.make("remote"),
            reachability: "online",
            capabilities: jarvisNodeCapabilitiesForPreset("full"),
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
              taskView({
                threadId: focusedThread,
                projectId: focusedProject,
                title: "Focused task",
                objective: "Keep working locally",
                state: "ready",
              }),
            ],
          },
        ],
      }),
    ).toEqual({
      kind: "task",
      nodeId: laptop,
      task: expect.objectContaining({
        threadId: focusedThread,
        projectRef: { nodeId: laptop, projectId: focusedProject },
      }),
    });
  });

  it("keeps remote execution explicit and falls back only to one local project", () => {
    const laptop = EnvironmentId.make("laptop");
    const remote = EnvironmentId.make("remote");
    const fullCapabilities = jarvisNodeCapabilitiesForPreset("full");
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
            capabilities: jarvisNodeCapabilitiesForPreset("full"),
          },
        ],
        projects: [{ ref: { nodeId: laptop, projectId } }],
        taskDesks: [
          {
            nodeId: laptop,
            focusedThreadId: null,
            tasks: [
              taskView({
                threadId: ThreadId.make("stale-thread"),
                projectId,
                title: "Old task",
                objective: "Do not continue implicitly",
                state: "ready",
              }),
            ],
          },
        ],
      }),
    ).toEqual({ kind: "project", projectRef: { nodeId: laptop, projectId } });
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

  it("keeps raw speech separate from the canonical provider objective", () => {
    expect(
      buildJarvisRequestMetadata({
        requestId: "request-voice",
        originInteractionId: "desktop-1",
        originNodeId: EnvironmentId.make("laptop"),
        inputMode: "voice",
        sourceUtterance: "Can you please check out Alertifi?",
      }),
    ).toMatchObject({
      requestId: "request-voice",
      inputMode: "voice",
      sourceUtterance: "Can you please check out Alertifi?",
    });
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

  it("sends only the spoken answer for a durable project confirmation", () => {
    expect(
      applyJarvisClarificationChoice(
        "Can you please check out Alertify?",
        {
          status: "needs-input",
          reason: "control-target-required",
          prompt: "Did you mean Alertify? Say yes or no.",
          choices: ["Alertify"],
        },
        "yes",
      ),
    ).toBe("yes");
  });

  it("keeps server errors useful and provides a concise fallback", () => {
    expect(jarvisErrorMessage({ message: "Provider is unavailable." })).toBe(
      "Provider is unavailable.",
    );
    expect(jarvisErrorMessage(null)).toBe(
      "Jarvis couldn’t start that task. Check the connection and try again.",
    );
  });

  it("keeps task feedback authoritative and specific to the accepted objective", () => {
    expect(
      jarvisExecutionFeedback({
        status: "started",
        threadId: ThreadId.make("thread-1"),
        objective: "Implement voice routing",
        acknowledgement: "Taking a look at voice routing.",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "sol" },
      }),
    ).toEqual({
      cue: false,
      speech: "Taking a look at voice routing.",
      visual: {
        state: "Working on it",
        detail: "Implement voice routing",
        kind: "started",
      },
    });
  });

  it("speaks clarification and acknowledgement responses on every Jarvis surface", () => {
    expect(
      jarvisExecutionFeedback({
        status: "needs-input",
        reason: "objective-missing",
        prompt: "Which project should I use?",
        choices: ["Jarvis", "rivvl"],
      }),
    ).toMatchObject({ speech: "Which project should I use?" });
    expect(
      jarvisExecutionFeedback({
        status: "acknowledged",
        action: "focused",
        projectId: ProjectId.make("jarvis"),
        message: "Focused Jarvis.",
      }),
    ).toMatchObject({ speech: "Focused Jarvis." });
  });
});
