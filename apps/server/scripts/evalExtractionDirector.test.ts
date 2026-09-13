import { describe, expect, it } from "vite-plus/test";

import {
  encodeExtractionDirectorLineInput,
  parseExtractionDirectorLine,
  scoreExtractionDirectorRow,
  summarizeExtractionDirector,
  validateExtractionDirectorSet,
  type ExtractionDirectorFixtureRow,
} from "./evalExtractionDirector.ts";

const startRow: ExtractionDirectorFixtureRow = {
  id: "ext-start-01",
  // Explicit destination: with the focused Release docs task in context a
  // bare instruction continues it, so the happy-path start names Beacon.
  source: "Fix authentication in Beacon.",
  prediction: {
    text: "Fix authentication in Beacon.",
    action: "start",
    spans: [{ start: 18, end: 28, label: "DESTINATION" }],
  },
  expected: {
    action: "start",
    dispatchScope: "local",
    project: "Beacon",
    task: null,
    instruction: "Fix authentication.",
    provider: "Codex",
    needsInputReason: null,
  },
};

describe("extraction-to-Director offline eval", () => {
  it("accepts a correct start as useful through the shared Director", () => {
    const scored = scoreExtractionDirectorRow(startRow);
    expect(scored.accepted).toBe(true);
    expect(scored.useful).toBe(true);
    expect(scored.wrong).toBe(false);
    expect(scored.actualAction).toBe("start");
    expect(scored.actualDispatchScope).toBe("local");
    expect(scored.actualProject).toBe("Beacon");
    expect(scored.actualTask).toBeNull();
    expect(scored.actualInstruction).toBe("Fix authentication.");
    expect(scored.actualProvider).toBe("Codex");
    expect(scored.actionCorrect).toBe(true);
    expect(scored.dispatchScopeCorrect).toBe(true);
    expect(scored.projectCorrect).toBe(true);
    expect(scored.taskCorrect).toBe(true);
    expect(scored.instructionCorrect).toBe(true);
    expect(scored.providerCorrect).toBe(true);
    expect(scored.needsInputCorrect).toBe(true);
  });

  it("counts a wrong project as wrong accepted, never useful", () => {
    const scored = scoreExtractionDirectorRow({
      ...startRow,
      id: "ext-start-02",
      expected: { ...startRow.expected, project: "Rivvl" },
    });
    expect(scored.accepted).toBe(true);
    expect(scored.useful).toBe(false);
    expect(scored.wrong).toBe(true);
    expect(scored.projectCorrect).toBe(false);
    expect(scored.actualProject).toBe("Beacon");
  });

  it("refuses node routing instead of dispatching", () => {
    const source = "Move the task to north-node";
    const scored = scoreExtractionDirectorRow({
      id: "ext-node-01",
      source,
      prediction: {
        text: source,
        action: "reroute",
        spans: [
          { start: 9, end: 13, label: "TASK" },
          { start: 17, end: 27, label: "NODE" },
        ],
      },
      expected: {
        action: "reroute",
        dispatchScope: "none",
        project: null,
        task: null,
        instruction: null,
        provider: null,
        needsInputReason: "node-routing",
      },
    });
    expect(scored.accepted).toBe(false);
    expect(scored.useful).toBe(false);
    expect(scored.wrong).toBe(false);
    expect(scored.actualReason).toBe("node-routing");
    expect(scored.actionCorrect).toBe(true);
    expect(scored.dispatchScopeCorrect).toBe(true);
    expect(scored.needsInputCorrect).toBe(true);
  });

  it("asks for an unknown project through the Director", () => {
    const source = "Start work in Asterfall today";
    const scored = scoreExtractionDirectorRow({
      id: "ext-unknown-01",
      source,
      prediction: {
        text: source,
        action: "start",
        spans: [{ start: 14, end: 23, label: "PROJECT" }],
      },
      expected: {
        action: "start",
        dispatchScope: "none",
        project: null,
        task: null,
        instruction: null,
        provider: null,
        needsInputReason: "control-target-required",
      },
    });
    expect(scored.accepted).toBe(false);
    expect(scored.actualReason).toBe("control-target-required");
    expect(scored.needsInputCorrect).toBe(true);
  });

  it("summarizes accepted, wrong, useful, coverage, and escalation reasons", () => {
    const wrong = scoreExtractionDirectorRow({
      ...startRow,
      id: "ext-start-03",
      expected: { ...startRow.expected, project: "Rivvl" },
    });
    const escalated = scoreExtractionDirectorRow({
      id: "ext-node-02",
      source: "Move the task to north-node",
      prediction: {
        text: "Move the task to north-node",
        action: "reroute",
        spans: [
          { start: 9, end: 13, label: "TASK" },
          { start: 17, end: 27, label: "NODE" },
        ],
      },
      expected: {
        action: "reroute",
        dispatchScope: "none",
        project: null,
        task: null,
        instruction: null,
        provider: null,
        needsInputReason: "node-routing",
      },
    });
    const summary = summarizeExtractionDirector([
      scoreExtractionDirectorRow(startRow),
      wrong,
      escalated,
    ]);
    expect(summary.all).toBe(3);
    expect(summary.accepted).toBe(2);
    expect(summary.wrong).toBe(1);
    expect(summary.useful).toBe(1);
    expect(summary.coverage).toBeCloseTo(2 / 3, 5);
    expect(summary.needsInput).toBe(1);
    expect(summary.dispatchScopeCorrect).toBe(3);
    expect(summary.reasons).toEqual({ "node-routing": 1 });
  });

  it("rejects missing predictions, duplicate ids, and source mismatch", () => {
    expect(() =>
      parseExtractionDirectorLine(encodeExtractionDirectorLineInput({ id: "x", source: "hi" }), 1),
    ).toThrow(/missing actual candidate predictions/);
    const first = parseExtractionDirectorLine(
      encodeExtractionDirectorLineInput({
        id: "dup",
        source: "Fix authentication.",
        prediction: { text: "Fix authentication.", action: "start", spans: [] },
        expected: startRow.expected,
      }),
      1,
    );
    const second = parseExtractionDirectorLine(
      encodeExtractionDirectorLineInput({
        id: "dup",
        source: "Fix authentication.",
        prediction: { text: "Fix authentication.", action: "start", spans: [] },
        expected: startRow.expected,
      }),
      2,
    );
    expect(() => validateExtractionDirectorSet([first, second])).toThrow(/duplicate fixture id/);
    const mismatched: ExtractionDirectorFixtureRow = {
      ...startRow,
      prediction: { text: "Different text.", action: "start", spans: [] },
    };
    expect(() => validateExtractionDirectorSet([mismatched])).toThrow(/source mismatch/);
  });
});
