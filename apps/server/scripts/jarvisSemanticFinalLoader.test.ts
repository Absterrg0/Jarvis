// @effect-diagnostics nodeBuiltinImport:off - final loader tests use temp dirs for synthetic fixtures.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { FINAL_MAX_CALLS, loadFinalCorpus } from "./jarvisSemanticFinalLoader.ts";

function makeCase(id: string, family: string, utterance: string): Record<string, unknown> {
  return {
    id,
    utterance,
    action: "start",
    family,
    split: "final",
    expectedInstruction: utterance,
    expectedCommand: "start",
    expectedAck: "Request accepted for Jarvis.",
  };
}

const REQUIRED = [
  "complete-command",
  "destination-mention",
  "negation-constraint",
  "compound-multi",
  "correction-asr-alias",
  "provider-routing",
  "ambiguity-clarification",
];

function forty(): Array<Record<string, unknown>> {
  const cases: Array<Record<string, unknown>> = [];
  for (let index = 0; index < 40; index += 1) {
    const family = REQUIRED[index % REQUIRED.length]!;
    cases.push(
      makeCase(
        `final-${String(index).padStart(2, "0")}`,
        family,
        `Fresh sealed utterance ${index} for Jarvis.`,
      ),
    );
  }
  return cases;
}

function writeFinal(
  dir: string,
  cases: Array<Record<string, unknown>>,
  repeatIds?: Array<string>,
): void {
  NodeFS.writeFileSync(NodePath.join(dir, "cases.json"), JSON.stringify(cases), "utf8");
  NodeFS.writeFileSync(
    NodePath.join(dir, "meta.json"),
    JSON.stringify({
      reviewed: "synthetic-unreviewed",
      families: REQUIRED,
      createdAt: "2026-09-08T00:00:00.000Z",
      note: "test fixture",
    }),
    "utf8",
  );
  if (repeatIds !== undefined) {
    NodeFS.writeFileSync(NodePath.join(dir, "repeats.json"), JSON.stringify({ repeatIds }), "utf8");
  }
}

describe("sealed final loader", () => {
  it("reports missing when the external dir is absent", () => {
    const result = loadFinalCorpus(
      NodePath.join(NodeOS.tmpdir(), "jarvis-final-missing-xyz"),
      false,
    );
    expect(result.status).toBe("missing");
  });

  it("rejects fewer than 40 cases and wrong reviewed status", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "jarvis-final-"));
    try {
      writeFinal(dir, forty().slice(0, 10));
      expect(loadFinalCorpus(dir, false).status).toBe("invalid");
      writeFinal(dir, forty());
      NodeFS.writeFileSync(
        NodePath.join(dir, "meta.json"),
        JSON.stringify({ reviewed: "reviewed", families: [], createdAt: "", note: "" }),
        "utf8",
      );
      expect(loadFinalCorpus(dir, false).status).toBe("invalid");
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects sealed fixtures and missing families", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "jarvis-final-"));
    try {
      const cases = forty();
      (cases[0] as Record<string, unknown>).fixtureProposal = { action: "start" };
      writeFinal(dir, cases);
      expect(loadFinalCorpus(dir, false).status).toBe("invalid");
      // Remap instead of filtering: filtering also drops the case count
      // below the minimum, which would fail for the wrong reason.
      const narrow = forty();
      for (const entry of narrow) {
        if ((entry as Record<string, unknown>).family === "provider-routing") {
          (entry as Record<string, unknown>).family = "complete-command";
        }
      }
      writeFinal(dir, narrow);
      const result = loadFinalCorpus(dir, false);
      expect(result.status).toBe("invalid");
      if (result.status === "invalid") {
        expect(result.reason).toContain("final missing family provider-routing");
      }
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loads 40 fresh cases and expands 10x3 repeats within 70 calls", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "jarvis-final-"));
    try {
      const cases = forty();
      const repeatIds = cases.slice(0, 10).map((entry) => String(entry.id));
      writeFinal(dir, cases, repeatIds);
      const base = loadFinalCorpus(dir, false);
      expect(base.status).toBe("ok");
      if (base.status !== "ok") return;
      expect(base.cases).toHaveLength(40);
      expect(base.meta.reviewed).toBe("synthetic-unreviewed");
      const expanded = loadFinalCorpus(dir, true);
      expect(expanded.status).toBe("ok");
      if (expanded.status !== "ok") return;
      expect(expanded.cases).toHaveLength(70);
      expect(FINAL_MAX_CALLS).toBe(70);
      const repeats = expanded.cases.filter((entry) => entry.repeatOf !== undefined);
      expect(repeats).toHaveLength(30);
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects malformed meta and repeats shapes instead of throwing", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "jarvis-final-"));
    try {
      writeFinal(dir, forty());
      for (const malformed of ["null", "[]", "42", '"reviewed"']) {
        NodeFS.writeFileSync(NodePath.join(dir, "meta.json"), malformed, "utf8");
        const result = loadFinalCorpus(dir, false);
        expect(result.status).toBe("invalid");
      }
      writeFinal(dir, forty(), []);
      NodeFS.writeFileSync(NodePath.join(dir, "repeats.json"), '["final-00"]', "utf8");
      const expanded = loadFinalCorpus(dir, true);
      expect(expanded.status).toBe("invalid");
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });
});
