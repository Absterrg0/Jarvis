import type { EnvironmentId, JarvisProjectRef, JarvisTaskRef } from "@t3tools/contracts";

type MobileJarvisTurnBase = {
  readonly originInteractionId: string;
  readonly projectRef: JarvisProjectRef;
  readonly taskRef?: JarvisTaskRef;
};

/** Ephemeral routing context for one mobile-origin interaction. T3 owns durable task state. */
export type MobileJarvisTurn = MobileJarvisTurnBase &
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

export function createMobileJarvisTurn(input: {
  readonly originInteractionId: string;
  readonly projectRef: JarvisProjectRef;
  readonly inputMode: "text";
}): MobileJarvisTurn {
  return { ...input, speechEnabled: false };
}

export function createMobileJarvisVoiceTurn(input: {
  readonly originInteractionId: string;
  readonly projectRef: JarvisProjectRef;
  readonly voiceNodeId: EnvironmentId;
}): MobileJarvisTurn {
  return { ...input, inputMode: "voice", speechEnabled: true };
}

export function attachMobileJarvisTask(
  turn: MobileJarvisTurn,
  taskRef: JarvisTaskRef | undefined,
): MobileJarvisTurn {
  return taskRef === undefined ? turn : { ...turn, taskRef };
}
