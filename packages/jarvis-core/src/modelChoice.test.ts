import { describe, expect, it } from "vite-plus/test";

import type { ServerProvider } from "@t3tools/contracts";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";

import {
  answerJarvisModelChoice,
  findJarvisEffortDescriptor,
  usableJarvisProviders,
} from "./modelChoice.ts";
import { uniqueJarvisModelCompletion } from "./modelChoice.ts";

function provider(instanceId: string, overrides: Partial<ServerProvider> = {}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make("codex"),
    displayName: instanceId,
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-08-21T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

const effortDescriptor = {
  id: "reasoningEffort",
  label: "Reasoning effort",
  type: "select" as const,
  options: [
    { id: "low", label: "Low" },
    { id: "high", label: "High", isDefault: true },
  ],
};

const plain = provider("plain", {
  displayName: "Plain",
  models: [{ slug: "plain-model", name: "Plain Model", isCustom: false, capabilities: null }],
});
const codex = provider("codex", {
  displayName: "Codex",
  models: [
    {
      slug: "gpt-5.6-sol",
      name: "GPT 5.6 Sol",
      isCustom: false,
      capabilities: { optionDescriptors: [effortDescriptor] },
    },
  ],
});
const fable = provider("fable", {
  displayName: "Fable",
  driver: ProviderDriverKind.make("fable"),
  models: [
    { slug: "fable-small", name: "Fable Small", isCustom: false, capabilities: null },
    {
      slug: "fable-reviewer",
      name: "Fable Reviewer",
      isCustom: false,
      capabilities: null,
      isDefault: true,
    },
  ],
});

describe("answerJarvisModelChoice", () => {
  it("completes a provider choice with the single model and no effort decision", () => {
    expect(answerJarvisModelChoice([plain, fable], {}, "provider-not-found", "Plain")).toEqual({
      status: "complete",
      selection: { instanceId: "plain", model: "plain-model" },
    });
  });

  it("asks for the effort level instead of filling the default", () => {
    const result = answerJarvisModelChoice([codex], {}, "provider-not-found", "Codex");
    expect(result).toMatchObject({
      status: "need-choice",
      prompt: expect.stringContaining("effort"),
      choices: ["low", "high"],
    });
    if (result.status !== "need-choice") return;
    expect(answerJarvisModelChoice([codex], result.draft, result.reason, "high")).toEqual({
      status: "complete",
      selection: {
        instanceId: "codex",
        model: "gpt-5.6-sol",
        options: [{ id: "reasoningEffort", value: "high" }],
      },
    });
  });

  it("asks for the model instead of picking the default", () => {
    const result = answerJarvisModelChoice([fable], {}, "provider-not-found", "Fable");
    expect(result).toMatchObject({
      status: "need-choice",
      prompt: expect.stringContaining("model"),
      choices: ["fable-small", "fable-reviewer"],
    });
    if (result.status !== "need-choice") return;
    expect(answerJarvisModelChoice([fable], result.draft, result.reason, "fable-reviewer")).toEqual(
      {
        status: "complete",
        selection: { instanceId: "fable", model: "fable-reviewer" },
      },
    );
  });

  it("asks for the model when the provider has several and no default", () => {
    const multi = provider("multi", {
      displayName: "Multi",
      models: [
        { slug: "a-one", name: "A One", isCustom: false, capabilities: null },
        { slug: "a-two", name: "A Two", isCustom: false, capabilities: null },
      ],
    });
    const result = answerJarvisModelChoice([multi], {}, "provider-not-found", "Multi");
    expect(result).toMatchObject({
      status: "need-choice",
      prompt: expect.stringContaining("model"),
      choices: ["a-one", "a-two"],
    });
    if (result.status !== "need-choice") return;
    expect(answerJarvisModelChoice([multi], result.draft, result.reason, "a-two")).toEqual({
      status: "complete",
      selection: { instanceId: "multi", model: "a-two" },
    });
  });

  it("advances provider, model, and effort steps with the returned reasons", () => {
    const multiWithEffort = provider("multi-effort", {
      displayName: "Multi Effort",
      models: [
        { slug: "plain", name: "Plain", isCustom: false, capabilities: null },
        {
          slug: "reasoning",
          name: "Reasoning",
          isCustom: false,
          capabilities: { optionDescriptors: [effortDescriptor] },
        },
      ],
    });
    const providerStep = answerJarvisModelChoice(
      [multiWithEffort],
      {},
      "provider-not-found",
      "Multi Effort",
    );
    expect(providerStep).toMatchObject({ status: "need-choice", reason: "model-unavailable" });
    if (providerStep.status !== "need-choice") return;
    const modelStep = answerJarvisModelChoice(
      [multiWithEffort],
      providerStep.draft,
      providerStep.reason,
      "reasoning",
    );
    expect(modelStep).toMatchObject({ status: "need-choice", reason: "effort-missing" });
    if (modelStep.status !== "need-choice") return;
    expect(
      answerJarvisModelChoice([multiWithEffort], modelStep.draft, modelStep.reason, "high"),
    ).toMatchObject({
      status: "complete",
      selection: {
        instanceId: "multi-effort",
        model: "reasoning",
        options: [{ id: "reasoningEffort", value: "high" }],
      },
    });
  });

  it("answers an effort choice against the resolved model", () => {
    const draft = { instanceId: codex.instanceId, model: "gpt-5.6-sol" } as const;
    expect(answerJarvisModelChoice([codex], { ...draft }, "effort-missing", "high")).toEqual({
      status: "complete",
      selection: {
        instanceId: "codex",
        model: "gpt-5.6-sol",
        options: [{ id: "reasoningEffort", value: "high" }],
      },
    });
  });

  it("matches models by name and effort by label", () => {
    const named = answerJarvisModelChoice([fable], {}, "model-unavailable", "Fable Reviewer");
    expect(named).toEqual({
      status: "complete",
      selection: { instanceId: "fable", model: "fable-reviewer" },
    });
    const draft = { instanceId: codex.instanceId, model: "gpt-5.6-sol" } as const;
    const effort = answerJarvisModelChoice([codex], { ...draft }, "effort-unavailable", "High");
    expect(effort.status).toBe("complete");
  });

  it("replaces an unavailable effort value in the typed draft", () => {
    const result = answerJarvisModelChoice(
      [codex],
      {
        instanceId: codex.instanceId,
        model: "gpt-5.6-sol",
        options: [{ id: "reasoningEffort", value: "ultra" }],
      },
      "effort-unavailable",
      "High",
    );
    expect(result).toEqual({
      status: "complete",
      selection: {
        instanceId: codex.instanceId,
        model: "gpt-5.6-sol",
        options: [{ id: "reasoningEffort", value: "high" }],
      },
    });
  });

  it("ignores unavailable providers instead of completing from them", () => {
    const disabled = provider("codex", {
      displayName: "Codex",
      enabled: false,
      status: "disabled",
      models: [{ slug: "gpt-5.6-sol", name: "GPT 5.6 Sol", isCustom: false, capabilities: null }],
    });
    expect(answerJarvisModelChoice([disabled], {}, "provider-not-found", "Codex").status).toBe(
      "no-match",
    );
    expect(usableJarvisProviders([disabled, plain])).toEqual([plain]);
  });

  it("returns no-match for unknown names instead of guessing", () => {
    expect(answerJarvisModelChoice([plain], {}, "provider-not-found", "Claude").status).toBe(
      "no-match",
    );
    expect(
      answerJarvisModelChoice(
        [plain],
        { instanceId: plain.instanceId },
        "model-unavailable",
        "opus",
      ).status,
    ).toBe("no-match");
    expect(
      answerJarvisModelChoice(
        [codex],
        { instanceId: codex.instanceId, model: "gpt-5.6-sol" },
        "effort-missing",
        "ultra",
      ).status,
    ).toBe("no-match");
  });

  it("asks which provider when several share a name", () => {
    const left = provider("left", {
      displayName: "Same",
      models: [{ slug: "left-model", name: "Left Model", isCustom: false, capabilities: null }],
    });
    const right = provider("right", {
      displayName: "Same",
      models: [{ slug: "right-model", name: "Right Model", isCustom: false, capabilities: null }],
    });
    const result = answerJarvisModelChoice([left, right], {}, "provider-not-found", "Same");
    expect(result).toMatchObject({
      status: "need-choice",
      reason: "provider-not-found",
      choices: ["Same (left)", "Same (right)"],
    });
    if (result.status !== "need-choice") return;
    expect(
      answerJarvisModelChoice([left, right], result.draft, result.reason, result.choices[0]!),
    ).toMatchObject({ status: "complete", selection: { instanceId: "left" } });
  });

  it("keeps duplicate model choices scoped to their provider candidates", () => {
    const left = provider("left-model", {
      displayName: "Left",
      models: [{ slug: "shared", name: "Shared", isCustom: false, capabilities: null }],
    });
    const right = provider("right-model", {
      displayName: "Right",
      models: [{ slug: "shared", name: "Shared", isCustom: false, capabilities: null }],
    });
    const result = answerJarvisModelChoice([left, right], {}, "model-unavailable", "Shared");
    expect(result).toMatchObject({
      status: "need-choice",
      reason: "model-unavailable",
      choices: ["shared (Left)", "shared (Right)"],
    });
    if (result.status !== "need-choice") return;
    expect(
      answerJarvisModelChoice([left, right], result.draft, result.reason, result.choices[1]!),
    ).toMatchObject({
      status: "complete",
      selection: { instanceId: "right-model", model: "shared" },
    });
  });
});

describe("uniqueJarvisModelCompletion", () => {
  it("completes only when provider, model, and effort are all unambiguous", () => {
    expect(uniqueJarvisModelCompletion([plain])).toEqual({
      instanceId: "plain",
      model: "plain-model",
    });
    expect(uniqueJarvisModelCompletion([plain, fable])).toBeNull();
    expect(uniqueJarvisModelCompletion([])).toBeNull();
    // One provider and one model still ask when an effort level is undecided,
    // even when that level has a default.
    expect(uniqueJarvisModelCompletion([codex])).toBeNull();
    // A default model among several is not an unambiguous answer either.
    expect(uniqueJarvisModelCompletion([fable])).toBeNull();
    // Unavailable providers never count toward uniqueness.
    const unavailable = provider("plain", {
      enabled: false,
      status: "disabled",
      models: [{ slug: "plain-model", name: "Plain Model", isCustom: false, capabilities: null }],
    });
    expect(uniqueJarvisModelCompletion([unavailable])).toBeNull();
    const noDefaultEffort = provider("solo", {
      models: [
        {
          slug: "solo-model",
          name: "Solo",
          isCustom: false,
          capabilities: {
            optionDescriptors: [
              {
                id: "reasoningEffort",
                label: "Reasoning effort",
                type: "select",
                options: [
                  { id: "low", label: "Low" },
                  { id: "high", label: "High" },
                ],
              },
            ],
          },
        },
      ],
    });
    expect(uniqueJarvisModelCompletion([noDefaultEffort])).toBeNull();
  });
});

describe("findJarvisEffortDescriptor", () => {
  it("matches effort-like descriptors only", () => {
    expect(findJarvisEffortDescriptor([effortDescriptor])?.id).toBe("reasoningEffort");
    expect(
      findJarvisEffortDescriptor([
        { id: "temperature", label: "Temperature", type: "select", options: [] },
      ]),
    ).toBeUndefined();
    expect(findJarvisEffortDescriptor(undefined)).toBeUndefined();
  });
});
