import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";

import type { ComposerCommandItem } from "./ComposerCommandMenu";
import { searchSlashCommandItems } from "./composerSlashCommandSearch";

describe("searchSlashCommandItems", () => {
  const claudeDriver = ProviderDriverKind.make("claudeAgent");

  it("moves exact provider command matches ahead of broader description matches", () => {
    const items = [
      {
        id: "slash:default",
        type: "slash-command",
        command: "default",
        label: "/default",
        description: "Switch this thread back to normal build mode",
      },
      {
        id: "provider-slash-command:claudeAgent:ui",
        type: "provider-slash-command",
        provider: claudeDriver,
        command: { name: "ui" },
        label: "/ui",
        description: "Explore, build, and refine UI.",
      },
      {
        id: "provider-slash-command:claudeAgent:frontend-design",
        type: "provider-slash-command",
        provider: claudeDriver,
        command: { name: "frontend-design" },
        label: "/frontend-design",
        description: "Create distinctive, production-grade frontend interfaces",
      },
    ] satisfies Array<
      Extract<ComposerCommandItem, { type: "slash-command" | "provider-slash-command" }>
    >;

    expect(searchSlashCommandItems(items, "ui").map((item) => item.id)).toEqual([
      "provider-slash-command:claudeAgent:ui",
      "slash:default",
    ]);
  });

  it("supports fuzzy provider command matches", () => {
    const items = [
      {
        id: "provider-slash-command:claudeAgent:gh-fix-ci",
        type: "provider-slash-command",
        provider: claudeDriver,
        command: { name: "gh-fix-ci" },
        label: "/gh-fix-ci",
        description: "Fix failing GitHub Actions",
      },
      {
        id: "provider-slash-command:claudeAgent:github",
        type: "provider-slash-command",
        provider: claudeDriver,
        command: { name: "github" },
        label: "/github",
        description: "General GitHub help",
      },
    ] satisfies Array<
      Extract<ComposerCommandItem, { type: "slash-command" | "provider-slash-command" }>
    >;

    expect(searchSlashCommandItems(items, "gfc").map((item) => item.id)).toEqual([
      "provider-slash-command:claudeAgent:gh-fix-ci",
    ]);
  });

  it("finds models, skills, and user commands from the same slash query", () => {
    const items = [
      {
        id: "model:codex:gpt-5.4",
        type: "model",
        instanceId: ProviderInstanceId.make("codex"),
        provider: claudeDriver,
        model: "gpt-5.4",
        label: "GPT-5.4",
        description: "Codex",
      },
      {
        id: "skill:claudeAgent:code-review",
        type: "skill",
        provider: claudeDriver,
        skill: {
          name: "code-review",
          path: "/skills/code-review/SKILL.md",
          enabled: true,
        },
        label: "code-review",
        description: "Review code changes",
      },
      {
        id: "custom-command:pr-cr",
        type: "custom-command",
        command: {
          id: "review-pr",
          name: "pr-cr",
          description: "Review a pull request",
          prompt: "Review the current pull request.",
        },
        label: "/pr-cr",
        description: "Review a pull request",
      },
      {
        id: "custom-command:create",
        type: "create-custom-command",
        label: "/new-command",
        description: "Create a reusable workflow command",
      },
    ] satisfies ComposerCommandItem[];

    expect(searchSlashCommandItems(items, "gpt").map((item) => item.id)).toEqual([
      "model:codex:gpt-5.4",
    ]);
    expect(searchSlashCommandItems(items, "review").map((item) => item.id)).toEqual([
      "skill:claudeAgent:code-review",
      "custom-command:pr-cr",
    ]);
    expect(searchSlashCommandItems(items, "new").map((item) => item.id)).toEqual([
      "custom-command:create",
    ]);
  });
});
