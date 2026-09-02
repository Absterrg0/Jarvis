import type { EnvironmentId } from "@t3tools/contracts";

export interface VoiceNodeCandidate {
  readonly nodeId: EnvironmentId;
  readonly label: string;
  readonly reachability: "online" | "offline";
  /** Kept separate from the node contract so old descriptors remain readable. */
  readonly voiceCompute: boolean;
}

export type VoiceNodeSelection =
  | {
      readonly status: "selected";
      readonly node: VoiceNodeCandidate;
    }
  | {
      readonly status: "no-voice-node";
    };

/** Keep speech compute invisible: prefer the remembered node, then use an online fallback. */
export function selectVoiceNode(input: {
  readonly preferredVoiceNodeId: EnvironmentId | null | undefined;
  readonly nodes: ReadonlyArray<VoiceNodeCandidate>;
}): VoiceNodeSelection {
  const candidates = input.nodes.filter(
    (node) => node.voiceCompute && node.reachability === "online",
  );
  const preferredId = input.preferredVoiceNodeId ?? null;
  if (candidates.length === 0) return { status: "no-voice-node" };

  const preferred =
    preferredId === null ? undefined : candidates.find((node) => node.nodeId === preferredId);
  if (preferred !== undefined) {
    return { status: "selected", node: preferred };
  }
  return { status: "selected", node: candidates[0]! };
}
