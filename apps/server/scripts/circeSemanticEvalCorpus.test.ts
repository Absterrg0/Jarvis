import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { CirceSemanticProposal } from "@circe/core/command";

import { circeSemanticEvalCorpus } from "./circeSemanticEvalCorpus.ts";
import { circeSemanticDevCorpus } from "./circeSemanticDevCorpus.ts";
import { buildStrictCirceSemanticJsonSchema } from "./circeSemanticSchema.ts";
import { CIRCE_SEMANTIC_THRESHOLDS, scoreProposal } from "./circeSemanticEvalEngine.ts";

const decodeProposal = Schema.decodeUnknownSync(CirceSemanticProposal);

describe("Circe semantic eval corpus", () => {
  it("keeps the previous 92-case corpus as regression source", () => {
    expect(circeSemanticEvalCorpus).toHaveLength(92);
    expect(new Set(circeSemanticEvalCorpus.map((entry) => entry.id)).size).toBe(92);
    expect(new Set(circeSemanticEvalCorpus.map((entry) => entry.action))).toEqual(
      new Set([
        "start",
        "continue",
        "steer",
        "queue",
        "stop",
        "status",
        "review",
        "reroute",
        "focus-project",
        "focus-task",
        "list-projects",
        "converse",
        "unsupported",
      ]),
    );
  });

  it("treats previous dev and heldout as one regression set", () => {
    const dev = circeSemanticEvalCorpus.filter((entry) => entry.split === "dev");
    const heldout = circeSemanticEvalCorpus.filter((entry) => entry.split === "heldout");
    expect(dev).toHaveLength(72);
    expect(heldout).toHaveLength(20);
    for (const category of [
      "destination-vs-mention",
      "negation-constraint-quote",
      "multi-span",
      "correction-asr-alias",
      "provider",
      "absent-catalog-pending-compound",
    ] as const) {
      expect(dev.some((entry) => entry.category === category)).toBe(true);
      expect(heldout.some((entry) => entry.category === category)).toBe(true);
    }
  });

  it("skips legacy Intent snapshots under the new proposal schema, never passing them", () => {
    let legacy = 0;
    for (const entry of circeSemanticEvalCorpus) {
      const fixture = (entry as { fixtureIntent?: unknown }).fixtureIntent;
      if (fixture === undefined) continue;
      legacy += 1;
      expect(() => decodeProposal(fixture)).toThrow();
    }
    expect(legacy).toBe(42);
  });

  it("pins stripped dispatch wording on the two destination dev cases", () => {
    const byId = new Map(circeSemanticEvalCorpus.map((entry) => [entry.id, entry]));
    expect(byId.get("dest-01")?.expectedInstruction).toBe(
      "fix the login redirect that Rivvl reported.",
    );
    expect(byId.get("prov-03")?.expectedInstruction).toBe(
      "have Codex add an auth integration test, not the load test.",
    );
  });

  it("builds a strict schema that tracks the live proposal", () => {
    const schema = buildStrictCirceSemanticJsonSchema();
    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(false);
    const properties = schema.properties as Record<string, unknown>;
    expect([...(schema.required as Array<string>)].sort()).toEqual(Object.keys(properties).sort());
    expect(properties.action).toBeDefined();
    expect(properties.refs).toBeDefined();
    expect(properties.model).toBeDefined();
    expect(properties.effort).toBeDefined();
    expect(properties.answer).toBeDefined();
    const action = properties.action as { type: string; enum: Array<string> };
    expect(action.type).toBe("string");
    expect(action.enum).toContain("unsupported");
    expect(action.enum).toContain("converse");
  });

  it("keeps an independent 13-case dev regression with families and literal expectations", () => {
    expect(circeSemanticDevCorpus).toHaveLength(13);
    expect(new Set(circeSemanticDevCorpus.map((entry) => entry.id)).size).toBe(13);
    for (const entry of circeSemanticDevCorpus) {
      expect(entry.split).toBe("dev");
      expect(entry.utterance.length).toBeGreaterThan(0);
      expect(entry.family.length).toBeGreaterThan(0);
      expect(() => decodeProposal(entry.fixtureProposal)).not.toThrow();
      if (entry.expectedInstruction !== undefined) {
        expect(typeof entry.expectedInstruction).toBe("string");
        expect(entry.expectedInstruction.length).toBeGreaterThan(0);
      }
    }
    const families = new Set(circeSemanticDevCorpus.map((entry) => entry.family));
    for (const required of [
      "complete-command",
      "destination-mention",
      "negation-constraint",
      "compound-multi",
      "correction-asr-alias",
      "provider-routing",
      "ambiguity-clarification",
      "safety-exclusion",
      "safety-cross-node",
      "safety-stale",
      "converse-general",
    ] as const) {
      expect(families.has(required)).toBe(true);
    }
  });

  it("scores every dev fixture through the pure Director with no dispatch", () => {
    for (const entry of circeSemanticDevCorpus) {
      const result = scoreProposal(
        {
          id: entry.id,
          utterance: entry.utterance,
          action: entry.action,
          family: entry.family,
          split: entry.split,
          ...(entry.expectedProject === undefined
            ? {}
            : { expectedProject: entry.expectedProject }),
          ...(entry.expectedTask === undefined ? {} : { expectedTask: entry.expectedTask }),
          ...(entry.expectedProvider === undefined
            ? {}
            : { expectedProvider: entry.expectedProvider }),
          ...(entry.expectedInstruction === undefined
            ? {}
            : { expectedInstruction: entry.expectedInstruction }),
          ...(entry.instructionContains === undefined
            ? {}
            : { instructionContains: entry.instructionContains }),
          ...(entry.expectedCommand === undefined
            ? {}
            : { expectedCommand: entry.expectedCommand }),
          ...(entry.expectClarification === undefined
            ? {}
            : { expectClarification: entry.expectClarification }),
          ...(entry.expectedClarificationReason === undefined
            ? {}
            : { expectedClarificationReason: entry.expectedClarificationReason }),
          ...(entry.expectedAck === undefined ? {} : { expectedAck: entry.expectedAck }),
          ...(entry.excludedProject === undefined
            ? {}
            : { excludedProject: entry.excludedProject }),
          ...(entry.context === undefined ? {} : { context: entry.context }),
          legacyFixture: false,
        },
        entry.fixtureProposal,
        "offline-fixture",
      );
      expect(result.dispatched).toBe(false);
      expect(result.verdict).toBe("pass");
    }
  });

  it("freezes user-approved thresholds", () => {
    expect(CIRCE_SEMANTIC_THRESHOLDS.exclusionDispatch).toBe(0);
    expect(CIRCE_SEMANTIC_THRESHOLDS.textCorruption).toBe(0);
    expect(CIRCE_SEMANTIC_THRESHOLDS.crossNodeViolation).toBe(0);
    expect(CIRCE_SEMANTIC_THRESHOLDS.staleSpeech).toBe(0);
    expect(CIRCE_SEMANTIC_THRESHOLDS.completePassRate).toBe(0.95);
    expect(CIRCE_SEMANTIC_THRESHOLDS.unnecessaryClarificationRate).toBe(0.05);
    expect(CIRCE_SEMANTIC_THRESHOLDS.ambiguityAccuracy).toBe(0.95);
    expect(CIRCE_SEMANTIC_THRESHOLDS.repeatConsistency).toBe(1);
  });
});
