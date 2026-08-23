import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveTaskIntent } from "./resolveTaskIntent.ts";

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
      slug: "gpt-5.6-sol",
      name: "GPT-5.6 Sol",
      shortName: "Sol",
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          {
            id: "reasoningEffort",
            label: "Reasoning",
            type: "select",
            options: [
              { id: "low", label: "Low" },
              { id: "high", label: "High" },
            ],
            currentValue: "low",
          },
        ],
      },
    },
  ],
  slashCommands: [],
  skills: [],
};

const claudeProvider: ServerProvider = {
  ...codexProvider,
  instanceId: ProviderInstanceId.make("claude"),
  driver: ProviderDriverKind.make("claudeAgent"),
  displayName: "Claude",
  models: [
    {
      slug: "claude-sonnet-5",
      name: "Claude Sonnet 5",
      shortName: "Sonnet",
      isCustom: false,
      capabilities: null,
    },
  ],
};

const fableProvider: ServerProvider = {
  ...codexProvider,
  instanceId: ProviderInstanceId.make("fable"),
  driver: ProviderDriverKind.make("fable"),
  displayName: "Fable",
  models: [
    {
      slug: "fable-reviewer",
      name: "Fable Reviewer",
      shortName: "Reviewer",
      isCustom: false,
      capabilities: null,
    },
  ],
};

describe("resolveTaskIntent", () => {
  it("resolves a provider, model, effort, and objective from one spoken instruction", () => {
    expect(
      resolveTaskIntent({
        utterance:
          "Jarvis, spin up a Codex Sol high agent to implement device presence efficiently.",
        providers: [codexProvider],
      }),
    ).toEqual({
      status: "ready",
      action: "task",
      objective: "Implement device presence efficiently.",
      modelSelection: {
        instanceId: "codex",
        model: "gpt-5.6-sol",
        options: [{ id: "reasoningEffort", value: "high" }],
      },
    });
  });

  it("asks for action instead of dispatching through an unavailable provider", () => {
    expect(
      resolveTaskIntent({
        utterance: "Jarvis, use Codex Sol high to implement device presence.",
        providers: [
          {
            ...codexProvider,
            installed: false,
            status: "error",
            auth: { status: "unauthenticated" },
          },
        ],
      }),
    ).toEqual({
      status: "needs-input",
      reason: "provider-unavailable",
      prompt: "Codex is not ready. Install, enable, and authenticate it before starting this task.",
      choices: [],
    });
  });

  it("does not dispatch through a provider whose live health check is failing", () => {
    expect(
      resolveTaskIntent({
        utterance: "Jarvis, use Codex Sol high to implement device presence.",
        providers: [{ ...codexProvider, status: "error" }],
      }),
    ).toMatchObject({
      status: "needs-input",
      reason: "provider-unavailable",
    });
  });

  it("offers live model choices instead of silently falling back", () => {
    expect(
      resolveTaskIntent({
        utterance: "Jarvis, use Codex Fable high to implement device presence.",
        providers: [codexProvider],
      }),
    ).toEqual({
      status: "needs-input",
      reason: "model-unavailable",
      prompt: "Fable is not available through Codex. Sol is available.",
      choices: ["gpt-5.6-sol"],
    });
  });

  it("rejects an effort level the selected model does not advertise", () => {
    expect(
      resolveTaskIntent({
        utterance: "Jarvis, use Codex Sol max to implement device presence.",
        providers: [codexProvider],
      }),
    ).toEqual({
      status: "needs-input",
      reason: "effort-unavailable",
      prompt: "Max is not available for Sol. Low and High are available.",
      choices: ["low", "high"],
    });
  });

  it("asks for an explicit effort when the selected model offers the choice", () => {
    expect(
      resolveTaskIntent({
        utterance: "Jarvis, use Codex Sol to implement device presence.",
        providers: [codexProvider],
      }),
    ).toMatchObject({
      status: "needs-input",
      reason: "effort-missing",
      choices: ["low", "high"],
    });
  });

  it("keeps the resolved worker selection while asking for a missing objective", () => {
    expect(
      resolveTaskIntent({
        utterance: "Jarvis, spin up a Codex Sol high agent for me.",
        providers: [codexProvider],
      }),
    ).toEqual({
      status: "needs-input",
      reason: "objective-missing",
      prompt: "What should the Codex Sol agent work on?",
      choices: [],
      pendingModelSelection: {
        instanceId: "codex",
        model: "gpt-5.6-sol",
        options: [{ id: "reasoningEffort", value: "high" }],
      },
    });
  });

  it("offers configured providers when the requested provider does not exist", () => {
    expect(
      resolveTaskIntent({
        utterance: "Jarvis, use Codex Sol high to implement device presence.",
        providers: [claudeProvider],
      }),
    ).toEqual({
      status: "needs-input",
      reason: "provider-not-found",
      prompt: "Codex is not configured. Claude is available.",
      choices: ["claude"],
    });
  });

  it("rejects a saved companion provider that is no longer configured", () => {
    expect(
      resolveTaskIntent({
        utterance: "Implement device presence.",
        providers: [codexProvider],
        modelSelection: {
          instanceId: ProviderInstanceId.make("retired-provider"),
          model: "retired-model",
        },
      }),
    ).toEqual({
      status: "needs-input",
      reason: "provider-not-found",
      prompt:
        "The saved companion provider retired-provider is no longer configured. Codex is available.",
      choices: ["codex"],
    });
  });

  it("rejects a saved companion option that is no longer offered by the model", () => {
    expect(
      resolveTaskIntent({
        utterance: "Implement device presence.",
        providers: [codexProvider],
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.6-sol",
          options: [{ id: "reasoningEffort", value: "max" }],
        },
      }),
    ).toEqual({
      status: "needs-input",
      reason: "selection-unavailable",
      prompt:
        "The saved reasoningEffort setting is no longer available for Sol. Choose it again in Jarvis Companion.",
      choices: [],
    });
  });

  it("rejects duplicate saved companion option IDs before adapter dispatch", () => {
    expect(
      resolveTaskIntent({
        utterance: "Implement device presence.",
        providers: [codexProvider],
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.6-sol",
          options: [
            { id: "reasoningEffort", value: "low" },
            { id: "reasoningEffort", value: "high" },
          ],
        },
      }),
    ).toEqual({
      status: "needs-input",
      reason: "selection-unavailable",
      prompt:
        "The saved reasoningEffort setting was selected more than once. Choose it again in Jarvis Companion.",
      choices: [],
    });
  });

  it("resolves a contextual cross-provider review when the provider has one model", () => {
    expect(
      resolveTaskIntent({
        utterance: "Jarvis, use Fable to review this Codex output.",
        providers: [codexProvider, fableProvider],
      }),
    ).toEqual({
      status: "ready",
      action: "review-context",
      objective: "Review this Codex output.",
      modelSelection: {
        instanceId: "fable",
        model: "fable-reviewer",
      },
    });
  });
});
