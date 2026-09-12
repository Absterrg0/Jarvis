import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import {
  JARVIS_SEMANTIC_FALLBACK_MAX_ATTEMPTS,
  resolveJarvisSupervisorPlan,
  selectJarvisSemanticCandidates,
} from "./controllerHelpers.ts";

const baseProvider = (overrides: {
  readonly instanceId: string;
  readonly driver: string;
  readonly enabled?: boolean;
  readonly models?: ServerProvider["models"];
}): ServerProvider => {
  const { instanceId, driver, enabled } = overrides;
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make(driver),
    displayName: driver,
    enabled: enabled ?? true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-08-12T00:00:00.000Z",
    models: overrides.models ?? [
      {
        slug: `${driver}-default`,
        name: `${driver} default`,
        isCustom: false,
        isDefault: true,
        capabilities: null,
      },
    ],
    slashCommands: [],
    skills: [],
  } as ServerProvider;
};

const effortModel = (slug: string): ServerProvider["models"][number] => ({
  slug,
  name: slug,
  isCustom: false,
  isDefault: true,
  capabilities: {
    optionDescriptors: [
      {
        id: "reasoningEffort",
        label: "Reasoning",
        type: "select",
        options: [
          { id: "low", label: "Low" },
          { id: "medium", label: "Medium" },
        ],
      },
    ],
  },
});

describe("resolveJarvisSupervisorPlan", () => {
  const model = (slug: string, isDefault = false): ServerProvider["models"][number] => ({
    slug,
    name: slug,
    isCustom: false,
    isDefault,
    capabilities: null,
  });

  it("plans fx plus the running model for a Codex supervisor", () => {
    const codex = baseProvider({
      instanceId: "codex",
      driver: "codex",
      models: [model("gpt-5.6-sol"), model("gpt-5.6-luna", true)],
    });
    expect(
      resolveJarvisSupervisorPlan({
        activeSelection: { instanceId: codex.instanceId, model: "gpt-5.6-sol" },
        providers: [codex],
      }),
    ).toEqual({
      fx: { model: "gpt-5.6-sol" },
      provider: { instanceId: codex.instanceId, model: "gpt-5.6-sol" },
    });
  });

  it("keeps an OpenCode supervisor on its own provider with a cheap model", () => {
    const opencode = baseProvider({
      instanceId: "opencode",
      driver: "opencode",
      models: [model("openai/gpt-5.6-luna"), model("opencode-go/deepseek-v4.1-flash", true)],
    });
    expect(
      resolveJarvisSupervisorPlan({
        activeSelection: {
          instanceId: opencode.instanceId,
          model: "opencode-go/deepseek-v4.1-flash",
        },
        providers: [opencode],
      }),
    ).toEqual({
      provider: { instanceId: opencode.instanceId, model: "opencode-go/deepseek-v4.1-flash" },
    });
  });

  it("prefers Haiku for a Claude supervisor", () => {
    const claude = baseProvider({
      instanceId: "claude",
      driver: "claude",
      models: [model("claude-sonnet-5", true), model("claude-haiku-5")],
    });
    expect(resolveJarvisSupervisorPlan({ providers: [claude] })?.provider.model).toBe(
      "claude-haiku-5",
    );
  });

  it("returns null when no usable provider exists", () => {
    const disabled = baseProvider({ instanceId: "codex", driver: "codex", enabled: false });
    expect(resolveJarvisSupervisorPlan({ providers: [disabled] })).toBeNull();
  });
});

describe("selectJarvisSemanticCandidates", () => {
  it("keeps the configured supervisor first", () => {
    const configured = {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.6-luna",
    };
    const providers = [
      baseProvider({ instanceId: "opencode", driver: "opencode" }),
      baseProvider({ instanceId: "codex", driver: "codex" }),
    ];
    const candidates = selectJarvisSemanticCandidates({ configured, providers });
    expect(candidates[0]).toEqual(configured);
  });

  it("prefers opencode among fallbacks and bounds attempts", () => {
    const configured = {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.6-luna",
    };
    const providers = [
      baseProvider({ instanceId: "codex", driver: "codex" }),
      baseProvider({ instanceId: "claude", driver: "claudeAgent" }),
      baseProvider({ instanceId: "opencode", driver: "opencode" }),
      baseProvider({ instanceId: "cursor", driver: "cursor" }),
    ];
    const candidates = selectJarvisSemanticCandidates({ configured, providers });
    expect(candidates).toHaveLength(JARVIS_SEMANTIC_FALLBACK_MAX_ATTEMPTS);
    expect(candidates[0]?.instanceId).toBe("codex");
    expect(candidates[1]?.instanceId).toBe("opencode");
  });

  it("skips providers with no advertised model and unusable providers", () => {
    const configured = {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.6-luna",
    };
    const providers = [
      baseProvider({ instanceId: "codex", driver: "codex" }),
      baseProvider({ instanceId: "grokk", driver: "grok", models: [] }),
      baseProvider({ instanceId: "off", driver: "opencode", enabled: false }),
      baseProvider({ instanceId: "opencode", driver: "opencode" }),
    ];
    const candidates = selectJarvisSemanticCandidates({ configured, providers });
    const ids = candidates.map((candidate) => String(candidate.instanceId));
    expect(ids).toContain("codex");
    expect(ids).toContain("opencode");
    expect(ids).not.toContain("grokk");
    expect(ids).not.toContain("off");
  });

  it("uses the advertised default model and its effort descriptor, never a hardcoded driver model", () => {
    const configured = {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.6-luna",
    };
    const providers = [
      baseProvider({
        instanceId: "opencode",
        driver: "opencode",
        // The driver map once said openai/gpt-5; this instance advertises
        // Alon-2.0 and that is what must be used.
        models: [effortModel("Alon-2.0")],
      }),
    ];
    const candidates = selectJarvisSemanticCandidates({ configured, providers });
    expect(candidates[1]).toMatchObject({
      instanceId: "opencode",
      model: "Alon-2.0",
      options: [{ id: "reasoningEffort", value: "low" }],
    });
  });
});
