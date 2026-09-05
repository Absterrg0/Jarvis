import { describe, expect, it } from "vitest";

import type { ServerProvider } from "@t3tools/contracts";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";

import { answerJarvisModelChoice, findJarvisEffortDescriptor } from "./modelChoice.ts";
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

const codex = provider("codex", {
  displayName: "Codex",
  models: [
    {
      slug: "gpt-5.6-sol",
      name: "GPT 5.6 Sol",
      capabilities: { optionDescriptors: [effortDescriptor] },
    },
  ],
});
const fable = provider("fable", {
  displayName: "Fable",
  driver: ProviderDriverKind.make("fable"),
  models: [
    { slug: "fable-small", name: "Fable Small" },
    { slug: "fable-reviewer", name: "Fable Reviewer", isDefault: true },
  ],
});

describe("answerJarvisModelChoice", () => {
  it("completes a provider choice with the single model and default effort", () => {
    const result = answerJarvisModelChoice([codex, fable], {}, "provider-not-found", "Codex");
    expect(result).toEqual({
      status: "complete",
      selection: {
        instanceId: "codex",
        model: "gpt-5.6-sol",
        options: [{ id: "reasoningEffort", value: "high" }],
      },
    });
  });

  it("asks for the model when the provider has several and no default", () => {
    const multi = provider("multi", {
      displayName: "Multi",
      models: [
        { slug: "a-one", name: "A One" },
        { slug: "a-two", name: "A Two" },
      ],
    });
    const result = answerJarvisModelChoice([multi], {}, "provider-not-found", "Multi");
    expect(result).toMatchObject({
      status: "need-choice",
      prompt: expect.stringContaining("model"),
      choices: ["a-one", "a-two"],
    });
    if (result.status !== "need-choice") return;
    expect(answerJarvisModelChoice([multi], result.draft, "model-unavailable", "a-two")).toEqual({
      status: "complete",
      selection: { instanceId: "multi", model: "a-two" },
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

  it("returns no-match for unknown names instead of guessing", () => {
    expect(answerJarvisModelChoice([codex], {}, "provider-not-found", "Claude").status).toBe(
      "no-match",
    );
    expect(
      answerJarvisModelChoice(
        [codex],
        { instanceId: codex.instanceId },
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
    const left = provider("left", { displayName: "Same" });
    const right = provider("right", { displayName: "Same" });
    const result = answerJarvisModelChoice([left, right], {}, "provider-not-found", "Same");
    expect(result).toMatchObject({ status: "need-choice", choices: ["Same", "Same"] });
  });
});

describe("uniqueJarvisModelCompletion", () => {
  it("completes only when nothing is ambiguous", () => {
    expect(uniqueJarvisModelCompletion([codex])).toEqual({
      instanceId: "codex",
      model: "gpt-5.6-sol",
      options: [{ id: "reasoningEffort", value: "high" }],
    });
    expect(uniqueJarvisModelCompletion([codex, fable])).toBeNull();
    expect(uniqueJarvisModelCompletion([])).toBeNull();
    const noDefaultEffort = provider("solo", {
      models: [
        {
          slug: "solo-model",
          name: "Solo",
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
