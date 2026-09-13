import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type CirceSemanticProposal,
  type OrchestrationProjectShell,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "vite-plus/test";

import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import * as ServerSettingsModule from "../serverSettings.ts";
import { TextGeneration } from "../textGeneration/TextGeneration.ts";
import { CirceControllerInterpreter } from "./Services/CirceController.ts";
import { makeCirceControllerInterpreterLive } from "./Layers/CirceController.ts";
import type { CirceCommandContext } from "@circe/core/command";

const circe: OrchestrationProjectShell = {
  id: ProjectId.make("project-beacon"),
  title: "Beacon",
  workspaceRoot: "/workspace/beacon",
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-08-30T00:00:00.000Z",
  updatedAt: "2026-08-30T00:00:00.000Z",
};
const rivvl: OrchestrationProjectShell = {
  ...circe,
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

function context(utterance: string): CirceCommandContext {
  return {
    utterance,
    currentProjectId: circe.id,
    projects: [circe, rivvl],
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

const fallbackProposal: CirceSemanticProposal = {
  action: "start",
  refs: [],
  model: null,
  effort: null,
  answer: null,
};

function interpreterWithCounter(
  counter: { calls: number },
  proposal: CirceSemanticProposal = fallbackProposal,
) {
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
  return makeCirceControllerInterpreterLive(
    Layer.mock(ProviderRegistry)({
      getTextGenerationForInstance: () => Effect.succeed(generation),
    }),
  ).pipe(
    Layer.provide(NodeServices.layer),
    Layer.provideMerge(ServerSettingsModule.ServerSettingsService.layerTest()),
  );
}

const runInterpret = (utterance: string, counter: { calls: number }) =>
  Effect.flatMap(CirceControllerInterpreter, (interpreter) =>
    interpreter.interpret(context(utterance)),
  ).pipe(Effect.provide(interpreterWithCounter(counter)), Effect.runPromise);

const runInterpretWith = (
  utterance: string,
  counter: { calls: number },
  proposal: CirceSemanticProposal,
) =>
  Effect.flatMap(CirceControllerInterpreter, (interpreter) =>
    interpreter.interpret(context(utterance)),
  ).pipe(Effect.provide(interpreterWithCounter(counter, proposal)), Effect.runPromise);

const unsupportedProposal: CirceSemanticProposal = {
  action: "unsupported",
  refs: [],
  model: null,
  effort: null,
  answer: null,
};

describe("local-tier cascade calls provider at most once", () => {
  it("skips the provider for single-token auth in Rivvl", async () => {
    const counter = { calls: 0 };
    const result = await runInterpret("Fix auth in Rivvl.", counter);
    expect(counter.calls).toBe(0);
    expect(result.status).toBe("command");
  });

  it("calls the provider once for overlong work and still commands via the cascade", async () => {
    // A request too long or too compound for the bounded grammar defers to
    // the provider; the whole cascade still commands.
    const counter = { calls: 0 };
    const result = await runInterpret(
      "Fix the very long auth flow with many retries and backoffs today please in Rivvl",
      counter,
    );
    expect(counter.calls).toBe(1);
    expect(result.status).toBe("command");
  });

  it("calls the provider once for out-of-grammar compounds and still refuses via explicit bounds", async () => {
    const counter = { calls: 0 };
    const result = await runInterpretWith(
      "Stop Rivvl authentication, then create a deployment task",
      counter,
      unsupportedProposal,
    );
    expect(counter.calls).toBe(1);
    expect(result.status).toBe("needs-input");
  });

  it("calls the provider once for and-joined turns and still refuses via explicit bounds", async () => {
    const counter = { calls: 0 };
    const result = await runInterpretWith(
      "Stop auth and create deployment task",
      counter,
      unsupportedProposal,
    );
    expect(counter.calls).toBe(1);
    expect(result.status).toBe("needs-input");
  });

  it("routes multiword exclusions through the provider with full wording", async () => {
    // Changed contract: single object only, so multiword negation declines
    // the automatic path and defers to the provider. The validator stays
    // fail-closed for excluded destinations; the cascade still commands
    // ambient with full wording.
    const counter = { calls: 0 };
    const result = await runInterpret("Test auth but not in Rivvl.", counter);
    expect(counter.calls).toBe(1);
    expect(result.status).toBe("command");
    if (result.status !== "command" || result.command.type !== "start") return;
    expect(String(result.command.projectId)).toBe("project-beacon");
    expect(result.command.objective).toBe("Test auth but not in Rivvl.");
  });

  it("calls the provider exactly once when the grammar declines", async () => {
    const counter = { calls: 0 };
    const result = await runInterpret("Use Codex to tighten the websocket retry logic.", counter);
    expect(counter.calls).toBe(1);
    expect(result.status).toBe("command");
  });

  it("leaves the disabled local-tier hook claiming no model", async () => {
    const { tryCirceLocalTier, CIRCE_LOCAL_TIER_DEFAULT } =
      await import("@circe/core/localGrammar");
    expect(CIRCE_LOCAL_TIER_DEFAULT).toEqual({ mode: "disabled" });
    const tier = tryCirceLocalTier({
      source: "Fix auth in Rivvl.",
      context: context("Fix auth in Rivvl."),
    });
    expect(tier).toEqual({ status: "decline", reason: "local-tier-disabled" });
    const restricted = tryCirceLocalTier({
      source: "Fix auth in Rivvl.",
      context: context("Fix auth in Rivvl."),
      config: { mode: "restricted" },
    });
    expect(restricted).toEqual({ status: "decline", reason: "local-tier-disabled" });
  });

  it("cancels a pre-registered request without running interpretation", async () => {
    const { cancelPreAccept, makeCirceRequestCancellationState, trackPreAccept } =
      await import("./requestCancellation.ts");
    const counter = { calls: 0 };
    const layer = interpreterWithCounter(counter);
    const key = "circe:request:node:origin:interaction:local-tier-cancel-probe";
    const program = Effect.gen(function* () {
      const state = yield* makeCirceRequestCancellationState();
      expect(yield* cancelPreAccept(state, key)).toEqual({ status: "unknown" });
      const interpreter = yield* CirceControllerInterpreter;
      const outcome = yield* trackPreAccept(
        state,
        key,
        interpreter.interpret(context("Fix auth in Rivvl.")),
      );
      return outcome;
    }).pipe(Effect.provide(layer), Effect.runPromise);
    const outcome = await program;
    expect(outcome).toEqual({ status: "cancelled" });
    expect(counter.calls).toBe(0);
  });
});

describe("mesh propose skips the provider for bounded turns", () => {
  it("returns a single-token grammar destination without a provider call", async () => {
    const counter = { calls: 0 };
    const layer = interpreterWithCounter(counter);
    const program = Effect.flatMap(CirceControllerInterpreter, (interpreter) =>
      interpreter.propose === undefined
        ? Effect.succeed(null)
        : interpreter.propose({
            utterance: "Fix auth in Rivvl.",
            projects: [
              { title: "Beacon", names: ["Beacon"] },
              { title: "Rivvl", names: ["Rivvl"] },
            ],
            tasks: [],
            providers: [{ name: "Codex" }],
          }),
    ).pipe(Effect.provide(layer), Effect.runPromise);
    const proposal = await program;
    expect(counter.calls).toBe(0);
    expect(proposal).toMatchObject({ action: "start" });
  });

  it("calls the provider once for overlong mesh turns", async () => {
    // Outside the bounded grammar, the mesh proposal uses the provider.
    const counter = { calls: 0 };
    const layer = interpreterWithCounter(counter);
    const program = Effect.flatMap(CirceControllerInterpreter, (interpreter) =>
      interpreter.propose === undefined
        ? Effect.succeed(null)
        : interpreter.propose({
            utterance:
              "Fix the very long auth flow with many retries and backoffs today please in Rivvl",
            projects: [
              { title: "Beacon", names: ["Beacon"] },
              { title: "Rivvl", names: ["Rivvl"] },
            ],
            tasks: [],
            providers: [{ name: "Codex" }],
          }),
    ).pipe(Effect.provide(layer), Effect.runPromise);
    const proposal = await program;
    expect(counter.calls).toBe(1);
    expect(proposal).toMatchObject({ action: "start" });
  });

  it("calls the provider once for out-of-grammar compounds in mesh propose", async () => {
    const counter = { calls: 0 };
    const layer = interpreterWithCounter(counter, unsupportedProposal);
    const program = Effect.flatMap(CirceControllerInterpreter, (interpreter) =>
      interpreter.propose === undefined
        ? Effect.succeed(null)
        : interpreter.propose({
            utterance: "Fix auth then add release notes.",
            projects: [
              { title: "Beacon", names: ["Beacon"] },
              { title: "Rivvl", names: ["Rivvl"] },
            ],
            tasks: [],
            providers: [{ name: "Codex" }],
          }),
    ).pipe(Effect.provide(layer), Effect.runPromise);
    const proposal = await program;
    expect(counter.calls).toBe(1);
    expect(proposal).toMatchObject({ action: "unsupported" });
  });
});
