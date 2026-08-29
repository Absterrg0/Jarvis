import type { JarvisMeshProject } from "@t3tools/jarvis-client-runtime/jarvis/mesh";
import { groundVoiceTurn } from "@t3tools/jarvis-core/groundVoiceTurn";

export type JarvisNativeCapturePhase = "idle" | "starting" | "capturing";

export interface JarvisNativeCaptureBridge {
  readonly startCapture: (input?: {
    readonly purpose?: "command" | "diagnostic";
    readonly captureId?: string;
  }) => Promise<{ readonly accepted: boolean }>;
  readonly releaseCapture: () => Promise<{ readonly accepted: boolean }>;
  readonly cancelCapture: () => Promise<{ readonly accepted: boolean }>;
}

export function jarvisRecognitionContextPhrases(input: {
  readonly projects: ReadonlyArray<{
    readonly title: string;
    readonly repositoryNames: ReadonlyArray<string>;
    readonly aliases?: ReadonlyArray<string>;
  }>;
  readonly providers: ReadonlyArray<{
    readonly snapshot: {
      readonly instanceId: string;
      readonly displayName?: string | undefined;
      readonly models: ReadonlyArray<{
        readonly slug: string;
        readonly name: string;
        readonly shortName?: string | undefined;
      }>;
    };
  }>;
}): ReadonlyArray<string> {
  return [
    ...new Set([
      ...input.projects.flatMap((project) => [
        project.title,
        ...project.repositoryNames,
        ...(project.aliases ?? []),
      ]),
      ...input.providers.flatMap(({ snapshot }) => [
        snapshot.displayName ?? snapshot.instanceId,
        ...snapshot.models.flatMap((model) => [model.shortName ?? model.name, model.slug]),
      ]),
    ]),
  ].filter((phrase) => phrase.trim().length > 0);
}

export type JarvisVoiceProjectMention = {
  readonly project: JarvisMeshProject;
  readonly confidence: "exact" | "near" | "phonetic";
  readonly heard: string;
  readonly transcript: string;
};

export type JarvisVoiceProjectGrounding =
  | { readonly status: "not-mentioned" }
  | { readonly status: "resolved"; readonly mention: JarvisVoiceProjectMention }
  | {
      readonly status: "needs-confirmation";
      readonly project: JarvisMeshProject;
      readonly heard: string;
      readonly prompt: string;
    }
  | {
      readonly status: "needs-clarification";
      readonly heard: string;
      readonly prompt: string;
      readonly candidates: ReadonlyArray<{
        readonly project: JarvisMeshProject;
        readonly label: string;
      }>;
    };

const projectCandidate = (project: JarvisMeshProject) => ({
  id: `${project.ref.nodeId}:${project.ref.projectId}`,
  title: project.title,
  label: `${project.title} — ${project.nodeLabel}`,
  names: [project.title, ...project.repositoryNames, ...project.aliases],
  project,
});

export function groundJarvisVoiceProjectMention(input: {
  readonly transcript: string;
  readonly projects: ReadonlyArray<JarvisMeshProject>;
}): JarvisVoiceProjectGrounding {
  const candidates = input.projects.map(projectCandidate);
  const grounded = groundVoiceTurn({ utterance: input.transcript, candidates });
  if (grounded.status === "not-mentioned") return { status: "not-mentioned" };
  if (grounded.status === "needs-clarification") {
    return {
      status: "needs-clarification",
      heard: grounded.heard,
      prompt: grounded.prompt,
      candidates: grounded.candidates,
    };
  }
  if (grounded.status === "resolved") {
    return {
      status: "resolved",
      mention: {
        project: grounded.project,
        confidence: grounded.match === "near" ? "near" : "exact",
        heard: grounded.heard.toLocaleLowerCase("en-US"),
        transcript: grounded.utterance,
      },
    };
  }
  return {
    status: "needs-confirmation",
    project: grounded.project,
    heard: grounded.heard,
    prompt: grounded.prompt,
  };
}

export type JarvisDesktopVoiceAction = "voice-toggle" | "voice-start" | "voice-release";

export function createJarvisNativeCaptureController(input: {
  readonly voice: JarvisNativeCaptureBridge;
  readonly onPhase: (phase: JarvisNativeCapturePhase) => void;
  readonly onStartFailure: () => void;
  readonly onReleaseFailure: () => void;
}): {
  readonly phase: () => JarvisNativeCapturePhase;
  readonly start: () => void;
  readonly release: () => void;
  readonly cancel: () => void;
  readonly markIdle: () => void;
  readonly markWorkerReady: () => void;
} {
  let phase: JarvisNativeCapturePhase = "idle";
  let finalizing = false;
  let pendingHold = false;
  let generation = 0;
  const cancellationSentFor = new Set<number>();
  const startingReleases = new Map<
    number,
    {
      startSettled: boolean;
      startAccepted: boolean;
      releaseSettled: boolean;
      releaseAccepted: boolean;
      cancelIssued: boolean;
    }
  >();

  const setPhase = (next: JarvisNativeCapturePhase): void => {
    phase = next;
    input.onPhase(next);
  };

  const release = (): void => {
    if (phase === "starting") {
      const requestGeneration = generation;
      generation += 1;
      finalizing = true;
      setPhase("idle");
      const request = {
        startSettled: false,
        startAccepted: false,
        releaseSettled: false,
        releaseAccepted: false,
        cancelIssued: false,
      };
      startingReleases.set(requestGeneration, request);
      const cancelLateStart = (): void => {
        if (request.cancelIssued) return;
        request.cancelIssued = true;
        void input.voice.cancelCapture().catch(() => undefined);
      };
      void input.voice.releaseCapture().then(
        (result) => {
          request.releaseSettled = true;
          request.releaseAccepted = result.accepted;
          if (!result.accepted) {
            finalizing = false;
            pendingHold = false;
            input.onReleaseFailure();
            if (request.startSettled && request.startAccepted) cancelLateStart();
          }
          if (request.startSettled) startingReleases.delete(requestGeneration);
        },
        () => {
          request.releaseSettled = true;
          finalizing = false;
          pendingHold = false;
          input.onReleaseFailure();
          if (request.startSettled && request.startAccepted) cancelLateStart();
          if (request.startSettled) startingReleases.delete(requestGeneration);
        },
      );
      return;
    }
    if (phase !== "capturing") {
      if (finalizing) pendingHold = false;
      return;
    }
    finalizing = true;
    setPhase("idle");
    void input.voice.releaseCapture().then(
      (result) => {
        if (!result.accepted) {
          finalizing = false;
          pendingHold = false;
          input.onReleaseFailure();
        }
      },
      () => {
        finalizing = false;
        pendingHold = false;
        input.onReleaseFailure();
      },
    );
  };

  const start = (): void => {
    if (phase !== "idle") return;
    if (finalizing) {
      pendingHold = true;
      return;
    }
    setPhase("starting");
    const requestGeneration = ++generation;
    void input.voice.startCapture({ purpose: "command" }).then(
      (result) => {
        if (requestGeneration !== generation) {
          const releaseRequest = startingReleases.get(requestGeneration);
          if (releaseRequest !== undefined) {
            releaseRequest.startSettled = true;
            releaseRequest.startAccepted = result.accepted;
            if (!result.accepted) input.onStartFailure();
            if (
              result.accepted &&
              releaseRequest.releaseSettled &&
              !releaseRequest.releaseAccepted &&
              !releaseRequest.cancelIssued
            ) {
              releaseRequest.cancelIssued = true;
              void input.voice.cancelCapture().catch(() => undefined);
            }
            if (!result.accepted || releaseRequest.releaseSettled) {
              startingReleases.delete(requestGeneration);
            }
            return;
          }
          const cancellationAlreadySent = cancellationSentFor.delete(requestGeneration);
          if (result.accepted && !cancellationAlreadySent) {
            void input.voice.cancelCapture().catch(() => undefined);
          }
          return;
        }
        if (!result.accepted) {
          setPhase("idle");
          input.onStartFailure();
          return;
        }
        setPhase("capturing");
      },
      () => {
        if (requestGeneration !== generation) {
          const releaseRequest = startingReleases.get(requestGeneration);
          if (releaseRequest !== undefined) {
            releaseRequest.startSettled = true;
            startingReleases.delete(requestGeneration);
            return;
          }
          cancellationSentFor.delete(requestGeneration);
          return;
        }
        setPhase("idle");
        input.onStartFailure();
      },
    );
  };

  const cancel = (): void => {
    const wasActive = phase !== "idle" || finalizing || pendingHold;
    const wasStarting = phase === "starting";
    const cancelledGeneration = generation;
    generation += 1;
    finalizing = false;
    pendingHold = false;
    setPhase("idle");
    if (wasActive) {
      // A starting request may resolve after this cancellation and needs one
      // correlated cleanup. Once the worker has accepted the start, there is
      // no late start callback to guard and retaining the generation would
      // only grow this set for the lifetime of the controller.
      if (wasStarting) cancellationSentFor.add(cancelledGeneration);
      void input.voice.cancelCapture().catch(() => undefined);
    }
  };

  return {
    phase: () => phase,
    start,
    release,
    cancel,
    markIdle: () => {
      generation += 1;
      finalizing = false;
      pendingHold = false;
      setPhase("idle");
    },
    markWorkerReady: () => {
      if (phase === "starting") return;
      if (finalizing) {
        finalizing = false;
        const shouldStart = pendingHold;
        pendingHold = false;
        if (shouldStart) {
          start();
          return;
        }
      }
      generation += 1;
      setPhase("idle");
    },
  };
}

/**
 * Owns the three desktop shortcut actions for one renderer lifetime. Keeping
 * the start/release phase here makes a fast key release deterministic even
 * when the native worker is still starting.
 */
export function createJarvisDesktopVoiceActionController(input: {
  readonly voice: JarvisNativeCaptureBridge;
  readonly onStartFailure: () => void;
  readonly onReleaseFailure: () => void;
}): {
  readonly handle: (action: JarvisDesktopVoiceAction) => void;
  readonly syncWorkerState: (status: "ready" | "capturing" | "error" | "unavailable") => void;
  readonly dispose: () => void;
} {
  const capture = createJarvisNativeCaptureController({
    ...input,
    onPhase: () => undefined,
  });

  return {
    handle: (action) => {
      if (action === "voice-toggle") {
        if (capture.phase() === "idle") capture.start();
        else capture.release();
        return;
      }
      if (action === "voice-start") capture.start();
      else capture.release();
    },
    syncWorkerState: (status) => {
      if (status === "ready") capture.markWorkerReady();
      if (status === "error" || status === "unavailable") capture.markIdle();
    },
    dispose: capture.cancel,
  };
}
