import { assert, describe, it } from "@effect/vitest";

import {
  companionRecognitionScenario,
  companionRecognitionScenarios,
  scoreCompanionRecognitionObservation,
  summarizeCompanionRecognitionScores,
} from "./recognition-evaluation.ts";

describe("Companion recognition evaluation", () => {
  it("resolves only the stable scenario catalog used to label recordings", () => {
    assert.equal(companionRecognitionScenario("rivvl-pull-request")?.expectedFirstWord, "Check");
    assert.isUndefined(companionRecognitionScenario("typo"));
  });

  it("scores raw recognition separately from grounded vocabulary repair", () => {
    const scenario = companionRecognitionScenarios[0]!;
    const score = scoreCompanionRecognitionObservation({
      scenario,
      observation: {
        engineId: "parakeet-110m-int8",
        scenarioId: scenario.id,
        rawTranscript: "Check the open pull request in ripple and tell me its status",
        routedTranscript: "Check the open pull request in Rivvl and tell me its status",
        readyLatencyMs: 420,
        finalLatencyMs: 1_900,
        cpuTimeMs: 1_200,
        peakRssBytes: 240_000_000,
        resourceBytes: 153_000_000,
      },
    });

    assert.isAbove(score.wordErrorRate, 0);
    assert.isAbove(score.characterErrorRate, 0);
    assert.isTrue(score.firstWordRetained);
    assert.equal(score.rawEntityAccuracy, 0);
    assert.equal(score.groundedEntityAccuracy, 1);
  });

  it("detects a lost opening word and requires whole grounded entity phrases", () => {
    const scenario = companionRecognitionScenarios[2]!;
    const score = scoreCompanionRecognitionObservation({
      scenario,
      observation: {
        engineId: "candidate",
        scenarioId: scenario.id,
        rawTranscript: "Codex soul at high effort to review the alert task",
        routedTranscript: "Codex Sol at high effort to review the alert task",
        readyLatencyMs: 200,
        finalLatencyMs: 900,
        cpuTimeMs: 600,
        peakRssBytes: 100,
        resourceBytes: 200,
      },
    });

    assert.isFalse(score.firstWordRetained);
    assert.equal(score.rawEntityAccuracy, 1 / 3);
    assert.equal(score.groundedEntityAccuracy, 2 / 3);
  });

  it("rejects a mislabeled observation before it can contaminate an engine summary", () => {
    const scenario = companionRecognitionScenarios[0]!;
    assert.throws(() =>
      scoreCompanionRecognitionObservation({
        scenario,
        observation: {
          engineId: "parakeet",
          scenarioId: "another-scenario",
          rawTranscript: scenario.expectedTranscript,
          routedTranscript: scenario.expectedTranscript,
          readyLatencyMs: 1,
          finalLatencyMs: 2,
          cpuTimeMs: 3,
          peakRssBytes: 4,
          resourceBytes: 5,
        },
      }),
    );
  });

  it("summarizes engines without hiding resource and worst-case memory costs", () => {
    const scenario = companionRecognitionScenarios[1]!;
    const makeScore = (engineId: string, finalLatencyMs: number, peakRssBytes: number) =>
      scoreCompanionRecognitionObservation({
        scenario,
        observation: {
          engineId,
          scenarioId: scenario.id,
          rawTranscript: scenario.expectedTranscript,
          routedTranscript: scenario.expectedTranscript,
          readyLatencyMs: 100,
          finalLatencyMs,
          cpuTimeMs: 300,
          peakRssBytes,
          resourceBytes: engineId === "baseline" ? 150 : 90,
        },
      });

    assert.deepEqual(
      summarizeCompanionRecognitionScores([
        makeScore("baseline", 800, 250),
        makeScore("baseline", 1_200, 300),
        makeScore("parakeet", 700, 180),
      ]),
      [
        {
          engineId: "baseline",
          sampleCount: 2,
          wordErrorRate: 0,
          characterErrorRate: 0,
          firstWordRetention: 1,
          rawEntityAccuracy: 1,
          groundedEntityAccuracy: 1,
          meanReadyLatencyMs: 100,
          meanFinalLatencyMs: 1_000,
          meanCpuTimeMs: 300,
          peakRssBytes: 300,
          resourceBytes: 150,
        },
        {
          engineId: "parakeet",
          sampleCount: 1,
          wordErrorRate: 0,
          characterErrorRate: 0,
          firstWordRetention: 1,
          rawEntityAccuracy: 1,
          groundedEntityAccuracy: 1,
          meanReadyLatencyMs: 100,
          meanFinalLatencyMs: 700,
          meanCpuTimeMs: 300,
          peakRssBytes: 180,
          resourceBytes: 90,
        },
      ],
    );
  });
});
