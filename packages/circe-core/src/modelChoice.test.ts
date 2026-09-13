import { describe, expect, it } from "vite-plus/test";

import type { ServerProvider } from "@t3tools/contracts";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";

import {
  answerCirceModelChoice,
  findCirceEffortDescriptor,
  usableCirceProviders,
} from "./modelChoice.ts";
import { uniqueCirceModelCompletion } from "./modelChoice.ts";

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

describe("answerCirceModelChoice", () => {
  it("completes a provider choice with the single model and no effort decision", () => {
    expect(answerCirceModelChoice([plain, fable], {}, "provider-not-found", "Plain")).toEqual({
      status: "complete",
      selection: { instanceId: "plain", model: "plain-model" },
    });
  });

  it("fills the descriptor default instead of asking for the effort level", () => {
    expect(answerCirceModelChoice([codex], {}, "provider-not-found", "Codex")).toEqual({
      status: "complete",
      selection: {
        instanceId: "codex",
        model: "gpt-5.6-sol",
        options: [{ id: "reasoningEffort", value: "high" }],
      },
    });
  });

  it("asks for the model instead of picking the default", () => {
    const result = answerCirceModelChoice([fable], {}, "provider-not-found", "Fable");
    expect(result).toMatchObject({
      status: "need-choice",
      prompt: expect.stringContaining("model"),
      choices: ["fable-small", "fable-reviewer"],
    });
    if (result.status !== "need-choice") return;
    expect(answerCirceModelChoice([fable], result.draft, result.reason, "fable-reviewer")).toEqual({
      status: "complete",
      selection: { instanceId: "fable", model: "fable-reviewer" },
    });
  });

  it("asks for the model when the provider has several and no default", () => {
    const multi = provider("multi", {
      displayName: "Multi",
      models: [
        { slug: "a-one", name: "A One", isCustom: false, capabilities: null },
        { slug: "a-two", name: "A Two", isCustom: false, capabilities: null },
      ],
    });
    const result = answerCirceModelChoice([multi], {}, "provider-not-found", "Multi");
    expect(result).toMatchObject({
      status: "need-choice",
      prompt: expect.stringContaining("model"),
      choices: ["a-one", "a-two"],
    });
    if (result.status !== "need-choice") return;
    expect(answerCirceModelChoice([multi], result.draft, result.reason, "a-two")).toEqual({
      status: "complete",
      selection: { instanceId: "multi", model: "a-two" },
    });
  });

  it("completes the model step with the automatic effort default", () => {
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
    const providerStep = answerCirceModelChoice(
      [multiWithEffort],
      {},
      "provider-not-found",
      "Multi Effort",
    );
    expect(providerStep).toMatchObject({ status: "need-choice", reason: "model-unavailable" });
    if (providerStep.status !== "need-choice") return;
    expect(
      answerCirceModelChoice(
        [multiWithEffort],
        providerStep.draft,
        providerStep.reason,
        "reasoning",
      ),
    ).toEqual({
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
    expect(answerCirceModelChoice([codex], { ...draft }, "effort-missing", "high")).toEqual({
      status: "complete",
      selection: {
        instanceId: "codex",
        model: "gpt-5.6-sol",
        options: [{ id: "reasoningEffort", value: "high" }],
      },
    });
  });

  it("matches models by name and effort by label", () => {
    const named = answerCirceModelChoice([fable], {}, "model-unavailable", "Fable Reviewer");
    expect(named).toEqual({
      status: "complete",
      selection: { instanceId: "fable", model: "fable-reviewer" },
    });
    const draft = { instanceId: codex.instanceId, model: "gpt-5.6-sol" } as const;
    const effort = answerCirceModelChoice([codex], { ...draft }, "effort-unavailable", "High");
    expect(effort.status).toBe("complete");
  });

  it("replaces an unavailable effort value in the typed draft", () => {
    const result = answerCirceModelChoice(
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
    expect(answerCirceModelChoice([disabled], {}, "provider-not-found", "Codex").status).toBe(
      "no-match",
    );
    expect(usableCirceProviders([disabled, plain])).toEqual([plain]);
  });

  it("returns no-match for unknown names instead of guessing", () => {
    expect(answerCirceModelChoice([plain], {}, "provider-not-found", "Claude").status).toBe(
      "no-match",
    );
    expect(
      answerCirceModelChoice([plain], { instanceId: plain.instanceId }, "model-unavailable", "opus")
        .status,
    ).toBe("no-match");
    expect(
      answerCirceModelChoice(
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
    const result = answerCirceModelChoice([left, right], {}, "provider-not-found", "Same");
    expect(result).toMatchObject({
      status: "need-choice",
      reason: "provider-not-found",
      choices: ["Same (left)", "Same (right)"],
    });
    if (result.status !== "need-choice") return;
    expect(
      answerCirceModelChoice([left, right], result.draft, result.reason, result.choices[0]!),
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
    const result = answerCirceModelChoice([left, right], {}, "model-unavailable", "Shared");
    expect(result).toMatchObject({
      status: "need-choice",
      reason: "model-unavailable",
      choices: ["shared (Left)", "shared (Right)"],
    });
    if (result.status !== "need-choice") return;
    expect(
      answerCirceModelChoice([left, right], result.draft, result.reason, result.choices[1]!),
    ).toMatchObject({
      status: "complete",
      selection: { instanceId: "right-model", model: "shared" },
    });
  });
});

describe("uniqueCirceModelCompletion", () => {
  it("completes only when provider and model are unambiguous; effort auto-fills", () => {
    expect(uniqueCirceModelCompletion([plain])).toEqual({
      instanceId: "plain",
      model: "plain-model",
    });
    expect(uniqueCirceModelCompletion([plain, fable])).toBeNull();
    expect(uniqueCirceModelCompletion([])).toBeNull();
    // One provider and one model complete with the descriptor default.
    expect(uniqueCirceModelCompletion([codex])).toEqual({
      instanceId: "codex",
      model: "gpt-5.6-sol",
      options: [{ id: "reasoningEffort", value: "high" }],
    });
    // A default model among several is not an unambiguous answer either.
    expect(uniqueCirceModelCompletion([fable])).toBeNull();
    // Unavailable providers never count toward uniqueness.
    const unavailable = provider("plain", {
      enabled: false,
      status: "disabled",
      models: [{ slug: "plain-model", name: "Plain Model", isCustom: false, capabilities: null }],
    });
    expect(uniqueCirceModelCompletion([unavailable])).toBeNull();
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
    expect(uniqueCirceModelCompletion([noDefaultEffort])).toEqual({
      instanceId: "solo",
      model: "solo-model",
      options: [{ id: "reasoningEffort", value: "low" }],
    });
  });
});

describe("findCirceEffortDescriptor", () => {
  it("matches effort-like descriptors only", () => {
    expect(findCirceEffortDescriptor([effortDescriptor])?.id).toBe("reasoningEffort");
    expect(
      findCirceEffortDescriptor([
        { id: "temperature", label: "Temperature", type: "select", options: [] },
      ]),
    ).toBeUndefined();
    expect(findCirceEffortDescriptor(undefined)).toBeUndefined();
  });
});
