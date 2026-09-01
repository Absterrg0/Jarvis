import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";

import { selectVoiceNode, type VoiceNodeCandidate } from "./voiceNodeSelection";

const desktop = {
  nodeId: EnvironmentId.make("desktop"),
  label: "Desktop",
  reachability: "online",
  voiceCompute: true,
} satisfies VoiceNodeCandidate;
const laptop = {
  nodeId: EnvironmentId.make("laptop"),
  label: "Laptop",
  reachability: "online",
  voiceCompute: true,
} satisfies VoiceNodeCandidate;

describe("mobile voice node selection", () => {
  it("uses the explicit online voice node", () => {
    expect(
      selectVoiceNode({ preferredVoiceNodeId: desktop.nodeId, nodes: [desktop, laptop] }),
    ).toEqual({ status: "selected", node: desktop });
  });

  it("reports an offline preferred node and offers another without selecting it", () => {
    expect(
      selectVoiceNode({
        preferredVoiceNodeId: desktop.nodeId,
        nodes: [{ ...desktop, reachability: "offline" }, laptop],
      }),
    ).toEqual({
      status: "preferred-unavailable",
      preferredNodeId: desktop.nodeId,
      fallbackCandidates: [laptop],
    });
  });

  it("requires explicit selection when several voice nodes are connected", () => {
    expect(selectVoiceNode({ preferredVoiceNodeId: undefined, nodes: [desktop, laptop] })).toEqual({
      status: "needs-selection",
      candidates: [desktop, laptop],
    });
  });

  it("does not treat execution-only nodes as voice nodes", () => {
    expect(
      selectVoiceNode({
        preferredVoiceNodeId: undefined,
        nodes: [{ ...desktop, voiceCompute: false }],
      }),
    ).toEqual({ status: "no-voice-node" });
  });
});
