// @effect-diagnostics nodeBuiltinImport:off - the offline real-python protocol probe drives one bounded child through Node APIs.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type JarvisSemanticProposal,
  type OrchestrationProjectShell,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import * as ServerConfig from "../config.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import * as ServerSettingsModule from "../serverSettings.ts";
import { TextGeneration } from "../textGeneration/TextGeneration.ts";
import { JarvisControllerInterpreter } from "./Services/JarvisController.ts";
import { JarvisLocalModel, isLocalModelQualityEligible } from "./Services/JarvisLocalModel.ts";
import {
  JarvisLocalModelLive,
  defaultInferenceScriptForDirname,
  resolveLocalModelOutcome,
  type RawExtractorJson,
} from "./Layers/JarvisLocalModel.ts";
import { makeJarvisControllerInterpreterLive } from "./Layers/JarvisController.ts";
import type { JarvisCommandContext } from "@t3tools/jarvis-core/command";
import {
  cancelPreAccept,
  makeJarvisRequestCancellationState,
  trackPreAccept,
} from "./requestCancellation.ts";

const encodeUnknownJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeUnknownJsonSync = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));

const jarvis: OrchestrationProjectShell = {
  id: ProjectId.make("project-jarvis"),
  title: "Jarvis",
  workspaceRoot: "/workspace/jarvis",
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-08-30T00:00:00.000Z",
  updatedAt: "2026-08-30T00:00:00.000Z",
};
const rivvl: OrchestrationProjectShell = {
  ...jarvis,
  id: ProjectId.make("project-rivvl"),
  title: "Rivvl",
  workspaceRoot: "/workspace/rivvl",
};

const codex: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  displayName: "Codex",
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-08-30T00:00:00.000Z",
  models: [
    {
      slug: "gpt-5.6-sol",
      name: "GPT-5.6 Sol",
      shortName: "Sol",
      isCustom: false,
      isDefault: true,
      capabilities: null,
    },
  ],
  slashCommands: [],
  skills: [],
};

const supervisorSelection = { instanceId: codex.instanceId, model: "gpt-5.6-sol" } as const;

// Multiword turn: outside the single-token grammar, so the cascade must
// consult the local tier before the one provider call.
// Outside the bounded grammar (too many words and clause connectors), so the
// local tier and provider tier own this turn. The bounded grammar handles
// short single-clause requests without any model.
const MULTIWORD =
  "Fix the very long auth flow with many retries and backoffs today please in Rivvl";

function context(utterance: string): JarvisCommandContext {
  return {
    utterance,
    currentProjectId: jarvis.id,
    projects: [jarvis, rivvl],
    aliases: [],
    tasks: [],
    recentCommandTasks: [
      {
        threadId: ThreadId.make("thread-rivvl-auth"),
        projectId: rivvl.id,
        projectTitle: rivvl.title,
        title: "Rivvl authentication",
        objective: "Fix token refresh",
        state: "running",
      },
    ],
    providers: [codex],
    supervisorModelSelection: supervisorSelection,
    nodeDefaultModelSelection: supervisorSelection,
    continueContext: false,
  };
}

const providerProposal: JarvisSemanticProposal = {
  action: "start",
  refs: [],
  model: null,
  effort: null,
  answer: null,
};

const testMetrics = (overrides: Record<string, unknown> = {}) => ({
  n: 200,
  raw_action_acc: 0.97,
  complete_frame_acc: 0.93,
  useful_auto: 0.85,
  wrong_auto: 0.005,
  accepted_error: 0.006,
  raw_bounds_bad: 0,
  clarify_rate: 0.1,
  wrong_auto_host: 0,
  truncated: 0,
  ...overrides,
});

const passingReport = (
  modelDir: string,
  policyPath: string,
  int8Overrides: Record<string, unknown> = {},
  fp32Overrides: Record<string, unknown> = {},
) => ({
  model_dir: modelDir,
  policy: policyPath,
  fp32: { test: testMetrics(fp32Overrides) },
  int8: { test: testMetrics(int8Overrides) },
});

// Rejected v077-small-s7 shape from the controller doc: int8 raw 0.62,
// frame 0.12, useful 0.10, wrong 0.21. Must stay ineligible.
const rejectedReport = () => ({
  model_dir: "/elsewhere/v077-small-s7",
  policy: "/elsewhere/v077-small-s7/policy-thresholds.json",
  fp32: {
    test: {
      n: 52,
      raw_action_acc: 0.65,
      complete_frame_acc: 0.14,
      useful_auto: 0.12,
      wrong_auto: 0.2,
      accepted_error: 0.65,
      raw_bounds_bad: 0,
      clarify_rate: 0.69,
      wrong_auto_host: 3,
      truncated: 0,
    },
  },
  int8: {
    test: {
      n: 52,
      raw_action_acc: 0.62,
      complete_frame_acc: 0.12,
      useful_auto: 0.1,
      wrong_auto: 0.21,
      accepted_error: 0.69,
      raw_bounds_bad: 0,
      clarify_rate: 0.69,
      wrong_auto_host: 3,
      truncated: 0,
    },
  },
});

interface MockHandleOptions {
  readonly stdout?: string;
  readonly exitCode?: number;
  readonly stall?: boolean;
  readonly running?: boolean;
  readonly onKill?: () => void;
}

const mockHandle = (options: MockHandleOptions = {}) =>
  ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode:
      options.stall === true
        ? Effect.never
        : Effect.succeed(ChildProcessSpawner.ExitCode(options.exitCode ?? 0)),
    isRunning: Effect.succeed(options.running ?? options.stall === true),
    kill: () =>
      Effect.sync(() => {
        options.onKill?.();
      }),
    unref: Effect.sync(() => Effect.void),
    stdin: Sink.drain,
    stdout:
      options.stall === true || options.stdout === undefined
        ? options.stall === true
          ? Stream.never
          : Stream.empty
        : Stream.make(new TextEncoder().encode(options.stdout)),
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });

const spawnerLayerFor = (
  handler: (command: ChildProcess.StandardCommand) => ReturnType<typeof mockHandle>,
) =>
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        assert.equal(ChildProcess.isStandardCommand(command), true);
        if (!ChildProcess.isStandardCommand(command)) {
          throw new Error("Expected a standard command");
        }
        return handler(command);
      }),
    ),
  );

interface FixtureInput {
  readonly modelDir: string;
  readonly evalPath: string;
  readonly policyPath: string;
  readonly timeoutMs?: number;
}

const configLayerFor = (input: FixtureInput) =>
  Layer.effect(
    ServerConfig.ServerConfig,
    Effect.gen(function* () {
      const base = yield* ServerConfig.ServerConfig;
      return {
        ...base,
        jarvisLocalModel: {
          enabled: true as const,
          modelDir: input.modelDir,
          pythonBin: "/custom/python",
          timeoutMs: input.timeoutMs ?? 5_000,
          evalReportPath: input.evalPath,
          policyPath: input.policyPath,
        },
      };
    }),
  ).pipe(
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "jarvis-local-tier-test-" })),
  );

const withConfig = (input: FixtureInput) =>
  Layer.provide(configLayerFor(input), NodeServices.layer);

const localFor = (
  handler: (command: ChildProcess.StandardCommand) => ReturnType<typeof mockHandle>,
) => JarvisLocalModelLive.pipe(Layer.provide(spawnerLayerFor(handler)));

const localSatisfiedFor = (
  handler: (command: ChildProcess.StandardCommand) => ReturnType<typeof mockHandle>,
  input: FixtureInput,
) =>
  // Layer.provide hides the dependency outputs, so this stays exactly
  // JarvisLocalModel while the config underneath carries file-system errors.
  localFor(handler).pipe(Layer.provide(NodeServices.layer), Layer.provide(withConfig(input)));

const providerLayerFor = (
  counter: { calls: number },
  proposal: JarvisSemanticProposal = providerProposal,
) => {
  const generation = TextGeneration.of({
    generateCommitMessage: () => Effect.die("unused"),
    generatePrContent: () => Effect.die("unused"),
    generateBranchName: () => Effect.die("unused"),
    generateThreadTitle: () => Effect.die("unused"),
    generateStructured: () => {
      counter.calls += 1;
      return Effect.succeed(proposal);
    },
  });
  return Layer.mock(ProviderRegistry)({
    getTextGenerationForInstance: () => Effect.succeed(generation),
  });
};

const interpreterWith = <E2>(
  counter: { calls: number },
  local: Layer.Layer<JarvisLocalModel, E2, never>,
  proposal: JarvisSemanticProposal = providerProposal,
) =>
  makeJarvisControllerInterpreterLive(providerLayerFor(counter, proposal), local).pipe(
    Layer.provide(NodeServices.layer),
    Layer.provideMerge(ServerSettingsModule.ServerSettingsService.layerTest()),
  );

const writeFixture = (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  report: (dir: string, policyPath: string) => unknown,
) =>
  Effect.gen(function* () {
    const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "jarvis-local-tier-" });
    const evalPath = path.join(dir, "eval.json");
    const policyPath = path.join(dir, "policy-thresholds.json");
    yield* fileSystem.writeFileString(evalPath, encodeUnknownJson(report(dir, policyPath)));
    yield* fileSystem.writeFileString(
      policyPath,
      encodeUnknownJson({ clarify_threshold: 0.9, token_threshold: 0.9, max_len: 96 }),
    );
    return { dir, evalPath, policyPath };
  });

describe("local model quality gate uses measured test metrics, not calibration flags", () => {
  it.effect("rejects the documented v077-small-s7 int8 artifact", () =>
    Effect.sync(() => {
      assert.equal(isLocalModelQualityEligible(rejectedReport()), false);
    }),
  );

  it.effect("rejects calibration-valid shapes with low useful coverage", () =>
    Effect.sync(() => {
      // Mirrors the root failure: valid thresholds with useful 15/140 must not
      // read as readiness. The gate needs useful >= .80 on held-out test.
      assert.equal(
        isLocalModelQualityEligible(
          passingReport("/m/dir", "/m/dir/policy-thresholds.json", {
            useful_auto: 15 / 140,
          }),
        ),
        false,
      );
    }),
  );

  it.effect("rejects reports with host errors even when the four frozen numbers pass", () =>
    Effect.sync(() => {
      assert.equal(
        isLocalModelQualityEligible(
          passingReport("/m/dir", "/m/dir/policy-thresholds.json", { wrong_auto_host: 2 }),
        ),
        false,
      );
    }),
  );

  it.effect("rejects span corruption and clarify collapse", () =>
    Effect.sync(() => {
      assert.equal(
        isLocalModelQualityEligible(
          passingReport("/m/dir", "/m/dir/policy-thresholds.json", { raw_bounds_bad: 1 }),
        ),
        false,
      );
      assert.equal(
        isLocalModelQualityEligible(
          passingReport("/m/dir", "/m/dir/policy-thresholds.json", { clarify_rate: 0.96 }),
        ),
        false,
      );
    }),
  );

  it.effect("rejects int8 regression beyond the frozen drop", () =>
    Effect.sync(() => {
      assert.equal(
        isLocalModelQualityEligible(
          passingReport("/m/dir", "/m/dir/policy-thresholds.json", { raw_action_acc: 0.9 }),
        ),
        false,
      );
    }),
  );

  it.effect("rejects arbitrary presence-only reports and calibration flags", () =>
    Effect.sync(() => {
      assert.equal(isLocalModelQualityEligible({}), false);
      assert.equal(isLocalModelQualityEligible({ ready: true }), false);
      assert.equal(
        isLocalModelQualityEligible({ status: "calibrated", valid: true, readiness: true }),
        false,
      );
      assert.equal(isLocalModelQualityEligible(null), false);
    }),
  );

  it.effect("accepts a report that clears every frozen check on both precisions", () =>
    Effect.sync(() => {
      assert.equal(
        isLocalModelQualityEligible(passingReport("/m/dir", "/m/dir/policy-thresholds.json")),
        true,
      );
    }),
  );

  it.effect("binds the report to the deployed model dir and policy path", () =>
    Effect.sync(() => {
      const dir = "/models/candidate-a";
      const policy = "/models/candidate-a/policy-thresholds.json";
      assert.equal(
        isLocalModelQualityEligible(passingReport(dir, policy), {
          modelDir: dir,
          policyPath: policy,
        }),
        true,
      );
      // Gating one candidate while inferring another stays ineligible.
      assert.equal(
        isLocalModelQualityEligible(passingReport(dir, policy), {
          modelDir: "/models/candidate-b",
          policyPath: policy,
        }),
        false,
      );
      assert.equal(
        isLocalModelQualityEligible(passingReport(dir, policy), {
          modelDir: dir,
          policyPath: "/models/candidate-a/thresholds.json",
        }),
        false,
      );
      // Reports without model_dir (pre-metadata evaluate.py) fail closed.
      const withoutDir = passingReport(dir, policy) as Record<string, unknown>;
      delete withoutDir.model_dir;
      assert.equal(
        isLocalModelQualityEligible(withoutDir, { modelDir: dir, policyPath: policy }),
        false,
      );
      const withoutPolicy = { ...passingReport(dir, policy), policy: null };
      assert.equal(
        isLocalModelQualityEligible(withoutPolicy, { modelDir: dir, policyPath: policy }),
        false,
      );
    }),
  );
});

describe("default inference script resolves to repo scripts, not apps scripts", () => {
  it.effect("walks five levels from the Layers directory", () =>
    Effect.sync(() => {
      const resolved = defaultInferenceScriptForDirname(
        "/repo/apps/server/src/jarvis/Layers",
        (...parts) => NodePath.posix.resolve(...parts),
      );
      assert.equal(resolved, "/repo/scripts/jarvis-extract/inference.py");
      assert.equal(resolved.includes("apps/scripts"), false);
    }),
  );
});

describe("local model spawns the real layer command", () => {
  it.effect("passes --int8 with the required --policy and the verbatim source", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { dir, evalPath, policyPath } = yield* writeFixture(fileSystem, path, (d, p) =>
        passingReport(d, p),
      );

      let captured: ChildProcess.StandardCommand | undefined;
      let kills = 0;
      const local = localSatisfiedFor(
        (command) => {
          captured = command;
          return mockHandle({
            stdout: encodeUnknownJson({ text: MULTIWORD, action: "status", spans: [] }),
            onKill: () => {
              kills += 1;
            },
          });
        },
        { modelDir: dir, evalPath, policyPath },
      );

      const outcome = yield* Effect.flatMap(JarvisLocalModel, (model) =>
        model.infer({ source: MULTIWORD }),
      ).pipe(Effect.provide(local));

      assert.ok(captured);
      const expectedScript = defaultInferenceScriptForDirname(
        NodePath.join(import.meta.dirname, "Layers"),
        (...parts) => NodePath.posix.resolve(...parts),
      );
      assert.deepEqual(captured.args, [
        expectedScript,
        "--model-dir",
        dir,
        "--int8",
        "--policy",
        policyPath,
        "--text",
        MULTIWORD,
      ]);
      assert.equal(captured.command, "/custom/python");
      const script = captured.args[0] ?? "";
      assert.equal(script.endsWith("scripts/jarvis-extract/inference.py"), true);
      assert.equal(script.includes("apps/scripts"), false);
      const policyFlag = captured.args.indexOf("--policy");
      assert.isAbove(policyFlag, -1);
      assert.equal(captured.args[policyFlag + 1], policyPath);
      assert.equal(outcome.status, "proposal");
      assert.equal(kills, 0);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("declines without spawning when the bound policy file is missing", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { dir, evalPath, policyPath } = yield* writeFixture(fileSystem, path, (d, p) =>
        passingReport(d, p),
      );
      yield* fileSystem.remove(policyPath);

      let spawns = 0;
      const local = localSatisfiedFor(
        () => {
          spawns += 1;
          return mockHandle({
            stdout: encodeUnknownJson({ text: MULTIWORD, action: "status", spans: [] }),
          });
        },
        { modelDir: dir, evalPath, policyPath },
      );

      const outcome = yield* Effect.flatMap(JarvisLocalModel, (model) =>
        model.infer({ source: MULTIWORD }),
      ).pipe(Effect.provide(local));

      assert.deepEqual(outcome, { status: "decline", reason: "quality-gate-failed" });
      assert.equal(spawns, 0);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("stays disabled through the actual layer without touching a child", () =>
    Effect.gen(function* () {
      let spawns = 0;
      const local = JarvisLocalModelLive.pipe(
        Layer.provide(
          spawnerLayerFor(() => {
            spawns += 1;
            return mockHandle({ stdout: "{}" });
          }),
        ),
        Layer.provide(NodeServices.layer),
        Layer.provideMerge(
          ServerConfig.layerTest(process.cwd(), { prefix: "jarvis-local-tier-disabled-" }),
        ),
      );

      const outcome = yield* Effect.flatMap(JarvisLocalModel, (model) =>
        model.infer({ source: MULTIWORD }),
      ).pipe(Effect.provide(local));

      assert.deepEqual(outcome, { status: "decline", reason: "local-model-disabled" });
      assert.equal(spawns, 0);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("interrupts the owned child scope on cancellation", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { dir, evalPath, policyPath } = yield* writeFixture(fileSystem, path, (d, p) =>
        passingReport(d, p),
      );

      const started = yield* Deferred.make<void>();
      let kills = 0;
      const local = JarvisLocalModelLive.pipe(
        Layer.provide(
          Layer.succeed(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make(() =>
              Deferred.succeed(started, undefined).pipe(
                Effect.as(
                  mockHandle({
                    stall: true,
                    onKill: () => {
                      kills += 1;
                    },
                  }),
                ),
              ),
            ),
          ),
        ),
        Layer.provide(NodeServices.layer),
        Layer.provideMerge(withConfig({ modelDir: dir, evalPath, policyPath })),
      );

      const fiber = yield* Effect.forkChild(
        Effect.flatMap(JarvisLocalModel, (model) => model.infer({ source: MULTIWORD })).pipe(
          Effect.provide(local),
        ),
      );
      yield* Deferred.await(started);
      yield* Fiber.interrupt(fiber);
      const exit = yield* Fiber.await(fiber);

      assert.equal(exit._tag, "Failure");
      assert.equal(kills, 1);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("times out a wedged child and terminates it", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { dir, evalPath, policyPath } = yield* writeFixture(fileSystem, path, (d, p) =>
        passingReport(d, p),
      );

      let kills = 0;
      const local = localSatisfiedFor(
        () =>
          mockHandle({
            stall: true,
            onKill: () => {
              kills += 1;
            },
          }),
        { modelDir: dir, evalPath, policyPath, timeoutMs: 100 },
      );

      const outcome = yield* Effect.flatMap(JarvisLocalModel, (model) =>
        model.infer({ source: MULTIWORD }),
      ).pipe(Effect.provide(local));

      assert.deepEqual(outcome, { status: "decline", reason: "local-model-timeout" });
      assert.equal(kills, 1);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("local model cascade through the controller route", () => {
  const runInterpret = <E2>(
    counter: { calls: number },
    local: Layer.Layer<JarvisLocalModel, E2, never>,
    proposal: JarvisSemanticProposal = providerProposal,
  ) =>
    Effect.flatMap(JarvisControllerInterpreter, (interpreter) =>
      interpreter.interpret(context(MULTIWORD)),
    ).pipe(Effect.provide(interpreterWith(counter, local, proposal)));

  const childJson = (payload: Record<string, unknown>) => encodeUnknownJson(payload);

  it.effect("falls back to exactly one provider call when the child exits nonzero", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { dir, evalPath, policyPath } = yield* writeFixture(fileSystem, path, (d, p) =>
        passingReport(d, p),
      );
      const counter = { calls: 0 };
      const result = yield* runInterpret(
        counter,
        localSatisfiedFor(() => mockHandle({ exitCode: 3 }), {
          modelDir: dir,
          evalPath,
          policyPath,
        }),
      );
      assert.equal(counter.calls, 1);
      assert.equal(result.status, "command");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("declines policy clarify to the provider instead of refusing", () =>
    Effect.gen(function* () {
      // Clarify is language uncertainty: the provider still gets its turn,
      // so this commands instead of answering needs-input.
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { dir, evalPath, policyPath } = yield* writeFixture(fileSystem, path, (d, p) =>
        passingReport(d, p),
      );
      const counter = { calls: 0 };
      const result = yield* runInterpret(
        counter,
        localSatisfiedFor(
          () =>
            mockHandle({
              stdout: childJson({
                text: MULTIWORD,
                action: "clarify",
                action_confidence: 0.2,
                spans: [],
              }),
            }),
          { modelDir: dir, evalPath, policyPath },
        ),
      );
      assert.equal(counter.calls, 1);
      assert.equal(result.status, "command");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("declines overlapping spans to the provider instead of refusing", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { dir, evalPath, policyPath } = yield* writeFixture(fileSystem, path, (d, p) =>
        passingReport(d, p),
      );
      const counter = { calls: 0 };
      const result = yield* runInterpret(
        counter,
        localSatisfiedFor(
          () =>
            mockHandle({
              stdout: childJson({
                text: MULTIWORD,
                action: "start",
                spans: [
                  { start: 0, end: 10, label: "DESTINATION" },
                  { start: 5, end: 15, label: "TASK" },
                ],
              }),
            }),
          { modelDir: dir, evalPath, policyPath },
        ),
      );
      assert.equal(counter.calls, 1);
      assert.equal(result.status, "command");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("answers needs-input with no provider fallback on node routing", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { dir, evalPath, policyPath } = yield* writeFixture(fileSystem, path, (d, p) =>
        passingReport(d, p),
      );
      const counter = { calls: 0 };
      const result = yield* runInterpret(
        counter,
        localSatisfiedFor(
          () =>
            mockHandle({
              stdout: childJson({
                text: MULTIWORD,
                action: "reroute",
                spans: [{ start: 0, end: MULTIWORD.length, label: "NODE" }],
              }),
            }),
          { modelDir: dir, evalPath, policyPath },
        ),
      );
      assert.equal(counter.calls, 0);
      assert.equal(result.status, "needs-input");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("declines to the provider when the report names another candidate", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { dir, evalPath, policyPath } = yield* writeFixture(fileSystem, path, (d, p) =>
        passingReport("/models/some-other-candidate", `${p}-other`),
      );
      void dir;
      let spawns = 0;
      const counter = { calls: 0 };
      const result = yield* runInterpret(
        counter,
        localSatisfiedFor(
          () => {
            spawns += 1;
            return mockHandle({
              stdout: childJson({ text: MULTIWORD, action: "status", spans: [] }),
            });
          },
          { modelDir: dir, evalPath, policyPath },
        ),
      );
      assert.equal(spawns, 0);
      assert.equal(counter.calls, 1);
      assert.equal(result.status, "command");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("cancels a pre-registered request without running local inference", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { dir, evalPath, policyPath } = yield* writeFixture(fileSystem, path, (d, p) =>
        passingReport(d, p),
      );
      const counter = { calls: 0 };
      const key = "jarvis:request:node:origin:interaction:local-model-cancel-probe";
      const outcome = yield* Effect.gen(function* () {
        const state = yield* makeJarvisRequestCancellationState();
        assert.deepEqual(yield* cancelPreAccept(state, key), { status: "unknown" });
        const interpreter = yield* JarvisControllerInterpreter;
        return yield* trackPreAccept(state, key, interpreter.interpret(context(MULTIWORD)));
      }).pipe(
        Effect.provide(
          interpreterWith(
            counter,
            localSatisfiedFor(
              () =>
                mockHandle({
                  stdout: childJson({ text: MULTIWORD, action: "status", spans: [] }),
                }),
              { modelDir: dir, evalPath, policyPath },
            ),
          ),
        ),
      );
      assert.deepEqual(outcome, { status: "cancelled" });
      assert.equal(counter.calls, 0);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("local model mesh propose shares the same gate", () => {
  const runPropose = <E2>(
    counter: { calls: number },
    local: Layer.Layer<JarvisLocalModel, E2, never>,
  ) =>
    Effect.flatMap(JarvisControllerInterpreter, (interpreter) =>
      interpreter.propose === undefined
        ? Effect.succeed(null)
        : interpreter.propose({
            utterance: MULTIWORD,
            projects: [
              { title: "Jarvis", names: ["Jarvis"] },
              { title: "Rivvl", names: ["Rivvl"] },
            ],
            tasks: [],
            providers: [{ name: "Codex" }],
          }),
    ).pipe(Effect.provide(interpreterWith(counter, local)));

  it.effect("returns unsupported with no provider call on node routing", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { dir, evalPath, policyPath } = yield* writeFixture(fileSystem, path, (d, p) =>
        passingReport(d, p),
      );
      const counter = { calls: 0 };
      const proposal = yield* runPropose(
        counter,
        localSatisfiedFor(
          () =>
            mockHandle({
              stdout: encodeUnknownJson({
                text: MULTIWORD,
                action: "start",
                spans: [{ start: 0, end: MULTIWORD.length, label: "NODE" }],
              }),
            }),
          { modelDir: dir, evalPath, policyPath },
        ),
      );
      assert.equal(counter.calls, 0);
      assert.deepEqual(proposal, {
        action: "unsupported",
        refs: [],
        model: null,
        effort: null,
        answer: null,
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("declines clarify to the one provider call", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { dir, evalPath, policyPath } = yield* writeFixture(fileSystem, path, (d, p) =>
        passingReport(d, p),
      );
      const counter = { calls: 0 };
      const proposal = yield* runPropose(
        counter,
        localSatisfiedFor(
          () =>
            mockHandle({
              stdout: encodeUnknownJson({ text: MULTIWORD, action: "clarify", spans: [] }),
            }),
          { modelDir: dir, evalPath, policyPath },
        ),
      );
      assert.equal(counter.calls, 1);
      assert.deepEqual(proposal, providerProposal);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("offline inference protocol probe (one bounded real call, never production)", () => {
  it.live("the stable candidate answers the deployment CLI shape", () =>
    Effect.gen(function* () {
      // Opt-in only: routine runs skip so no model ever loads by accident.
      // Set JARVIS_LOCAL_PROBE_LIVE=1 for the single offline verification.
      if ((process.env.JARVIS_LOCAL_PROBE_LIVE ?? "").trim() !== "1") {
        return;
      }
      const explicitDir = (process.env.JARVIS_LOCAL_PROBE_MODEL_DIR ?? "").trim();
      const explicitPython = (process.env.JARVIS_LOCAL_PROBE_PYTHON ?? "").trim();
      const candidateDir =
        explicitDir.length > 0
          ? explicitDir
          : "/home/abstergo/.local/share/jarvis-experiments/aris-v08/v08-small-s7";
      const python =
        explicitPython.length > 0
          ? explicitPython
          : "/home/abstergo/.local/share/jarvis-experiments/extract-v07/train-env/bin/python";
      const script = defaultInferenceScriptForDirname(
        NodePath.join(import.meta.dirname, "Layers"),
        (...parts) => NodePath.resolve(...parts),
      );
      const policyPath = NodePath.join(candidateDir, "policy-thresholds.json");
      assert.equal(NodeFS.existsSync(script), true);
      assert.equal(NodeFS.existsSync(python), true);
      assert.equal(NodeFS.existsSync(NodePath.join(candidateDir, "model_int8.onnx")), true);
      assert.equal(NodeFS.existsSync(policyPath), true);
      const source = "Fix auth in Rivvl.";
      const raw = yield* Effect.sync(() =>
        NodeChildProcess.execFileSync(
          python,
          [script, "--model-dir", candidateDir, "--int8", "--policy", policyPath, "--text", source],
          { timeout: 90_000, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" },
        ),
      );
      const parsed = decodeUnknownJsonSync(raw);
      assert.equal(typeof parsed === "object" && parsed !== null, true);
      const record = parsed as Record<string, unknown>;
      assert.equal(record.text, source);
      assert.equal(typeof record.action, "string");
      assert.equal(Array.isArray(record.spans), true);
      for (const span of record.spans as ReadonlyArray<Record<string, unknown>>) {
        assert.equal(typeof span.start, "number");
        assert.equal(typeof span.end, "number");
        assert.equal(typeof span.label, "string");
      }
      // The TypeScript adapter consumes this exact shape through the same
      // shared decision production uses, so the probe cannot pass with
      // semantics production would reject.
      const outcome = resolveLocalModelOutcome(source, parsed as RawExtractorJson);
      assert.equal(
        outcome.status === "proposal" ||
          outcome.status === "decline" ||
          outcome.status === "rejected",
        true,
      );
    }),
  );
});
