import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  TextGenerationError,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { TextGeneration } from "../../textGeneration/TextGeneration.ts";
import { JarvisControllerInterpreter } from "../Services/JarvisController.ts";
import { JarvisCodexSupervisor } from "../Services/JarvisCodexSupervisor.ts";
import { makeJarvisControllerInterpreterLive } from "./JarvisController.ts";
import { JARVIS_SEMANTIC_UNAVAILABLE_PROMPT } from "../controllerHelpers.ts";

const project = {
  id: ProjectId.make("project-jarvis"),
  title: "Jarvis",
  workspaceRoot: "/workspace/jarvis",
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-08-12T00:00:00.000Z",
  updatedAt: "2026-08-12T00:00:00.000Z",
};

const codexProvider: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  displayName: "Codex",
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-08-12T00:00:00.000Z",
  models: [
    {
      slug: "gpt-5.6-luna",
      name: "GPT-5.6 Luna",
      shortName: "Luna",
      isCustom: false,
      capabilities: null,
    },
  ],
  slashCommands: [],
  skills: [],
};

const opencodeProvider: ServerProvider = {
  ...codexProvider,
  instanceId: ProviderInstanceId.make("opencode"),
  driver: ProviderDriverKind.make("opencode"),
  displayName: "OpenCode",
  models: [
    {
      slug: "openai/gpt-5.6-luna",
      name: "GPT-5.6 Luna",
      shortName: "Luna",
      isCustom: false,
      capabilities: null,
    },
    {
      slug: "opencode-go/deepseek-v4.1-flash",
      name: "DeepSeek V4.1 Flash",
      shortName: "Flash",
      isCustom: false,
      isDefault: true,
      capabilities: null,
    },
  ],
};

const startProposal = {
  action: "start" as const,
  refs: [],
  model: null,
  effort: null,
  answer: null,
};

// Multiword object declines the bounded grammar, forcing the provider tier.
const baseContext = {
  utterance: "Fix the very long auth flow with many retries and backoffs today please in Rivvl",
  currentProjectId: project.id,
  projects: [project],
  aliases: [],
  tasks: [],
  providers: [codexProvider, opencodeProvider],
  supervisorModelSelection: {
    instanceId: codexProvider.instanceId,
    model: "gpt-5.6-luna",
  },
  modelSelection: {
    instanceId: codexProvider.instanceId,
    model: "gpt-5.6-luna",
  },
  continueContext: false as const,
};

const proposeInput = {
  utterance: "Fix the very long auth flow with many retries and backoffs today please in Rivvl",
  projects: [{ title: "Rivvl", names: ["Rivvl"] }],
  tasks: [],
  providers: [{ name: "Codex" }, { name: "OpenCode" }],
};

const successfulGeneration = TextGeneration.of({
  generateCommitMessage: () => Effect.die("unused"),
  generatePrContent: () => Effect.die("unused"),
  generateBranchName: () => Effect.die("unused"),
  generateThreadTitle: () => Effect.die("unused"),
  generateStructured: () => Effect.succeed(startProposal),
});

const failingGeneration = TextGeneration.of({
  generateCommitMessage: () => Effect.die("unused"),
  generatePrContent: () => Effect.die("unused"),
  generateBranchName: () => Effect.die("unused"),
  generateThreadTitle: () => Effect.die("unused"),
  generateStructured: () =>
    Effect.fail(
      new TextGenerationError({ operation: "generateStructured", detail: "usage-limited" }),
    ),
});

const layerFor = (
  snapshots: ReadonlyArray<ServerProvider>,
  resolve: (
    instanceId: string,
  ) => typeof successfulGeneration | typeof failingGeneration | undefined,
  calls: Array<string>,
) =>
  makeJarvisControllerInterpreterLive(
    Layer.mock(ProviderRegistry)({
      getProviders: Effect.succeed(snapshots),
      getTextGenerationForInstance: (instanceId: ProviderInstanceId) =>
        Effect.sync(() => {
          calls.push(String(instanceId));
          return resolve(String(instanceId));
        }),
    }),
  ).pipe(Layer.provide(NodeServices.layer), Layer.provideMerge(ServerSettingsService.layerTest()));

const codexSupervisorLayer = (
  proposal: typeof startProposal | null,
  seenModels?: Array<string | undefined>,
) =>
  Layer.succeed(JarvisCodexSupervisor, {
    availability: Effect.succeed(
      proposal === null ? { available: false } : { available: true, model: "gpt-5.6-luna" },
    ),
    interpret: (input) => {
      seenModels?.push(input.model);
      return Effect.succeed(
        proposal === null
          ? ({ status: "decline", reason: "codex-supervisor-unavailable" } as const)
          : ({ status: "proposal", proposal } as const),
      );
    },
  });

describe("JarvisControllerInterpreter fallback", () => {
  it.effect("uses the second instance when the configured supervisor fails", () => {
    const calls: Array<string> = [];
    const layer = layerFor(
      [codexProvider, opencodeProvider],
      (instanceId) => (instanceId === "codex" ? failingGeneration : successfulGeneration),
      calls,
    );
    return Effect.gen(function* () {
      const interpreter = yield* JarvisControllerInterpreter;
      const result = yield* interpreter.interpret(baseContext);
      expect(calls).toEqual(["codex", "opencode"]);
      expect(result.status).toBe("command");
    }).pipe(Effect.provide(layer));
  });

  it.effect("falls back when the configured instance is absent", () => {
    const calls: Array<string> = [];
    const layer = layerFor(
      [codexProvider, opencodeProvider],
      (instanceId) => (instanceId === "codex" ? undefined : successfulGeneration),
      calls,
    );
    return Effect.gen(function* () {
      const interpreter = yield* JarvisControllerInterpreter;
      const result = yield* interpreter.interpret(baseContext);
      expect(calls).toContain("codex");
      expect(calls).toContain("opencode");
      expect(result.status).toBe("command");
    }).pipe(Effect.provide(layer));
  });

  it.effect("returns an honest prompt when all candidates fail", () => {
    const calls: Array<string> = [];
    const layer = layerFor([codexProvider, opencodeProvider], () => failingGeneration, calls);
    return Effect.gen(function* () {
      const interpreter = yield* JarvisControllerInterpreter;
      const result = yield* interpreter.interpret(baseContext);
      expect(result.status).toBe("needs-input");
      if (result.status !== "needs-input") return;
      expect(result.prompt).toBe(JARVIS_SEMANTIC_UNAVAILABLE_PROMPT);
      expect(result.prompt).toMatch(/semantic model providers are unavailable/);
      expect(result.prompt).not.toMatch(/restate/i);
      expect(calls.length).toBeLessThanOrEqual(3);
    }).pipe(Effect.provide(layer));
  });

  it.effect("does not call fallback when the configured supervisor succeeds", () => {
    const calls: Array<string> = [];
    const layer = layerFor([codexProvider, opencodeProvider], () => successfulGeneration, calls);
    return Effect.gen(function* () {
      const interpreter = yield* JarvisControllerInterpreter;
      const result = yield* interpreter.interpret(baseContext);
      expect(calls).toEqual(["codex"]);
      expect(result.status).toBe("command");
    }).pipe(Effect.provide(layer));
  });

  it.effect("serves a Codex supervisor through the direct tier", () => {
    const calls: Array<string> = [];
    const seenModels: Array<string | undefined> = [];
    const layer = layerFor(
      [codexProvider, opencodeProvider],
      () => successfulGeneration,
      calls,
    ).pipe(Layer.provideMerge(codexSupervisorLayer(startProposal, seenModels)));
    return Effect.gen(function* () {
      const interpreter = yield* JarvisControllerInterpreter;
      const result = yield* interpreter.interpret(baseContext);
      // The direct Codex tier answered; no provider harness was asked for text.
      expect(calls).toEqual([]);
      expect(seenModels.length).toBe(1);
      expect(result.status).toBe("command");
    }).pipe(Effect.provide(layer));
  });

  it.effect("falls back to the Codex provider when the Codex supervisor declines", () => {
    const calls: Array<string> = [];
    const layer = layerFor(
      [codexProvider, opencodeProvider],
      () => successfulGeneration,
      calls,
    ).pipe(Layer.provideMerge(codexSupervisorLayer(null)));
    return Effect.gen(function* () {
      const interpreter = yield* JarvisControllerInterpreter;
      const result = yield* interpreter.interpret(baseContext);
      expect(calls).toEqual(["codex"]);
      expect(result.status).toBe("command");
    }).pipe(Effect.provide(layer));
  });

  it.effect("keeps an OpenCode supervisor on its own provider, never the Codex tier", () => {
    const calls: Array<string> = [];
    const seenModels: Array<string | undefined> = [];
    const opencodeContext = {
      ...baseContext,
      modelSelection: {
        instanceId: opencodeProvider.instanceId,
        model: "opencode-go/deepseek-v4.1-flash",
      },
    };
    const layer = layerFor(
      [codexProvider, opencodeProvider],
      () => successfulGeneration,
      calls,
    ).pipe(Layer.provideMerge(codexSupervisorLayer(startProposal, seenModels)));
    return Effect.gen(function* () {
      const interpreter = yield* JarvisControllerInterpreter;
      const result = yield* interpreter.interpret(opencodeContext);
      // OpenCode family: provider harness only; the Codex tier is not involved.
      expect(seenModels).toEqual([]);
      expect(calls).toEqual(["opencode"]);
      expect(result.status).toBe("command");
    }).pipe(Effect.provide(layer));
  });

  it.effect("propose falls back to the second instance", () => {
    const calls: Array<string> = [];
    const layer = layerFor(
      [codexProvider, opencodeProvider],
      (instanceId) => (instanceId === "codex" ? failingGeneration : successfulGeneration),
      calls,
    );
    return Effect.gen(function* () {
      const interpreter = yield* JarvisControllerInterpreter;
      const proposal = yield* interpreter.propose?.(proposeInput) ?? Effect.succeed(null);
      expect(calls).toEqual(["codex", "opencode"]);
      expect(proposal).toMatchObject({ action: "start" });
    }).pipe(Effect.provide(layer));
  });
});
