import { assert, describe, it } from "@effect/vitest";

import {
  normalizeCompanionProviders,
  readyCompanionProviders,
  validateCompanionDefault,
} from "./provider-defaults.ts";

const providers = normalizeCompanionProviders([
  {
    instanceId: "codex",
    displayName: "Codex",
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated" },
    models: [
      {
        slug: "gpt-5.6-sol",
        name: "Sol",
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
  },
  {
    instanceId: "cursor",
    enabled: true,
    installed: false,
    status: "error",
    auth: { status: "authenticated" },
    models: [{ slug: "agent", name: "Agent" }],
  },
]);

describe("companion voice defaults", () => {
  it("only offers ready configured providers", () => {
    assert.deepEqual(
      readyCompanionProviders(providers).map((provider) => provider.instanceId),
      ["codex"],
    );
  });

  it("persists a model selection only when the live host catalog supports it", () => {
    assert.deepEqual(
      validateCompanionDefault({
        providers,
        candidate: {
          instanceId: "codex",
          model: "gpt-5.6-sol",
          options: [{ id: "reasoningEffort", value: "high" }],
        },
      }),
      {
        ok: true,
        selection: {
          instanceId: "codex",
          model: "gpt-5.6-sol",
          options: [{ id: "reasoningEffort", value: "high" }],
        },
      },
    );
  });

  it("rejects an effort choice that the live model no longer offers", () => {
    assert.deepEqual(
      validateCompanionDefault({
        providers,
        candidate: {
          instanceId: "codex",
          model: "gpt-5.6-sol",
          options: [{ id: "reasoningEffort", value: "max" }],
        },
      }),
      { ok: false, message: "Choose a valid Reasoning effort setting." },
    );
  });
});
