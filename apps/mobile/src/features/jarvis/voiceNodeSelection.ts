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
      readonly status: "needs-selection";
      readonly candidates: ReadonlyArray<VoiceNodeCandidate>;
    }
  | {
      readonly status: "preferred-unavailable";
      readonly preferredNodeId: EnvironmentId;
      readonly fallbackCandidates: ReadonlyArray<VoiceNodeCandidate>;
    }
  | {
      readonly status: "no-voice-node";
    };

/**
 * Resolve the explicitly chosen voice node. A fallback is returned as an
 * offer, never silently selected, when the preferred node is offline.
 */
export function selectVoiceNode(input: {
  readonly preferredVoiceNodeId: EnvironmentId | null | undefined;
  readonly nodes: ReadonlyArray<VoiceNodeCandidate>;
}): VoiceNodeSelection {
  const candidates = input.nodes.filter(
    (node) => node.voiceCompute && node.reachability === "online",
  );
  const preferredId = input.preferredVoiceNodeId ?? null;
  if (preferredId === null) {
    return candidates.length === 0
      ? { status: "no-voice-node" }
      : { status: "needs-selection", candidates };
  }

  const preferred = candidates.find((node) => node.nodeId === preferredId);
  if (preferred !== undefined) {
    return { status: "selected", node: preferred };
  }

  return {
    status: "preferred-unavailable",
    preferredNodeId: preferredId,
    fallbackCandidates: candidates.filter((node) => node.nodeId !== preferredId),
  };
}
