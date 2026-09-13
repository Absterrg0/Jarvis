#!/usr/bin/env node
// OFFLINE extraction-to-Director eval. No model, no training, no inference.
//
// Scores actual candidate predictions through the shared production path:
// adaptExtractionProposal -> prepareCirceSemanticTurn -> interpretCirceCommand.
// Expected full commands come only from the external fixture file, never
// from production helpers. Fixtures live outside Git and are marked
// synthetic-external-unreviewed in every report.
//
// This covers the path the training owner's scripts/circe-extract/evaluate.py
// does not: that script scores extractor spans and policy actions only. It
// never runs the shared Director, so Director routing, instruction, provider,
// and needs-input behavior for extractor output was unmeasured until this file.
//
// Single-node fixture, stated plainly: dispatchScope "local" means the
// Director accepted on the fixed synthetic catalog below, "none" means it
// refused. This is not a multi-node mesh evaluation; TaskRefs here carry no
// node qualification.
//
// Usage:
//   node apps/server/scripts/evalExtractionDirector.ts \
//     --fixtures /tmp/opencode/extraction-director-fixtures.jsonl [--limit <n>] [--json] [--out <report.json>]
//
// Fixture JSONL, one object per line, all fields required:
//   {
//     "id": "ext-001",
//     "source": "Fix authentication.",
//     "prediction": { "text": "Fix authentication.", "action": "start", "spans": [] },
//     "expected": {
//       "action": "start", "dispatchScope": "local", "project": "Beacon",
//       "task": null, "instruction": "Fix authentication.",
//       "provider": "Codex", "needsInputReason": null
//     }
//   }
// Expected needsInputReason is null for accepted turns, otherwise the exact
// adapter rejection reason (malformed, out-of-bounds, overlap,
// unknown-action, node-routing, ambiguous) or Director reason
// (control-target-required, unsupported-command, provider-not-found, ...).
// Keep fixtures and reports under /tmp/opencode: never commit them.
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/unstable/cli";

import {
  decodeJsonResult,
  formatSchemaError,
  fromJsonStringPretty,
} from "@t3tools/shared/schemaJson";
import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationProjectShell,
  type ServerProvider,
} from "@t3tools/contracts";
import { adaptExtractionProposal } from "@circe/core/extraction";
import {
  interpretCirceCommand,
  prepareCirceSemanticTurn,
  type CirceCommand,
  type CirceCommandContext,
  type CirceCommandTask,
} from "@circe/core/command";

export class ExtractionDirectorFixturesMissingError extends Schema.TaggedError<ExtractionDirectorFixturesMissingError>()(
  "ExtractionDirectorFixturesMissingError",
  {
    fixturesPath: Schema.String,
  },
) {
  override get message(): string {
    return `Missing actual candidate predictions: no readable fixture file at '${this.fixturesPath}'. Pass --fixtures <outside-git.jsonl>.`;
  }
}

export class ExtractionDirectorFixtureRowError extends Schema.TaggedError<ExtractionDirectorFixtureRowError>()(
  "ExtractionDirectorFixtureRowError",
  {
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export class ExtractionDirectorGitCheckoutError extends Schema.TaggedError<ExtractionDirectorGitCheckoutError>()(
  "ExtractionDirectorGitCheckoutError",
  {
    label: Schema.String,
    targetPath: Schema.String,
  },
) {
  override get message(): string {
    return `${this.label} ${this.targetPath} is inside the Git checkout; keep synthetic external data and reports outside Git (for example /tmp/opencode).`;
  }
}

export class ExtractionDirectorLimitError extends Schema.TaggedError<ExtractionDirectorLimitError>()(
  "ExtractionDirectorLimitError",
  {
    limit: Schema.Number,
  },
) {
  override get message(): string {
    return `--limit must be a positive integer, got ${this.limit}.`;
  }
}

/**
 * Fixed single-node fixture constraint. "local" means the Director accepted
 * on the synthetic catalog below; "none" means it refused. Not a mesh route:
 * nothing here evaluates node-qualified identities.
 */
const DispatchScope = Schema.Literals(["local", "none"]);
export type DispatchScope = typeof DispatchScope.Type;

const NonEmptyOrNull = Schema.Union([Schema.NonEmptyString, Schema.Null]);

const ExtractionDirectorExpected = Schema.Struct({
  action: Schema.NonEmptyString,
  dispatchScope: DispatchScope,
  project: NonEmptyOrNull,
  task: NonEmptyOrNull,
  instruction: NonEmptyOrNull,
  provider: NonEmptyOrNull,
  needsInputReason: NonEmptyOrNull,
});
export type ExtractionDirectorExpected = typeof ExtractionDirectorExpected.Type;

const ExtractionDirectorLineInput = Schema.Struct({
  id: Schema.NonEmptyString,
  source: Schema.NonEmptyString,
  prediction: Schema.optional(Schema.Unknown),
  expected: Schema.optional(Schema.Unknown),
});
export type ExtractionDirectorLineInput = typeof ExtractionDirectorLineInput.Type;

const decodeLineInput = decodeJsonResult(ExtractionDirectorLineInput);
const decodeExpected = Schema.decodeUnknownExit(ExtractionDirectorExpected);
export const encodeExtractionDirectorLineInput = Schema.encodeSync(
  Schema.fromJsonString(ExtractionDirectorLineInput),
);

export type ExtractionDirectorFixtureRow = {
  readonly id: string;
  readonly source: string;
  readonly prediction: unknown;
  readonly expected: ExtractionDirectorExpected;
};

export type ExtractionDirectorScoredRow = {
  readonly id: string;
  readonly accepted: boolean;
  readonly useful: boolean;
  readonly wrong: boolean;
  readonly actualAction: string | null;
  readonly actualDispatchScope: DispatchScope;
  readonly actualProject: string | null;
  readonly actualTask: string | null;
  readonly actualInstruction: string | null;
  readonly actualProvider: string | null;
  readonly actualReason: string | null;
  readonly actionCorrect: boolean;
  readonly dispatchScopeCorrect: boolean;
  readonly projectCorrect: boolean;
  readonly taskCorrect: boolean;
  readonly instructionCorrect: boolean;
  readonly providerCorrect: boolean;
  readonly needsInputCorrect: boolean;
};

export type ExtractionDirectorSummary = {
  readonly all: number;
  readonly accepted: number;
  readonly wrong: number;
  readonly useful: number;
  readonly coverage: number | null;
  readonly needsInput: number;
  readonly actionCorrect: number;
  readonly dispatchScopeCorrect: number;
  readonly projectCorrect: number;
  readonly taskCorrect: number;
  readonly instructionCorrect: number;
  readonly providerCorrect: number;
  readonly needsInputCorrect: number;
  readonly reasons: Record<string, number>;
};

// Synthetic eval catalog. Never shipped, never persisted. Titles are the
// only strings fixtures may expect.
const SYNTHETIC_PROJECT_CIRCE: OrchestrationProjectShell = {
  id: ProjectId.make("extraction-director-project-beacon"),
  title: "Beacon",
  workspaceRoot: "/synthetic/circe",
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};

const SYNTHETIC_PROJECT_RIVVL: OrchestrationProjectShell = {
  id: ProjectId.make("extraction-director-project-rivvl"),
  title: "Rivvl",
  workspaceRoot: "/synthetic/rivvl",
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};

const SYNTHETIC_CODEX: ServerProvider = {
  instanceId: ProviderInstanceId.make("extraction-director-codex"),
  driver: ProviderDriverKind.make("codex"),
  displayName: "Codex",
  enabled: true,
  installed: true,
  version: "synthetic",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-09-01T00:00:00.000Z",
  models: [
    {
      slug: "gpt-5.6-luna",
      name: "GPT-5.6 Luna",
      shortName: "Luna",
      isCustom: false,
      isDefault: true,
      capabilities: null,
    },
  ],
  slashCommands: [],
  skills: [],
};

const SYNTHETIC_CLAUDE: ServerProvider = {
  ...SYNTHETIC_CODEX,
  instanceId: ProviderInstanceId.make("extraction-director-claude"),
  driver: ProviderDriverKind.make("claude"),
  displayName: "Claude",
  models: [
    {
      slug: "claude-sonnet",
      name: "Claude Sonnet",
      shortName: "Sonnet",
      isCustom: false,
      isDefault: true,
      capabilities: null,
    },
  ],
};

const SYNTHETIC_TASK_AUTH: CirceCommandTask = {
  threadId: ThreadId.make("extraction-director-thread-auth"),
  projectId: SYNTHETIC_PROJECT_RIVVL.id,
  projectTitle: "Rivvl",
  title: "Rivvl authentication",
  objective: "Fix token refresh and login redirects",
  state: "running",
};

const SYNTHETIC_TASK_DOCS: CirceCommandTask = {
  threadId: ThreadId.make("extraction-director-thread-docs"),
  projectId: SYNTHETIC_PROJECT_CIRCE.id,
  projectTitle: "Beacon",
  title: "Release docs",
  objective: "Write the release and upgrade documentation",
  state: "ready",
};

const SYNTHETIC_PROJECTS = [SYNTHETIC_PROJECT_CIRCE, SYNTHETIC_PROJECT_RIVVL] as const;
const SYNTHETIC_PROVIDERS = [SYNTHETIC_CODEX, SYNTHETIC_CLAUDE] as const;
const SYNTHETIC_TASKS = [SYNTHETIC_TASK_AUTH, SYNTHETIC_TASK_DOCS] as const;

export function buildExtractionDirectorContext(utterance: string): CirceCommandContext {
  return {
    utterance,
    currentProjectId: SYNTHETIC_PROJECT_CIRCE.id,
    projects: [...SYNTHETIC_PROJECTS],
    aliases: [],
    tasks: SYNTHETIC_TASKS.map((task) => ({
      threadId: task.threadId,
      projectId: task.projectId,
      title: task.title,
      objective: task.objective,
      state: task.state,
    })),
    recentCommandTasks: [...SYNTHETIC_TASKS],
    focusedTask: SYNTHETIC_TASK_DOCS,
    contextTask: SYNTHETIC_TASK_DOCS,
    providers: [...SYNTHETIC_PROVIDERS],
    supervisorModelSelection: {
      instanceId: SYNTHETIC_CODEX.instanceId,
      model: "gpt-5.6-luna",
    },
    nodeDefaultModelSelection: {
      instanceId: SYNTHETIC_CODEX.instanceId,
      model: "gpt-5.6-luna",
    },
    continueContext: false,
  };
}

function projectTitleById(id: unknown): string | null {
  const hit = SYNTHETIC_PROJECTS.find((project) => String(project.id) === String(id));
  return hit?.title ?? null;
}

function taskByThread(id: unknown): CirceCommandTask | null {
  const hit = SYNTHETIC_TASKS.find((task) => String(task.threadId) === String(id));
  return hit ?? null;
}

function actualInstructionFor(command: CirceCommand): string | null {
  switch (command.type) {
    case "start":
      return command.objective;
    case "review":
      return command.objective;
    case "continue":
      return command.instruction;
    case "queue":
      return command.instruction;
    case "answer":
      return command.instruction;
    case "converse":
      return command.instruction;
    default:
      return null;
  }
}

function actualProjectFor(command: CirceCommand): string | null {
  switch (command.type) {
    case "start":
      return projectTitleById(command.projectId);
    case "review":
      return projectTitleById(command.projectId);
    case "reroute":
      return projectTitleById(command.targetProjectId);
    case "switch-focus":
      return command.target.type === "project"
        ? projectTitleById(command.target.projectId)
        : (taskByThread(command.target.task.threadId)?.projectTitle ?? null);
    case "continue":
    case "queue":
    case "stop":
    case "status":
    case "answer":
      return taskByThread(command.task.threadId)?.projectTitle ?? null;
    default:
      return null;
  }
}

function actualTaskFor(command: CirceCommand): string | null {
  switch (command.type) {
    case "continue":
    case "queue":
    case "stop":
    case "status":
    case "answer":
      return taskByThread(command.task.threadId)?.title ?? null;
    case "review":
      return taskByThread(command.sourceTask.threadId)?.title ?? null;
    case "reroute":
      return taskByThread(command.sourceTask.threadId)?.title ?? null;
    case "switch-focus":
      return command.target.type === "project"
        ? null
        : (taskByThread(command.target.task.threadId)?.title ?? null);
    default:
      return null;
  }
}

function actualProviderFor(command: CirceCommand): string | null {
  if (command.type !== "start" && command.type !== "review") return null;
  const hit = SYNTHETIC_PROVIDERS.find(
    (provider) => String(provider.instanceId) === String(command.modelSelection.instanceId),
  );
  return hit ? (hit.displayName ?? String(hit.driver)) : String(command.modelSelection.instanceId);
}

const ActionCarrier = Schema.Struct({ action: Schema.String });
const isActionCarrier = Schema.is(ActionCarrier);

function predictionActionOf(prediction: unknown): string | null {
  if (!isActionCarrier(prediction)) return null;
  return prediction.action;
}

const TextCarrier = Schema.Struct({ text: Schema.String });
const isTextCarrier = Schema.is(TextCarrier);

/** Decode one JSONL line. Expected stays literal: never derived from helpers. */
const decodeExtractionLine = (
  line: string,
  lineNumber: number,
): Result.Result<ExtractionDirectorFixtureRow, string> => {
  const input = decodeLineInput(line);
  if (!Result.isSuccess(input)) {
    return Result.fail(
      `fixture line ${lineNumber}: invalid fixture row (${formatSchemaError(input.failure)}); each line needs id, source, prediction, and expected.`,
    );
  }
  const row = input.success;
  if (row.prediction === undefined) {
    return Result.fail(
      `fixture ${row.id}: missing actual candidate predictions; every row needs a prediction object with text, action, and spans.`,
    );
  }
  if (row.expected === undefined) {
    return Result.fail(
      `fixture ${row.id}: missing expected full command; every row needs an expected object.`,
    );
  }
  const expected = decodeExpected(row.expected);
  if (Exit.isFailure(expected)) {
    return Result.fail(
      `fixture ${row.id}: invalid expected full command (${formatSchemaError(expected.cause)}); expected stays literal, never derived.`,
    );
  }
  return Result.succeed({
    id: row.id,
    source: row.source,
    prediction: row.prediction,
    expected: expected.value,
  });
};

export function parseExtractionDirectorLine(
  line: string,
  lineNumber: number,
): ExtractionDirectorFixtureRow {
  const result = decodeExtractionLine(line, lineNumber);
  if (!Result.isSuccess(result)) throw new Error(result.failure);
  return result.success;
}

/** Reject missing/duplicate ids and prediction text that does not cover the source. */
const checkExtractionSet = (
  rows: ReadonlyArray<ExtractionDirectorFixtureRow>,
): Result.Result<void, string> => {
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.id)) return Result.fail(`duplicate fixture id: ${row.id}.`);
    seen.add(row.id);
    if (!isTextCarrier(row.prediction)) {
      return Result.fail(
        `fixture ${row.id}: missing actual candidate predictions; prediction.text must be a string.`,
      );
    }
    if (row.prediction.text !== row.source) {
      return Result.fail(
        `fixture ${row.id}: source mismatch; prediction.text must equal source exactly for coverage.`,
      );
    }
  }
  return Result.succeed(undefined);
};

export function validateExtractionDirectorSet(
  rows: ReadonlyArray<ExtractionDirectorFixtureRow>,
): void {
  const result = checkExtractionSet(rows);
  if (!Result.isSuccess(result)) throw new Error(result.failure);
}

/** Run one row through the actual shared path: adapter then Director. */
export function scoreExtractionDirectorRow(
  row: ExtractionDirectorFixtureRow,
): ExtractionDirectorScoredRow {
  const adapted = adaptExtractionProposal(row.prediction);
  if (adapted.status === "rejected") {
    const actualAction = predictionActionOf(row.prediction);
    const actualDispatchScope: DispatchScope = "none";
    return {
      id: row.id,
      accepted: false,
      useful: false,
      wrong: false,
      actualAction,
      actualDispatchScope,
      actualProject: null,
      actualTask: null,
      actualInstruction: null,
      actualProvider: null,
      actualReason: adapted.reason,
      actionCorrect: actualAction === row.expected.action,
      dispatchScopeCorrect: actualDispatchScope === row.expected.dispatchScope,
      projectCorrect: row.expected.project === null,
      taskCorrect: row.expected.task === null,
      instructionCorrect: row.expected.instruction === null,
      providerCorrect: row.expected.provider === null,
      needsInputCorrect:
        row.expected.needsInputReason !== null && adapted.reason === row.expected.needsInputReason,
    };
  }
  const actualAction = adapted.proposal.action;
  const context = buildExtractionDirectorContext(row.source);
  const prepared = prepareCirceSemanticTurn(context);
  if (prepared.status !== "ready") {
    const actualDispatchScope: DispatchScope = "none";
    return {
      id: row.id,
      accepted: false,
      useful: false,
      wrong: false,
      actualAction,
      actualDispatchScope,
      actualProject: null,
      actualTask: null,
      actualInstruction: null,
      actualProvider: null,
      actualReason: prepared.reason,
      actionCorrect: actualAction === row.expected.action,
      dispatchScopeCorrect: actualDispatchScope === row.expected.dispatchScope,
      projectCorrect: row.expected.project === null,
      taskCorrect: row.expected.task === null,
      instructionCorrect: row.expected.instruction === null,
      providerCorrect: row.expected.provider === null,
      needsInputCorrect:
        row.expected.needsInputReason !== null && prepared.reason === row.expected.needsInputReason,
    };
  }
  const interpretation = interpretCirceCommand(context, prepared, adapted.proposal);
  if (interpretation.status === "needs-input") {
    const actualDispatchScope: DispatchScope = "none";
    return {
      id: row.id,
      accepted: false,
      useful: false,
      wrong: false,
      actualAction,
      actualDispatchScope,
      actualProject: null,
      actualTask: null,
      actualInstruction: null,
      actualProvider: null,
      actualReason: interpretation.reason,
      actionCorrect: actualAction === row.expected.action,
      dispatchScopeCorrect: actualDispatchScope === row.expected.dispatchScope,
      projectCorrect: row.expected.project === null,
      taskCorrect: row.expected.task === null,
      instructionCorrect: row.expected.instruction === null,
      providerCorrect: row.expected.provider === null,
      needsInputCorrect:
        row.expected.needsInputReason !== null &&
        interpretation.reason === row.expected.needsInputReason,
    };
  }
  const command = interpretation.command;
  const actualDispatchScope: DispatchScope = "local";
  const actualProject = actualProjectFor(command);
  const actualTask = actualTaskFor(command);
  const actualInstruction = actualInstructionFor(command);
  const actualProvider = actualProviderFor(command);
  const actionCorrect = actualAction === row.expected.action;
  const dispatchScopeCorrect = actualDispatchScope === row.expected.dispatchScope;
  const projectCorrect = actualProject === row.expected.project;
  const taskCorrect = actualTask === row.expected.task;
  const instructionCorrect = actualInstruction === row.expected.instruction;
  const providerCorrect = actualProvider === row.expected.provider;
  const expectsAccepted = row.expected.needsInputReason === null;
  const useful =
    expectsAccepted &&
    actionCorrect &&
    dispatchScopeCorrect &&
    projectCorrect &&
    taskCorrect &&
    instructionCorrect &&
    providerCorrect;
  return {
    id: row.id,
    accepted: true,
    useful,
    wrong: !useful,
    actualAction,
    actualDispatchScope,
    actualProject,
    actualTask,
    actualInstruction,
    actualProvider,
    actualReason: null,
    actionCorrect,
    dispatchScopeCorrect,
    projectCorrect,
    taskCorrect,
    instructionCorrect,
    providerCorrect,
    needsInputCorrect: expectsAccepted,
  };
}

export function summarizeExtractionDirector(
  rows: ReadonlyArray<ExtractionDirectorScoredRow>,
): ExtractionDirectorSummary {
  const reasons: Record<string, number> = {};
  for (const row of rows) {
    if (!row.accepted && row.actualReason !== null) {
      reasons[row.actualReason] = (reasons[row.actualReason] ?? 0) + 1;
    }
  }
  const count = (pick: (row: ExtractionDirectorScoredRow) => boolean): number =>
    rows.filter(pick).length;
  const all = rows.length;
  const accepted = count((row) => row.accepted);
  return {
    all,
    accepted,
    wrong: count((row) => row.wrong),
    useful: count((row) => row.useful),
    coverage: all === 0 ? null : accepted / all,
    needsInput: all - accepted,
    actionCorrect: count((row) => row.actionCorrect),
    dispatchScopeCorrect: count((row) => row.dispatchScopeCorrect),
    projectCorrect: count((row) => row.projectCorrect),
    taskCorrect: count((row) => row.taskCorrect),
    instructionCorrect: count((row) => row.instructionCorrect),
    providerCorrect: count((row) => row.providerCorrect),
    needsInputCorrect: count((row) => row.needsInputCorrect),
    reasons,
  };
}

const rejectInsideGit = Effect.fn("rejectExtractionDirectorInsideGit")(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  label: string,
  target: string,
) {
  let dir = path.dirname(path.resolve(target));
  for (;;) {
    if (yield* fs.exists(path.join(dir, ".git"))) {
      return yield* new ExtractionDirectorGitCheckoutError({ label, targetPath: target });
    }
    const parent = path.dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
});

const formatReasons = (reasons: Record<string, number>): string =>
  Object.entries(reasons)
    .map(([reason, count]) => `${reason}=${count}`)
    .join(",");

const ReportPrettyJson = fromJsonStringPretty(Schema.Unknown);
const encodeReport = Schema.encodeEffect(ReportPrettyJson);

const EXTRACTION_DIRECTOR_LIMITATIONS = [
  "Single-node fixture: dispatchScope local means the Director accepted on the fixed synthetic catalog, none means it refused. This is not a multi-node mesh evaluation; TaskRefs here carry no node qualification.",
  "Synthetic catalog only: two projects (Beacon, Rivvl), two tasks, two providers. Expected names must match it.",
  "Instruction compares by exact string equality against the deterministic Director dispatch text.",
  "Provider compares only for start and review commands; every other command expects null.",
  "Offline with the model disabled. Counts only; no thresholds, no pass verdict.",
] as const;

export const evalExtractionDirectorCommand = Command.make(
  "eval-extraction-director",
  {
    fixtures: Flag.string("fixtures").pipe(
      Flag.withDefault("/tmp/opencode/extraction-director-fixtures.jsonl"),
      Flag.withDescription("External JSONL fixture file outside the Git checkout."),
    ),
    limit: Flag.integer("limit").pipe(
      Flag.withDefault(1000),
      Flag.withDescription("Maximum fixture rows to score."),
    ),
    json: Flag.boolean("json").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Print only the JSON report."),
    ),
    out: Flag.string("out").pipe(
      Flag.optional,
      Flag.withDescription("Write the JSON report outside the Git checkout."),
    ),
  },
  ({ fixtures, limit, json, out }) =>
    Effect.gen(function* () {
      if (!Number.isInteger(limit) || limit < 1) {
        return yield* new ExtractionDirectorLimitError({ limit });
      }
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* rejectInsideGit(fs, path, "fixtures path", fixtures);
      const outPath = Option.getOrUndefined(out);
      if (outPath !== undefined) yield* rejectInsideGit(fs, path, "report path", outPath);
      if (!(yield* fs.exists(fixtures))) {
        return yield* new ExtractionDirectorFixturesMissingError({ fixturesPath: fixtures });
      }
      const text = yield* fs
        .readFileString(fixtures)
        .pipe(
          Effect.mapError(
            () => new ExtractionDirectorFixturesMissingError({ fixturesPath: fixtures }),
          ),
        );
      const lines = text
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .slice(0, limit);
      if (lines.length === 0) {
        return yield* new ExtractionDirectorFixtureRowError({
          detail: `Missing actual candidate predictions: '${fixtures}' has no fixture rows. Each line needs id, source, prediction, and expected.`,
        });
      }
      const rows: Array<ExtractionDirectorFixtureRow> = [];
      for (const [index, line] of lines.entries()) {
        const decoded = decodeExtractionLine(line, index + 1);
        if (!Result.isSuccess(decoded)) {
          return yield* new ExtractionDirectorFixtureRowError({ detail: decoded.failure });
        }
        rows.push(decoded.success);
      }
      const checked = checkExtractionSet(rows);
      if (!Result.isSuccess(checked)) {
        return yield* new ExtractionDirectorFixtureRowError({ detail: checked.failure });
      }
      const scored = rows.map(scoreExtractionDirectorRow);
      const summary = summarizeExtractionDirector(scored);
      const report = {
        data: "synthetic-external-unreviewed",
        model: "disabled",
        scope: "single-node-fixture",
        limitations: [...EXTRACTION_DIRECTOR_LIMITATIONS],
        fixtures: path.resolve(fixtures),
        ...summary,
        rows: scored,
      };
      if (!json) {
        for (const row of scored) {
          const verdict = row.accepted ? (row.useful ? "USEFUL" : "WRONG") : "NEEDS-INPUT";
          yield* Console.log(
            `${row.id}: ${verdict} action=${row.actualAction ?? "none"} reason=${row.actualReason ?? "none"}`,
          );
        }
        yield* Console.log(
          `all=${summary.all} accepted=${summary.accepted} wrong=${summary.wrong} useful=${summary.useful} coverage=${summary.coverage === null ? "n/a" : summary.coverage.toFixed(3)} needs-input=${summary.needsInput} reasons=${formatReasons(summary.reasons)}`,
        );
      }
      yield* Console.log(yield* encodeReport(report));
      if (outPath !== undefined) {
        yield* fs.makeDirectory(path.dirname(path.resolve(outPath)), { recursive: true });
        yield* fs.writeFileString(outPath, `${yield* encodeReport(report)}\n`);
      }
    }),
).pipe(
  Command.withDescription(
    "Offline extraction-to-Director eval through adaptExtractionProposal -> interpretCirceCommand. Model disabled: no model flags exist. Training-owner evaluate.py scores extractor spans only and never runs this Director path.",
  ),
);

if (import.meta.main) {
  Command.run(evalExtractionDirectorCommand, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
