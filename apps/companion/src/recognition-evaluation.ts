export type CompanionRecognitionEntityKind = "project" | "provider" | "model";

export type CompanionRecognitionScenario = {
  readonly id: string;
  readonly expectedTranscript: string;
  readonly expectedFirstWord: string;
  readonly entities: ReadonlyArray<{
    readonly canonical: string;
    readonly kind: CompanionRecognitionEntityKind;
  }>;
};

export type CompanionRecognitionObservation = {
  readonly engineId: string;
  readonly scenarioId: string;
  readonly rawTranscript: string;
  readonly routedTranscript: string;
  readonly readyLatencyMs: number;
  readonly finalLatencyMs: number;
  readonly cpuTimeMs: number;
  readonly peakRssBytes: number;
  readonly resourceBytes: number;
};

export type CompanionRecognitionScore = CompanionRecognitionObservation & {
  readonly wordErrorRate: number;
  readonly characterErrorRate: number;
  readonly firstWordRetained: boolean;
  readonly rawEntityAccuracy: number;
  readonly groundedEntityAccuracy: number;
};

export type CompanionRecognitionEngineSummary = {
  readonly engineId: string;
  readonly sampleCount: number;
  readonly wordErrorRate: number;
  readonly characterErrorRate: number;
  readonly firstWordRetention: number;
  readonly rawEntityAccuracy: number;
  readonly groundedEntityAccuracy: number;
  readonly meanReadyLatencyMs: number;
  readonly meanFinalLatencyMs: number;
  readonly meanCpuTimeMs: number;
  readonly peakRssBytes: number;
  readonly resourceBytes: number;
};

export const companionRecognitionScenarios: ReadonlyArray<CompanionRecognitionScenario> = [
  {
    id: "rivvl-pull-request",
    expectedTranscript: "Check the open pull request in Rivvl and tell me its status.",
    expectedFirstWord: "Check",
    entities: [{ canonical: "Rivvl", kind: "project" }],
  },
  {
    id: "immediate-first-word",
    expectedTranscript: "Actually, do that in the Rivvl project.",
    expectedFirstWord: "Actually",
    entities: [{ canonical: "Rivvl", kind: "project" }],
  },
  {
    id: "provider-model-routing",
    expectedTranscript: "Use Codex Sol at high effort to review the Alertify task.",
    expectedFirstWord: "Use",
    entities: [
      { canonical: "Codex", kind: "provider" },
      { canonical: "Sol", kind: "model" },
      { canonical: "Alertify", kind: "project" },
    ],
  },
  {
    id: "multi-segment-follow-up",
    expectedTranscript:
      "After that, update the documentation. Then tell me what the Alertify task is doing.",
    expectedFirstWord: "After",
    entities: [{ canonical: "Alertify", kind: "project" }],
  },
];

export function companionRecognitionScenario(id: string): CompanionRecognitionScenario | undefined {
  return companionRecognitionScenarios.find((scenario) => scenario.id === id);
}

function words(value: string): ReadonlyArray<string> {
  return (
    value
      .normalize("NFKD")
      .toLocaleLowerCase("en-US")
      .match(/[\p{Letter}\p{Number}]+/gu) ?? []
  );
}

function characters(value: string): ReadonlyArray<string> {
  return [...words(value).join(" ")];
}

function editDistance(left: ReadonlyArray<string>, right: ReadonlyArray<string>): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        (previous[rightIndex] ?? 0) + 1,
        (current[rightIndex - 1] ?? 0) + 1,
        (previous[rightIndex - 1] ?? 0) + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[right.length] ?? 0;
}

function containsPhrase(transcript: string, phrase: string): boolean {
  const transcriptWords = words(transcript);
  const phraseWords = words(phrase);
  if (phraseWords.length === 0) return false;
  return transcriptWords.some((_, index) =>
    phraseWords.every((word, offset) => transcriptWords[index + offset] === word),
  );
}

export function scoreCompanionRecognitionObservation(input: {
  readonly scenario: CompanionRecognitionScenario;
  readonly observation: CompanionRecognitionObservation;
}): CompanionRecognitionScore {
  if (input.observation.scenarioId !== input.scenario.id) {
    throw new Error(
      `Recognition observation ${input.observation.scenarioId} does not match scenario ${input.scenario.id}.`,
    );
  }
  const expectedWords = words(input.scenario.expectedTranscript);
  const rawWords = words(input.observation.rawTranscript);
  const expectedCharacters = characters(input.scenario.expectedTranscript);
  const rawCharacters = characters(input.observation.rawTranscript);
  const rawMatchedEntities = input.scenario.entities.filter((entity) =>
    containsPhrase(input.observation.rawTranscript, entity.canonical),
  ).length;
  const groundedMatchedEntities = input.scenario.entities.filter((entity) =>
    containsPhrase(input.observation.routedTranscript, entity.canonical),
  ).length;
  return {
    ...input.observation,
    wordErrorRate:
      expectedWords.length === 0 ? 0 : editDistance(expectedWords, rawWords) / expectedWords.length,
    characterErrorRate:
      expectedCharacters.length === 0
        ? 0
        : editDistance(expectedCharacters, rawCharacters) / expectedCharacters.length,
    firstWordRetained:
      rawWords[0] === words(input.scenario.expectedFirstWord)[0] && rawWords.length > 0,
    rawEntityAccuracy:
      input.scenario.entities.length === 0
        ? 1
        : rawMatchedEntities / input.scenario.entities.length,
    groundedEntityAccuracy:
      input.scenario.entities.length === 0
        ? 1
        : groundedMatchedEntities / input.scenario.entities.length,
  };
}

function mean(values: ReadonlyArray<number>): number {
  return values.length === 0
    ? 0
    : values.reduce((total, value) => total + value, 0) / values.length;
}

export function summarizeCompanionRecognitionScores(
  scores: ReadonlyArray<CompanionRecognitionScore>,
): ReadonlyArray<CompanionRecognitionEngineSummary> {
  const byEngine = Map.groupBy(scores, (score) => score.engineId);
  return [...byEngine.entries()]
    .map(([engineId, samples]) => ({
      engineId,
      sampleCount: samples.length,
      wordErrorRate: mean(samples.map((sample) => sample.wordErrorRate)),
      characterErrorRate: mean(samples.map((sample) => sample.characterErrorRate)),
      firstWordRetention: mean(samples.map((sample) => (sample.firstWordRetained ? 1 : 0))),
      rawEntityAccuracy: mean(samples.map((sample) => sample.rawEntityAccuracy)),
      groundedEntityAccuracy: mean(samples.map((sample) => sample.groundedEntityAccuracy)),
      meanReadyLatencyMs: mean(samples.map((sample) => sample.readyLatencyMs)),
      meanFinalLatencyMs: mean(samples.map((sample) => sample.finalLatencyMs)),
      meanCpuTimeMs: mean(samples.map((sample) => sample.cpuTimeMs)),
      peakRssBytes: Math.max(...samples.map((sample) => sample.peakRssBytes)),
      resourceBytes: Math.max(...samples.map((sample) => sample.resourceBytes)),
    }))
    .toSorted((left, right) => left.engineId.localeCompare(right.engineId));
}
