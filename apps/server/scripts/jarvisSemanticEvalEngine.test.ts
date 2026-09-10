// @effect-diagnostics nodeBuiltinImport:off - engine test reads the harness file for static registry-path checks.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import { gateThresholds, scoreProposal } from "./jarvisSemanticEvalEngine.ts";
import { jarvisSemanticDevCorpus } from "./jarvisSemanticDevCorpus.ts";

describe("eval engine", () => {
  it("marks legacy Intent snapshots as skipped-legacy, never passing", () => {
    const legacyIntent = {
      action: "start",
      acknowledgement: "Fixing.",
      project: "Jarvis",
      task: null,
      instruction: "Fix it.",
      provider: null,
      model: null,
      effort: null,
      answer: null,
    };
    const result = scoreProposal(
      {
        id: "legacy-01",
        utterance: "Fix it.",
        action: "start",
        family: "complete-command",
        split: "regression",
        legacyFixture: true,
      },
      legacyIntent,
      "offline-fixture",
    );
    expect(result.verdict).toBe("skipped-legacy");
    expect(result.mode).toBe("legacy-skipped");
  });

  it("flags exclusion dispatch with zero tolerance", () => {
    const entry = jarvisSemanticDevCorpus.find((candidate) => candidate.id === "dev-complete-01")!;
    const bad = scoreProposal(
      {
        id: entry.id,
        utterance: entry.utterance,
        action: entry.action,
        family: "safety-exclusion",
        split: "dev",
        expectedProject: entry.expectedProject,
        expectedInstruction: entry.expectedInstruction,
        expectedCommand: entry.expectedCommand,
        expectedAck: entry.expectedAck,
        excludedProject: "Rivvl",
      },
      entry.fixtureProposal,
      "offline-fixture",
    );
    expect(bad.verdict).toBe("exclusion-dispatch");
    const gate = gateThresholds([bad], []);
    expect(gate.pass).toBe(false);
    expect(gate.exclusionDispatch).toBe(1);
  });

  it("flags text corruption on exact mismatch", () => {
    const entry = jarvisSemanticDevCorpus.find((candidate) => candidate.id === "dev-complete-02")!;
    const bad = scoreProposal(
      {
        id: entry.id,
        utterance: entry.utterance,
        action: entry.action,
        family: entry.family,
        split: entry.split,
        expectedInstruction: "Different exact wording.",
        expectedCommand: entry.expectedCommand,
        expectedAck: entry.expectedAck,
      },
      entry.fixtureProposal,
      "offline-fixture",
    );
    expect(bad.verdict).toBe("text-corruption");
  });

  it("requires 100 percent repeat consistency", () => {
    const entry = jarvisSemanticDevCorpus[0]!;
    const baseInput = {
      id: entry.id,
      utterance: entry.utterance,
      action: entry.action,
      family: entry.family,
      split: entry.split,
      ...(entry.expectedProject === undefined ? {} : { expectedProject: entry.expectedProject }),
      ...(entry.expectedInstruction === undefined
        ? {}
        : { expectedInstruction: entry.expectedInstruction }),
      ...(entry.expectedCommand === undefined ? {} : { expectedCommand: entry.expectedCommand }),
      ...(entry.expectedAck === undefined ? {} : { expectedAck: entry.expectedAck }),
      legacyFixture: false,
    };
    const first = scoreProposal(baseInput, entry.fixtureProposal, "offline-fixture");
    const second = scoreProposal(baseInput, entry.fixtureProposal, "offline-fixture");
    const gate = gateThresholds([first, second], [[first, second]]);
    expect(gate.repeatConsistency).toBe(1);
    const divergent = { ...second, verdict: "wrong-action" as const };
    const badGate = gateThresholds([first, divergent], [[first, divergent]]);
    expect(badGate.pass).toBe(false);
  });

  it("keeps the harness on the public textGeneration path with bounded sequential calls", () => {
    const source = NodeFS.readFileSync(new URL("./evalJarvisSemantic.ts", import.meta.url), "utf8");
    expect(source).toContain("makeCodexTextGeneration");
    expect(source).toContain("generateStructured");
    expect(source).toContain("FINAL_MAX_CALLS");
    expect(source).toContain("budgetMs");
    expect(source).not.toContain("node:child_process");
    expect(source).not.toContain("spawnSync");
    expect(source).not.toContain('option("--model")');
    expect(source).not.toContain('option("--effort")');
    expect(source).not.toContain("liveRegistry");
    expect(source).not.toContain("as never");
  });

  it("requires an explicit codex binary for live runs, never bare PATH", () => {
    const source = NodeFS.readFileSync(new URL("./evalJarvisSemantic.ts", import.meta.url), "utf8");
    // Volta parent-process PATH shadows the shim default (node-image 0.149.1
    // vs outer 0.153.4). Live runs must pin the exact executable through the
    // normal CodexSettings binaryPath seam and record the absolute path.
    expect(source).not.toContain("codex (PATH)");
    expect(source).toContain("JARVIS_SEMANTIC_EVAL_CODEX");
    expect(source).toContain("volta which codex");
  });
});
