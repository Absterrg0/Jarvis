// @effect-diagnostics nodeBuiltinImport:off - standalone eval uses node fs/path/os for artifacts and sealed-corpus reads.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  buildCirceSemanticPrompt,
  CirceSemanticProposal,
  prepareCirceSemanticTurn,
} from "@circe/core/command";
import {
  CodexSettings,
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  type ProviderInstanceId,
} from "@t3tools/contracts";

import { makeCodexTextGeneration } from "../src/textGeneration/CodexTextGeneration.ts";
import * as ServerConfig from "../src/config.ts";

const decodeEvalCodexSettings = Schema.decodeSync(CodexSettings);

import { buildStrictCirceSemanticJsonSchema } from "./circeSemanticSchema.ts";
import { circeSemanticEvalCorpus } from "./circeSemanticEvalCorpus.ts";
import { circeSemanticDevCorpus } from "./circeSemanticDevCorpus.ts";
import {
  buildEvalContext,
  gateThresholds,
  scoreProposal,
  type EvalResult,
  type CirceSemanticEvalCaseV2,
} from "./circeSemanticEvalEngine.ts";
import { FINAL_DIR_DEFAULT, FINAL_MAX_CALLS, loadFinalCorpus } from "./circeSemanticFinalLoader.ts";

const USAGE = `usage: evalCirceSemantic.ts [--split dev|regression|final|all] [--case <a,b,c>]
  [--limit <n>] [--timeout-ms <ms>] [--budget-ms <ms>] [--offline]
  [--replay-dir <captured-dir>] [--source-report <report.json>]
  [--final-dir <dir>] [--include-repeats] [--fail-on-threshold]
  [--artifacts-dir <dir>] [--keep-artifacts] [--json] [--help]

Splits: dev is the small in-repo regression (new schema). regression is the
previous 92-case corpus, now regression rather than heldout; legacy
Intent snapshots decode as skipped-legacy, never as passing. final loads the
sealed synthetic-unreviewed corpus from outside the repo (default
/tmp/opencode/circe-semantic-final); 40 fresh cases, plus 10x3 repeats with
--include-repeats for 70 calls max. Live mode routes through the configured
provider registry textGeneration mechanism with the context supervisor
selection. No --model or --effort flags exist. Offline replays embedded
fixtures with no subprocess and no billing. Replay rescores captured
proposals, marked captured-replay and never live.`;

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function fail(message: string): never {
  process.stderr.write(`${message}\n${USAGE}\n`);
  process.exit(2);
}

if (process.argv.includes("--help")) {
  process.stdout.write(`${USAGE}\n`);
  process.exit(0);
}

if (process.argv.includes("--model") || process.argv.includes("--effort")) {
  fail(
    "Removed: --model/--effort hardcode the supervisor. The harness uses the configured provider registry with the context supervisor selection.",
  );
}

const splitFilter = option("--split") ?? "dev";
// The heldout split became the regression set: point both spellings at the
// migration message before the allowlist below rejects "heldout" outright.
if (process.argv.includes("--heldout") || splitFilter === "heldout") {
  fail("heldout is now regression. Use --split regression.");
}
if (
  splitFilter !== "dev" &&
  splitFilter !== "regression" &&
  splitFilter !== "final" &&
  splitFilter !== "all"
) {
  fail("--split must be dev, regression, final, or all.");
}
const caseFilters = (option("--case") ?? "")
  .split(",")
  .map((part) => part.trim())
  .filter((part) => part.length > 0);
const requestedLimit = Number(option("--limit") ?? "1000");
if (!Number.isInteger(requestedLimit) || requestedLimit < 1)
  fail("--limit must be a positive integer.");
const requestedTimeout = Number(option("--timeout-ms") ?? "60000");
if (!Number.isInteger(requestedTimeout) || requestedTimeout < 10_000) {
  fail("--timeout-ms must be an integer of at least 10000.");
}
const timeoutMs = Math.min(requestedTimeout, 120_000);
const requestedBudget = Number(option("--budget-ms") ?? String(timeoutMs * FINAL_MAX_CALLS));
if (!Number.isInteger(requestedBudget) || requestedBudget < timeoutMs) {
  fail("--budget-ms must be an integer of at least --timeout-ms.");
}
const budgetMs = requestedBudget;
const offline = process.argv.includes("--offline");
const replayDir = option("--replay-dir");
const sourceReportPath = option("--source-report");
if (offline && replayDir !== undefined) fail("--offline and --replay-dir cannot combine.");
if (sourceReportPath !== undefined && replayDir === undefined)
  fail("--source-report requires --replay-dir.");
const finalDir = option("--final-dir") ?? FINAL_DIR_DEFAULT;
const includeRepeats = process.argv.includes("--include-repeats");
const failOnThreshold = process.argv.includes("--fail-on-threshold");
const jsonOutput = process.argv.includes("--json");
const keepArtifacts = process.argv.includes("--keep-artifacts");
const artifactsDir = option("--artifacts-dir") ?? "/tmp/opencode";

type UnifiedCase = {
  id: string;
  utterance: string;
  action: string;
  family: string;
  split: string;
  category: string;
  expectedProject?: string | undefined;
  expectedTask?: string | undefined;
  expectedProvider?: string | undefined;
  expectedInstruction?: string | undefined;
  instructionContains?: ReadonlyArray<string> | undefined;
  expectedCommand?: string | undefined;
  expectClarification?: boolean | undefined;
  expectedClarificationReason?: string | undefined;
  expectedAck?: string | null | undefined;
  excludedProject?: string | undefined;
  context?:
    | {
        aliases?: ReadonlyArray<{ alias: string; project: string }> | undefined;
        voice?: boolean | undefined;
        pendingApproval?: boolean | undefined;
        continueContext?: boolean | undefined;
      }
    | undefined;
  continueContext?: boolean | undefined;
  proposal?: unknown;
  hasProposal?: boolean | undefined;
  legacyFixture?: boolean | undefined;
};

const CATEGORY_TO_FAMILY: Record<string, string> = {
  basic: "complete-command",
  "destination-vs-mention": "destination-mention",
  "negation-constraint-quote": "negation-constraint",
  "multi-span": "compound-multi",
  "correction-asr-alias": "correction-asr-alias",
  provider: "provider-routing",
  "absent-catalog-pending-compound": "ambiguity-clarification",
};

function regressionCases(): Array<UnifiedCase> {
  return circeSemanticEvalCorpus.map((entry) => ({
    id: entry.id,
    utterance: entry.utterance,
    action: entry.action,
    family: CATEGORY_TO_FAMILY[entry.category] ?? entry.category,
    split: "regression",
    category: entry.category,
    ...(entry.task === undefined ? {} : { expectedTask: entry.task }),
    ...(entry.project === undefined ? {} : { expectedProject: entry.project }),
    ...(entry.provider === undefined ? {} : { expectedProvider: entry.provider }),
    ...(entry.expectedInstruction === undefined
      ? {}
      : { expectedInstruction: entry.expectedInstruction }),
    ...(entry.instructionContains === undefined
      ? {}
      : { instructionContains: entry.instructionContains }),
    ...(entry.expectedCommand === undefined ? {} : { expectedCommand: entry.expectedCommand }),
    ...(entry.expectClarification === undefined
      ? {}
      : { expectClarification: entry.expectClarification }),
    ...(entry.expectedClarificationReason === undefined
      ? {}
      : { expectedClarificationReason: entry.expectedClarificationReason }),
    ...(entry.context === undefined && entry.continueContext === undefined
      ? {}
      : {
          context: {
            ...(entry.context ?? {}),
            ...(entry.continueContext === undefined
              ? {}
              : { continueContext: entry.continueContext }),
          },
        }),
    ...(entry.continueContext === undefined ? {} : { continueContext: entry.continueContext }),
    proposal: (entry as { fixtureIntent?: unknown }).fixtureIntent,
    hasProposal: (entry as { fixtureIntent?: unknown }).fixtureIntent !== undefined,
    legacyFixture: true,
  }));
}

function devCases(): Array<UnifiedCase> {
  return circeSemanticDevCorpus.map((entry: CirceSemanticEvalCaseV2) => ({
    id: entry.id,
    utterance: entry.utterance,
    action: entry.action,
    family: entry.family,
    split: "dev",
    category: entry.family,
    ...(entry.expectedProject === undefined ? {} : { expectedProject: entry.expectedProject }),
    ...(entry.expectedTask === undefined ? {} : { expectedTask: entry.expectedTask }),
    ...(entry.expectedProvider === undefined ? {} : { expectedProvider: entry.expectedProvider }),
    ...(entry.expectedInstruction === undefined
      ? {}
      : { expectedInstruction: entry.expectedInstruction }),
    ...(entry.instructionContains === undefined
      ? {}
      : { instructionContains: entry.instructionContains }),
    ...(entry.expectedCommand === undefined ? {} : { expectedCommand: entry.expectedCommand }),
    ...(entry.expectClarification === undefined
      ? {}
      : { expectClarification: entry.expectClarification }),
    ...(entry.expectedClarificationReason === undefined
      ? {}
      : { expectedClarificationReason: entry.expectedClarificationReason }),
    ...(entry.expectedAck === undefined ? {} : { expectedAck: entry.expectedAck }),
    ...(entry.excludedProject === undefined ? {} : { excludedProject: entry.excludedProject }),
    ...(entry.context === undefined ? {} : { context: entry.context }),
    proposal: entry.fixtureProposal,
    hasProposal: entry.fixtureProposal !== undefined,
    legacyFixture: false,
  }));
}

function finalCases(): Array<UnifiedCase> {
  const loaded = loadFinalCorpus(finalDir, includeRepeats);
  if (loaded.status === "missing") {
    fail(
      `Sealed final not found at ${finalDir}. Expected cases.json and meta.json with reviewed synthetic-unreviewed.`,
    );
  }
  if (loaded.status === "invalid") {
    fail(`Sealed final invalid: ${loaded.reason}`);
  }
  return loaded.cases.map((entry) => ({
    id: entry.id,
    utterance: entry.utterance,
    action: entry.action,
    family: entry.family,
    split: "final",
    category: entry.family,
    ...(entry.expectedProject === undefined ? {} : { expectedProject: entry.expectedProject }),
    ...(entry.expectedTask === undefined ? {} : { expectedTask: entry.expectedTask }),
    ...(entry.expectedProvider === undefined ? {} : { expectedProvider: entry.expectedProvider }),
    ...(entry.expectedInstruction === undefined
      ? {}
      : { expectedInstruction: entry.expectedInstruction }),
    ...(entry.instructionContains === undefined
      ? {}
      : { instructionContains: entry.instructionContains }),
    ...(entry.expectedCommand === undefined ? {} : { expectedCommand: entry.expectedCommand }),
    ...(entry.expectClarification === undefined
      ? {}
      : { expectClarification: entry.expectClarification }),
    ...(entry.expectedClarificationReason === undefined
      ? {}
      : { expectedClarificationReason: entry.expectedClarificationReason }),
    ...(entry.expectedAck === undefined ? {} : { expectedAck: entry.expectedAck }),
    ...(entry.excludedProject === undefined ? {} : { excludedProject: entry.excludedProject }),
    ...(entry.context === undefined ? {} : { context: entry.context }),
    proposal: undefined,
    hasProposal: false,
    legacyFixture: false,
  }));
}

let pool: Array<UnifiedCase> = [];
if (splitFilter === "dev" || splitFilter === "all") pool.push(...devCases());
if (splitFilter === "regression" || splitFilter === "all") pool.push(...regressionCases());
if (splitFilter === "final" || splitFilter === "all") pool.push(...finalCases());

const selectedCases = pool
  .filter(
    (entry) => caseFilters.length === 0 || caseFilters.some((filter) => entry.id.includes(filter)),
  )
  .slice(0, Math.min(requestedLimit, 1000));
if (selectedCases.length === 0) fail("No semantic eval cases matched.");
const isLiveRun = !offline && replayDir === undefined;
if (isLiveRun && selectedCases.length > FINAL_MAX_CALLS) {
  fail(
    `Selected ${selectedCases.length} live calls exceeds max ${FINAL_MAX_CALLS}. Narrow --case or --limit. Dev small plus final40 plus repeats30 must stay within 70.`,
  );
}
// Volta parent-process PATH shadows the shim default: node-image bin
// (0.149.1) wins over the outer volta-shim default (0.153.4) when the parent
// is node, so bare PATH lookup spawns the wrong CLI. Live runs pin the exact
// executable through the normal CodexSettings binaryPath seam.
// Resolve with volta which codex.
if (isLiveRun) {
  const pinned = process.env.CIRCE_SEMANTIC_EVAL_CODEX?.trim() ?? "";
  if (pinned.length === 0) {
    fail(
      'Live eval requires CIRCE_SEMANTIC_EVAL_CODEX to name the exact codex executable (e.g., CIRCE_SEMANTIC_EVAL_CODEX="$(volta which codex)"). Unset PATH lookup is disabled.',
    );
  }
  if (!NodePath.isAbsolute(pinned) || !NodeFS.existsSync(pinned)) {
    fail(
      `CIRCE_SEMANTIC_EVAL_CODEX must be an absolute existing executable path, got ${pinned}. Resolve with volta which codex.`,
    );
  }
}

const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "circe-semantic-eval-"));
const schemaPath = NodePath.join(directory, "proposal.schema.json");
NodeFS.writeFileSync(schemaPath, JSON.stringify(buildStrictCirceSemanticJsonSchema()), "utf8");

function loadReplayDurations(reportPath: string): ReadonlyMap<string, number> {
  const raw: unknown = JSON.parse(NodeFS.readFileSync(reportPath, "utf8"));
  if (
    typeof raw !== "object" ||
    raw === null ||
    !Array.isArray((raw as { results?: unknown }).results)
  ) {
    throw new Error(`--source-report ${reportPath} has no results array.`);
  }
  const durations = new Map<string, number>();
  for (const result of (raw as { results: Array<{ id?: unknown; semanticMs?: unknown }> })
    .results) {
    if (typeof result.id === "string" && typeof result.semanticMs === "number") {
      durations.set(result.id, result.semanticMs);
    }
  }
  return durations;
}

const replayDurations =
  replayDir !== undefined && sourceReportPath !== undefined
    ? loadReplayDurations(sourceReportPath)
    : new Map<string, number>();

const results: Array<EvalResult> = [];
const startedAt = performance.now();
let timedOut = false;
const liveState: {
  supervisor: {
    instanceId: ProviderInstanceId;
    model: string;
    effort: string;
    source: string;
  } | null;
  binary?: string;
} = { supervisor: null };

/**
 * Isolated read-only supervisor config. Reads the Codex subscription config
 * for the actual model/effort, never the eval fixtures. API keys are scrubbed
 * so generation bills the subscription, never a key. No writes anywhere.
 */
function readLiveSupervisorConfig(): {
  instanceId: ProviderInstanceId;
  model: string;
  effort: string;
  source: string;
} {
  const home = process.env.CODEX_HOME ?? NodePath.join(NodeOS.homedir(), ".codex");
  const configPath = NodePath.join(home, "config.toml");
  let text: string;
  try {
    text = NodeFS.readFileSync(configPath, "utf8");
  } catch {
    throw new Error(
      `Live supervisor config not found at ${configPath}. Configure Codex subscription first.`,
    );
  }
  const model = text.match(/^\s*model\s*=\s*"([^"]+)"\s*$/mu)?.[1];
  const effort = text.match(/^\s*model_reasoning_effort\s*=\s*"([^"]+)"\s*$/mu)?.[1] ?? "medium";
  if (model === undefined || model.length === 0) {
    throw new Error(`Live supervisor config at ${configPath} names no model.`);
  }
  return {
    instanceId: defaultInstanceIdForDriver(ProviderDriverKind.make("codex")),
    model,
    effort,
    source: configPath,
  };
}

/** Live supervisor through the public Codex textGeneration service. No ad-hoc CLI flags here. */
async function runLiveProposal(
  entry: UnifiedCase,
  perCaseTimeoutMs: number,
): Promise<{ proposal: unknown; semanticMs: number }> {
  const supervisor = liveState.supervisor ?? readLiveSupervisorConfig();
  liveState.supervisor = supervisor;
  const context = buildEvalContext({
    utterance: entry.utterance,
    ...(entry.context?.aliases === undefined ? {} : { aliases: entry.context.aliases }),
    ...(entry.context?.voice === undefined ? {} : { voice: entry.context.voice }),
    ...(entry.context?.pendingApproval === undefined
      ? {}
      : { pendingApproval: entry.context.pendingApproval }),
    ...((entry.context?.continueContext ?? entry.continueContext) === undefined
      ? {}
      : { continueContext: entry.context?.continueContext ?? entry.continueContext }),
  });
  const prepared = prepareCirceSemanticTurn(context);
  if (prepared.status !== "ready")
    throw new Error("The deterministic preflight rejected the eval fixture.");
  const prompt = buildCirceSemanticPrompt(context, prepared);
  const childEnv = { ...process.env };
  delete childEnv.OPENAI_API_KEY;
  delete childEnv.CODEX_API_KEY;
  // Pinned binary for reproducibility: volta shims resolve different CLI
  // versions depending on the parent process (node-image 0.149.1 vs outer
  // 0.153.4), so name the exact executable. Recorded in the report
  // supervisor block. Resolve with volta which codex.
  const evalBinary = process.env.CIRCE_SEMANTIC_EVAL_CODEX?.trim() ?? "";
  if (evalBinary.length === 0) {
    throw new Error(
      "Live eval requires CIRCE_SEMANTIC_EVAL_CODEX to name the exact codex executable. Resolve with volta which codex.",
    );
  }
  const codexSettings = decodeEvalCodexSettings({ binaryPath: evalBinary });
  if (liveState.binary === undefined) {
    liveState.binary = evalBinary;
  }
  const program = Effect.gen(function* () {
    const textGeneration = yield* makeCodexTextGeneration(codexSettings, childEnv);
    const fileSystem = yield* FileSystem.FileSystem;
    const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "circe-semantic-" });
    return yield* textGeneration.generateStructured({
      cwd,
      prompt,
      outputSchema: CirceSemanticProposal,
      modelSelection: {
        instanceId: supervisor.instanceId,
        model: supervisor.model,
        options: [{ id: "reasoningEffort", value: supervisor.effort }],
      },
    });
  });
  const withTimeout = Effect.timeoutOption(program, perCaseTimeoutMs);
  const scoped = Effect.scoped(withTimeout);
  const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "circe-semantic-eval-",
  }).pipe(Layer.provide(NodeServices.layer));
  const fullLayer = Layer.mergeAll(NodeServices.layer, serverConfigLayer);
  const full = Effect.provide(scoped, fullLayer);
  const semanticStart = performance.now();
  const output = await Effect.runPromise(full);
  const semanticMs = performance.now() - semanticStart;
  if (Option.isNone(output))
    throw new Error(`Semantic supervisor timed out after ${perCaseTimeoutMs}ms.`);
  return { proposal: output.value, semanticMs };
}

const stamp = (): string => DateTime.formatIso(DateTime.nowUnsafe()).replace(/[:.]/gu, "-");

try {
  for (const [index, entry] of selectedCases.entries()) {
    if (performance.now() - startedAt > budgetMs) {
      timedOut = true;
      process.stderr.write(
        `budget ${budgetMs}ms exceeded at case ${index + 1}/${selectedCases.length}\n`,
      );
      break;
    }
    if (replayDir !== undefined) {
      const capturedPath = NodePath.join(replayDir, `${entry.id}.json`);
      if (!NodeFS.existsSync(capturedPath)) {
        results.push({
          id: entry.id,
          split: entry.split,
          family: entry.family,
          category: entry.category,
          mode: "captured-replay",
          verdict: "error",
          expectedAction: entry.action,
          replayedFrom: replayDir,
          error: `No captured proposal at ${capturedPath}.`,
        });
        if (!jsonOutput)
          process.stdout.write(`[${index + 1}/${selectedCases.length}] ${entry.id}: ERROR\n`);
        continue;
      }
      try {
        const raw = JSON.parse(NodeFS.readFileSync(capturedPath, "utf8"));
        const result = scoreProposal(
          {
            id: entry.id,
            utterance: entry.utterance,
            action: entry.action,
            family: entry.family,
            split: entry.split,
            category: entry.category,
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
            legacyFixture: entry.legacyFixture,
          },
          raw,
          "captured-replay",
        );
        const carried =
          replayDurations.get(entry.id) ?? replayDurations.get(entry.id.split("__r")[0]!);
        results.push({
          ...result,
          replayedFrom: replayDir,
          ...(carried === undefined
            ? {}
            : { semanticMs: carried, semanticMsSource: "original-live" as const }),
        });
        if (!jsonOutput) {
          process.stdout.write(
            `[${index + 1}/${selectedCases.length}] ${entry.id}: REPLAY-${result.verdict === "pass" ? "PASS" : result.verdict.toUpperCase()} (${result.actualAction ?? "decode-error"})\n`,
          );
        }
      } catch (error) {
        results.push({
          id: entry.id,
          split: entry.split,
          family: entry.family,
          category: entry.category,
          mode: "captured-replay",
          verdict: "error",
          expectedAction: entry.action,
          replayedFrom: replayDir,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      continue;
    }
    if (offline) {
      if (entry.proposal === undefined) {
        results.push({
          id: entry.id,
          split: entry.split,
          family: entry.family,
          category: entry.category,
          mode: "offline-skipped",
          verdict: "skipped",
          expectedAction: entry.action,
        });
        if (!jsonOutput)
          process.stdout.write(
            `[${index + 1}/${selectedCases.length}] ${entry.id}: SKIP (no fixture)\n`,
          );
        continue;
      }
      const result = scoreProposal(
        {
          id: entry.id,
          utterance: entry.utterance,
          action: entry.action,
          family: entry.family,
          split: entry.split,
          category: entry.category,
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
          legacyFixture: entry.legacyFixture,
        },
        entry.proposal,
        "offline-fixture",
      );
      results.push(result);
      if (!jsonOutput) {
        process.stdout.write(
          `[${index + 1}/${selectedCases.length}] ${entry.id}: ${result.verdict === "pass" ? "PASS" : result.verdict.toUpperCase()} (${result.actualAction ?? "decode-error"})\n`,
        );
      }
      continue;
    }
    const context = buildEvalContext({
      utterance: entry.utterance,
      aliases: entry.context?.aliases,
      voice: entry.context?.voice,
      pendingApproval: entry.context?.pendingApproval,
      continueContext: entry.context?.continueContext ?? entry.continueContext,
    });
    const prepared = prepareCirceSemanticTurn(context);
    if (prepared.status !== "ready") {
      results.push({
        id: entry.id,
        split: entry.split,
        family: entry.family,
        category: entry.category,
        mode: "live",
        verdict: "error",
        expectedAction: entry.action,
        clarification: prepared.reason,
        error: "The deterministic preflight rejected the eval fixture.",
      });
      continue;
    }
    if (keepArtifacts) {
      NodeFS.writeFileSync(
        NodePath.join(directory, `${entry.id}.prompt.txt`),
        buildCirceSemanticPrompt(context, prepared),
        "utf8",
      );
    }
    try {
      const { proposal, semanticMs } = await runLiveProposal(entry, timeoutMs);
      if (keepArtifacts) {
        NodeFS.writeFileSync(
          NodePath.join(directory, `${entry.id}.json`),
          JSON.stringify(proposal),
          "utf8",
        );
      }
      const result = scoreProposal(
        {
          id: entry.id,
          utterance: entry.utterance,
          action: entry.action,
          family: entry.family,
          split: entry.split,
          category: entry.category,
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
          legacyFixture: entry.legacyFixture,
        },
        proposal,
        "live",
      );
      results.push({ ...result, semanticMs });
      if (!jsonOutput) {
        process.stdout.write(
          `[${index + 1}/${selectedCases.length}] ${entry.id}: ${result.verdict === "pass" ? "PASS" : result.verdict.toUpperCase()} (${result.actualAction ?? "decode-error"})\n`,
        );
      }
    } catch (error) {
      results.push({
        id: entry.id,
        split: entry.split,
        family: entry.family,
        category: entry.category,
        mode: "live",
        verdict: "error",
        expectedAction: entry.action,
        error: error instanceof Error ? error.message : String(error),
      });
      if (!jsonOutput)
        process.stdout.write(`[${index + 1}/${selectedCases.length}] ${entry.id}: ERROR\n`);
    }
  }
} finally {
  if (keepArtifacts) {
    try {
      NodeFS.mkdirSync(artifactsDir, { recursive: true });
      const keepDir = NodePath.join(artifactsDir, `circe-semantic-eval-${stamp()}`);
      NodeFS.mkdirSync(keepDir, { recursive: true });
      for (const name of NodeFS.readdirSync(directory)) {
        NodeFS.copyFileSync(NodePath.join(directory, name), NodePath.join(keepDir, name));
      }
      process.stderr.write(`kept eval artifacts in ${keepDir}\n`);
    } catch (error) {
      process.stderr.write(
        `could not keep eval artifacts: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }
  NodeFS.rmSync(directory, { recursive: true, force: true });
}

const metric = (
  key:
    | "actionCorrect"
    | "taskCorrect"
    | "projectCorrect"
    | "providerCorrect"
    | "commandCorrect"
    | "targetCorrect"
    | "instructionCorrect"
    | "clarificationCorrect"
    | "ackCorrect",
) => {
  const values = results.flatMap((result) =>
    result[key] === undefined ? [] : [result[key] === true],
  );
  return {
    correct: values.filter(Boolean).length,
    total: values.length,
    accuracy: values.length === 0 ? null : values.filter(Boolean).length / values.length,
  };
};
const verdicts: Record<string, number> = {};
for (const result of results) verdicts[result.verdict] = (verdicts[result.verdict] ?? 0) + 1;
const byFamily: Record<
  string,
  { total: number; passed: number; passRate: number | null; verdicts: Record<string, number> }
> = {};
for (const result of results) {
  const family = String(result.family);
  const slot = byFamily[family] ?? { total: 0, passed: 0, passRate: null, verdicts: {} };
  slot.total += 1;
  if (result.verdict === "pass") slot.passed += 1;
  slot.verdicts[result.verdict] = (slot.verdicts[result.verdict] ?? 0) + 1;
  byFamily[family] = slot;
}
for (const slot of Object.values(byFamily))
  slot.passRate = slot.total === 0 ? null : slot.passed / slot.total;
const fullCommand = (() => {
  const scored = results.filter(
    (result) => result.verdict !== "skipped" && result.verdict !== "skipped-legacy",
  );
  const full = scored.filter(
    (result) =>
      result.verdict === "pass" &&
      (result.actionCorrect ?? true) &&
      (result.targetCorrect ?? result.commandCorrect ?? true) &&
      (result.instructionCorrect ?? true),
  );
  return {
    correct: full.length,
    total: scored.length,
    accuracy: scored.length === 0 ? null : full.length / scored.length,
  };
})();
const skipped = results.filter(
  (result) => result.verdict === "skipped" || result.verdict === "skipped-legacy",
).length;
const legacySkipped = results.filter((result) => result.verdict === "skipped-legacy").length;
const errored = results.filter((result) => result.verdict === "error");
const repeatGroups = (() => {
  const groups = new Map<string, Array<EvalResult>>();
  for (const result of results) {
    const baseId = result.id.includes("__r") ? result.id.split("__r")[0]! : null;
    if (baseId === null) continue;
    const list = groups.get(baseId) ?? [];
    list.push(result);
    groups.set(baseId, list);
  }
  return [...groups.values()];
})();
const gate = gateThresholds(results, repeatGroups);
const timed = results.filter(
  (result): result is EvalResult & { directorMs: number } =>
    result.verdict !== "error" &&
    result.verdict !== "skipped" &&
    result.verdict !== "skipped-legacy" &&
    typeof result.directorMs === "number",
);
const semanticTimed = timed.filter(
  (result): result is EvalResult & { directorMs: number; semanticMs: number } =>
    typeof result.semanticMs === "number",
);
const sum = (values: ReadonlyArray<number>): number =>
  values.reduce((total, value) => total + value, 0);
const uncertaintySamples = results
  .filter((result) => result.clarification !== undefined)
  .slice(0, 20)
  .map((result) => ({
    id: result.id,
    family: result.family,
    clarification: result.clarification,
    expectedAction: result.expectedAction,
    actualAction: result.actualAction,
  }));
const report = {
  split: splitFilter,
  mode: replayDir !== undefined ? "replay" : offline ? "offline" : "live",
  supervisor:
    liveState.supervisor === null
      ? { mode: "isolated-fixture" as const }
      : {
          instanceId: String(liveState.supervisor.instanceId),
          model: liveState.supervisor.model,
          effort: liveState.supervisor.effort,
          source: liveState.supervisor.source,
          ...(liveState.binary === undefined ? {} : { binary: liveState.binary }),
        },
  ...(replayDir === undefined
    ? {}
    : {
        replayedFrom: replayDir,
        replayNote:
          "Captured-proposal rescore under the current contract and corpus; not a live model measurement.",
      }),
  ...(sourceReportPath === undefined ? {} : { sourceReport: sourceReportPath }),
  ...(splitFilter === "final" || splitFilter === "all" ? { finalDir, includeRepeats } : {}),
  thresholds: {
    exclusionDispatch: 0,
    textCorruption: 0,
    crossNodeViolation: 0,
    staleSpeech: 0,
    completePassRate: 0.95,
    unnecessaryClarificationRate: 0.05,
    ambiguityAccuracy: 0.95,
    repeatConsistency: 1,
  },
  gate,
  cases: results.length,
  scored: results.length - skipped - errored.length,
  skipped,
  legacySkipped,
  passed: results.filter((result) => result.verdict === "pass").length,
  verdicts,
  byFamily,
  fullCommand,
  action: metric("actionCorrect"),
  taskSelection: metric("taskCorrect"),
  projectSelection: metric("projectCorrect"),
  providerSelection: metric("providerCorrect"),
  commandShape: metric("commandCorrect"),
  groundedTarget: metric("targetCorrect"),
  instructionFidelity: metric("instructionCorrect"),
  ack: metric("ackCorrect"),
  ackFallbacks: results.filter((result) => result.ackFallback === true).length,
  clarification: metric("clarificationCorrect"),
  uncertaintySamples,
  repeatGroups: repeatGroups.map((group) => ({
    base: group[0]!.id.split("__r")[0],
    runs: group.length,
    consistent: group.every(
      (result) =>
        `${result.verdict}:${result.actualAction ?? ""}` ===
        `${group[0]!.verdict}:${group[0]!.actualAction ?? ""}`,
    ),
    verdicts: group.map((result) => result.verdict),
  })),
  timing: {
    cases: timed.length,
    totalDirectorMs: sum(timed.map((result) => result.directorMs)),
    maxDirectorMs:
      timed.length === 0 ? null : Math.max(...timed.map((result) => result.directorMs)),
    semanticCases: semanticTimed.length,
    totalSemanticMs: sum(semanticTimed.map((result) => result.semanticMs)),
    maxSemanticMs:
      semanticTimed.length === 0
        ? null
        : Math.max(...semanticTimed.map((result) => result.semanticMs)),
    timeoutMs,
    budgetMs,
    timedOut,
  },
  errorTiming: {
    cases: errored.length,
    totalSemanticMs: sum(
      errored.flatMap((result) =>
        typeof result.semanticMs === "number" ? [result.semanticMs] : [],
      ),
    ),
  },
  clarificationRate:
    results.length === 0
      ? null
      : results.filter((result) => result.clarification !== undefined).length / results.length,
  errors: results.filter((result) => result.error !== undefined).length,
  results,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
try {
  NodeFS.mkdirSync(artifactsDir, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(artifactsDir, `circe-semantic-eval-report-${stamp()}.json`),
    JSON.stringify(report),
    "utf8",
  );
} catch (error) {
  process.stderr.write(
    `could not write eval report: ${error instanceof Error ? error.message : String(error)}\n`,
  );
}
if (report.errors > 0) process.exitCode = 1;
if (failOnThreshold && !gate.pass) process.exitCode = 1;
