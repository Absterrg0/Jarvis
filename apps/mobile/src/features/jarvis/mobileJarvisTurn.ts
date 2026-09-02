import type { EnvironmentId, JarvisProjectRef, JarvisTaskRef } from "@t3tools/contracts";

type MobileJarvisDraftBase = {
  readonly originInteractionId: string;
};

/** A mobile instruction before Jarvis grounds its execution project. */
export type MobileJarvisDraft = MobileJarvisDraftBase &
  (
    | {
        readonly voiceNodeId?: undefined;
        readonly inputMode: "text";
        readonly speechEnabled: false;
      }
    | {
        readonly voiceNodeId: EnvironmentId;
        readonly inputMode: "voice";
        readonly speechEnabled: true;
      }
  );

/** Ephemeral routed context for one mobile-origin interaction. T3 owns durable task state. */
export type MobileJarvisTurn = MobileJarvisDraft & {
  readonly projectRef: JarvisProjectRef;
  readonly taskRef?: JarvisTaskRef;
};

export function createMobileJarvisTurn(input: {
  readonly originInteractionId: string;
  readonly inputMode: "text";
}): MobileJarvisDraft {
  return { ...input, speechEnabled: false };
}

export function createMobileJarvisVoiceTurn(input: {
  readonly originInteractionId: string;
  readonly voiceNodeId: EnvironmentId;
}): MobileJarvisDraft {
  return { ...input, inputMode: "voice", speechEnabled: true };
}

export function routeMobileJarvisTurn(
  draft: MobileJarvisDraft,
  projectRef: JarvisProjectRef,
): MobileJarvisTurn {
  return { ...draft, projectRef };
}

export function attachMobileJarvisTask(
  turn: MobileJarvisTurn,
  taskRef: JarvisTaskRef | undefined,
): MobileJarvisTurn {
  return taskRef === undefined ? turn : { ...turn, taskRef };
}
