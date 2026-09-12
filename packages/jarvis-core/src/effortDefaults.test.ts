import { describe, expect, it } from "vite-plus/test";

import type { ServerProvider } from "@t3tools/contracts";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";

import { validateJarvisModelSelection } from "./command.ts";
import {
  answerJarvisModelChoice,
  resolveJarvisEffortDefaultOption,
  uniqueJarvisModelCompletion,
} from "./modelChoice.ts";

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

// Aion-2.0 shape from the report: effort descriptor without a provider
// default, so the old policy asked "Choose a reasoning level for Aion-2.0".
const aion = provider("aion", {
  displayName: "Aion",
  models: [
    {
      slug: "aion-2.0",
      name: "Aion-2.0",
      shortName: "Aion-2.0",
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          {
            id: "reasoningEffort",
            label: "Reasoning",
            type: "select",
            options: [
              { id: "low", label: "Low" },
              { id: "medium", label: "Medium" },
              { id: "high", label: "High" },
            ],
          },
        ],
      },
    },
  ],
});

describe("never ask reasoning level (negative regression)", () => {
  it("validates a missing effort with an automatic default instead of asking", () => {
    const result = validateJarvisModelSelection(
      { instanceId: aion.instanceId, model: "aion-2.0" },
      [aion],
      "Ship it.",
    );
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.selection.options).toEqual([{ id: "reasoningEffort", value: "low" }]);
  });

  it("preserves an explicit valid effort value", () => {
    const result = validateJarvisModelSelection(
      {
        instanceId: aion.instanceId,
        model: "aion-2.0",
        options: [{ id: "reasoningEffort", value: "high" }],
      },
      [aion],
      "Ship it.",
    );
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.selection.options).toEqual([{ id: "reasoningEffort", value: "high" }]);
  });

  it("completes a provider/model choice without an effort question", () => {
    const result = answerJarvisModelChoice([aion], {}, "provider-not-found", "Aion");
    expect(result.status).toBe("complete");
  });

  it("completes the unique-model shortcut without an effort question", () => {
    expect(uniqueJarvisModelCompletion([aion])).not.toBeNull();
  });
});

describe("effort default policy", () => {
  const descriptor = (
    options: Array<{ id: string; label: string; isDefault?: boolean }>,
  ): Parameters<typeof resolveJarvisEffortDefaultOption>[0] => ({
    id: "reasoningEffort",
    label: "Reasoning",
    type: "select",
    options,
  });

  it("prefers the provider descriptor default, then low, then default, then first", () => {
    expect(
      resolveJarvisEffortDefaultOption(
        descriptor([
          { id: "low", label: "Low" },
          { id: "high", label: "High", isDefault: true },
        ]),
      ),
    ).toBe("high");
    expect(
      resolveJarvisEffortDefaultOption(
        descriptor([
          { id: "medium", label: "Medium" },
          { id: "low", label: "Low" },
        ]),
      ),
    ).toBe("low");
    expect(
      resolveJarvisEffortDefaultOption(
        descriptor([
          { id: "medium", label: "Medium" },
          { id: "default", label: "Standard" },
        ]),
      ),
    ).toBe("default");
    expect(
      resolveJarvisEffortDefaultOption(
        descriptor([
          { id: "medium", label: "Medium" },
          { id: "high", label: "High" },
        ]),
      ),
    ).toBe("medium");
    expect(resolveJarvisEffortDefaultOption(descriptor([]))).toBeUndefined();
  });
});
