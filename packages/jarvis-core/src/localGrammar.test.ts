import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationProjectShell,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  interpretJarvisCommand,
  prepareJarvisSemanticTurn,
  type JarvisCommandContext,
  type JarvisCommandTask,
} from "./command.ts";
import { deleteSourceSpans } from "./destinationSpan.ts";
import {
  JARVIS_LOCAL_TIER_DEFAULT,
  tryBoundedLocalGrammar,
  tryJarvisLocalTier,
} from "./localGrammar.ts";

const jarvis: OrchestrationProjectShell = {
  id: ProjectId.make("project-jarvis"),
  title: "Jarvis",
  workspaceRoot: "/workspace/jarvis",
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-08-30T00:00:00.000Z",
  updatedAt: "2026-08-30T00:00:00.000Z",
};
const rivvl: OrchestrationProjectShell = {
  ...jarvis,
  id: ProjectId.make("project-rivvl"),
  title: "Rivvl",
  workspaceRoot: "/workspace/rivvl",
};
const app: OrchestrationProjectShell = {
  ...jarvis,
  id: ProjectId.make("project-app"),
  title: "App",
  workspaceRoot: "/workspace/app",
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

const authTask: JarvisCommandTask = {
  threadId: ThreadId.make("thread-rivvl-auth"),
  projectId: rivvl.id,
  projectTitle: rivvl.title,
  title: "Rivvl authentication",
  objective: "Fix token refresh and login redirects",
  state: "running",
};

function context(overrides: Partial<JarvisCommandContext> = {}): JarvisCommandContext {
  return {
    utterance: "Fix the login redirect in Rivvl.",
    currentProjectId: jarvis.id,
    projects: [jarvis, rivvl],
    aliases: [],
    tasks: [],
    recentCommandTasks: [authTask],
    focusedTask: authTask,
    contextTask: authTask,
    providers: [codex],
    supervisorModelSelection: { instanceId: codex.instanceId, model: "gpt-5.6-sol" },
    nodeDefaultModelSelection: { instanceId: codex.instanceId, model: "gpt-5.6-sol" },
    continueContext: false,
    ...overrides,
  };
}

const ready = (input: JarvisCommandContext) => {
  const prepared = prepareJarvisSemanticTurn({ ...input, utterance: input.utterance });
  if (prepared.status !== "ready") throw new Error(prepared.prompt);
  return prepared;
};

describe("bounded local grammar positives", () => {
  it("declines multiword start objects to the provider tier, narrowing the automatic path", () => {
    // Changed contract: the parser automatic path takes one technical
    // identifier only. "Fix the login redirect in Rivvl." declines here and
    // stays eligible through the ordinary provider plus Director path.
    // Decline is not refusal.
    const source = "Fix the login redirect in Rivvl.";
    const outcome = tryBoundedLocalGrammar({ source, context: context({ utterance: source }) });
    expect(outcome.status).toBe("decline");
  });

  it("proposes single-token auth in Rivvl with a canonical destination wrapper", () => {
    const source = "Fix auth in Rivvl.";
    const outcome = tryBoundedLocalGrammar({ source, context: context({ utterance: source }) });
    expect(outcome.status).toBe("proposal");
    if (outcome.status !== "proposal") return;
    expect(outcome.proposal.action).toBe("start");
    const destination = outcome.proposal.refs.find((ref) => ref.role === "destination");
    expect(destination?.value).toBe("Rivvl");
    expect(destination?.span.text).toBe(" in Rivvl");
    expect(source.slice(destination!.span.start, destination!.span.end)).toBe(" in Rivvl");
    const joined = deleteSourceSpans(source, [
      { start: destination!.span.start, end: destination!.span.end },
    ]);
    expect(joined).toBe("Fix auth.");
    const interpreted = interpretJarvisCommand(
      context({ utterance: source }),
      ready(context({ utterance: source })),
      outcome.proposal,
    );
    expect(interpreted.status).toBe("command");
  });

  it("accepts ARIS invocation and Jarvis compatibility with source preserved", () => {
    for (const invocation of ["ARIS, check auth in Rivvl", "Jarvis, check auth in Rivvl"]) {
      const outcome = tryBoundedLocalGrammar({
        source: invocation,
        context: context({ utterance: invocation }),
      });
      expect(outcome.status).toBe("proposal");
      if (outcome.status !== "proposal") continue;
      const destination = outcome.proposal.refs.find((ref) => ref.role === "destination");
      expect(destination?.value).toBe("Rivvl");
      expect(invocation.slice(destination!.span.start, destination!.span.end)).toBe(
        destination!.span.text,
      );
      const joined = deleteSourceSpans(invocation, [
        { start: destination!.span.start, end: destination!.span.end },
      ]);
      expect(joined).toContain("check auth");
      expect(joined).toContain(invocation.startsWith("ARIS") ? "ARIS," : "Jarvis,");
    }
  });

  it("counts UTF-16 code units like slice with a leading surrogate pair", () => {
    const source = "🚀 Fix auth in Rivvl.";
    const outcome = tryBoundedLocalGrammar({ source, context: context({ utterance: source }) });
    expect(outcome.status).toBe("proposal");
    if (outcome.status !== "proposal") return;
    const destination = outcome.proposal.refs.find((ref) => ref.role === "destination");
    expect(destination).toBeDefined();
    expect(source.slice(destination!.span.start, destination!.span.end)).toBe(
      destination!.span.text,
    );
    expect(destination!.span.start).toBeGreaterThan(2);
  });

  it("proposes list, bare status, bare stop, and focus where bounded", () => {
    expect(
      tryBoundedLocalGrammar({
        source: "List projects",
        context: context({ utterance: "List projects" }),
      }),
    ).toMatchObject({ status: "proposal", proposal: { action: "list-projects" } });
    expect(
      tryBoundedLocalGrammar({ source: "status", context: context({ utterance: "status" }) }),
    ).toMatchObject({ status: "proposal", proposal: { action: "status" } });
    expect(
      tryBoundedLocalGrammar({ source: "stop", context: context({ utterance: "stop" }) }),
    ).toMatchObject({ status: "proposal", proposal: { action: "stop" } });
    const focusProject = tryBoundedLocalGrammar({
      source: "Switch to Rivvl",
      context: context({ utterance: "Switch to Rivvl" }),
    });
    expect(focusProject).toMatchObject({
      status: "proposal",
      proposal: { action: "focus-project" },
    });
    const focusTask = tryBoundedLocalGrammar({
      source: "Focus Rivvl authentication",
      context: context({ utterance: "Focus Rivvl authentication" }),
    });
    expect(focusTask).toMatchObject({ status: "proposal", proposal: { action: "focus-task" } });
    const statusTask = tryBoundedLocalGrammar({
      source: "What is the status of Rivvl authentication?",
      context: context({ utterance: "What is the status of Rivvl authentication?" }),
    });
    expect(statusTask).toMatchObject({ status: "proposal", proposal: { action: "status" } });
    const stopTask = tryBoundedLocalGrammar({
      source: "Stop Rivvl authentication",
      context: context({ utterance: "Stop Rivvl authentication" }),
    });
    expect(stopTask).toMatchObject({ status: "proposal", proposal: { action: "stop" } });
  });

  it("resolves through catalogs, never substrings", () => {
    const source = "make it happen";
    const outcome = tryBoundedLocalGrammar({
      source,
      context: context({ utterance: source, projects: [app, jarvis] }),
    });
    expect(outcome.status).toBe("decline");
  });
});

describe("bounded local grammar negatives never partially dispatch", () => {
  it("declines multiword exclusions to the provider tier, never a destination", () => {
    // Changed contract: single object only. "Check auth but not in Jarvis"
    // declines here and stays eligible through provider plus Director.
    // The validator stays fail-closed for excluded destinations.
    const source = "Check auth but not in Jarvis";
    const outcome = tryBoundedLocalGrammar({ source, context: context({ utterance: source }) });
    expect(outcome.status).toBe("decline");
  });

  it("declines quoted wrappers with no parser dispatch", () => {
    const source = 'Check auth in "Rivvl"';
    const outcome = tryBoundedLocalGrammar({ source, context: context({ utterance: source }) });
    // Outside the closed shape: decline to the provider tier. The validator
    // stays fail-closed for quoted authorizations.
    expect(outcome.status).toBe("decline");
  });

  it("declines two-action turns with no parser dispatch", () => {
    const source = "Stop Rivvl authentication, then create a deployment task";
    const outcome = tryBoundedLocalGrammar({ source, context: context({ utterance: source }) });
    expect(outcome.status).toBe("decline");
    expect(outcome).not.toMatchObject({ status: "command" });
  });

  it("declines fix-then-add and single-task steps with its", () => {
    const compound = tryBoundedLocalGrammar({
      source: "Fix auth then add release notes.",
      context: context({ utterance: "Fix auth then add release notes." }),
    });
    // No destination and multiword shape: decline to the provider tier.
    expect(compound.status).toBe("decline");
    const single = tryBoundedLocalGrammar({
      source: "Fix auth, then run its tests",
      context: context({ utterance: "Fix auth, then run its tests" }),
    });
    expect(single.status).toBe("decline");
  });

  it("declines and-, also-, and comma-joined turns with no parser dispatch", () => {
    for (const source of [
      "Stop auth and create deployment task",
      "Fix auth and add release notes",
      "Stop auth, create deployment task",
      "Stop auth also create deployment task",
    ]) {
      const outcome = tryBoundedLocalGrammar({ source, context: context({ utterance: source }) });
      expect(outcome.status).toBe("decline");
      expect(outcome).not.toMatchObject({ status: "command" });
    }
  });

  it("declines multiword work to the provider tier as changed contract", () => {
    // Changed contract: single technical identifier only. Multiword objects
    // decline here and stay eligible through provider plus Director.
    const source = "Fix auth with retries and backoff in Rivvl";
    const outcome = tryBoundedLocalGrammar({ source, context: context({ utterance: source }) });
    expect(outcome.status).toBe("decline");
  });

  it("declines sequenced controls by shape with no verb lists", () => {
    // Regression: "Fix auth then stop deployment in Rivvl" proposed start.
    // One token cannot carry another clause, so then/and sequences and
    // unknown synonyms decline by shape alone. No suspend list exists.
    for (const source of [
      "Fix auth then stop deployment in Rivvl",
      "Fix auth and suspend deployment in Rivvl",
      "Update billing copy and stop sync in Rivvl",
      "In Rivvl, build cache then halt sync",
    ]) {
      expect(
        tryBoundedLocalGrammar({ source, context: context({ utterance: source }) }).status,
      ).toBe("decline");
    }
  });
});

describe("closed start matrix over names", () => {
  const run = (source: string, overrides: Partial<JarvisCommandContext> = {}) =>
    tryBoundedLocalGrammar({ source, context: context({ utterance: source, ...overrides }) });

  it("proposes single-token Test and Fix turns with exact source spans", () => {
    for (const source of [
      "Fix auth in Rivvl",
      "Please fix auth in Rivvl",
      "ARIS, test auth in Rivvl",
      "In Rivvl, fix auth",
      "In Rivvl, test auth.",
      "Fix v2.0 in Rivvl",
    ]) {
      const outcome = run(source);
      expect(outcome.status).toBe("proposal");
      if (outcome.status !== "proposal") continue;
      expect(outcome.proposal.action).toBe("start");
      const destination = outcome.proposal.refs.find((ref) => ref.role === "destination");
      expect(destination?.value).toBe("Rivvl");
      expect(source.slice(destination!.span.start, destination!.span.end)).toBe(
        destination!.span.text,
      );
    }
  });

  it("declines multiword start objects as changed contract, not refusal", () => {
    for (const source of [
      "Test auth sync in Rivvl",
      "Fix the login redirect in Rivvl.",
      "In Rivvl, fix the flaky test",
      "In Rivvl, test auth sync.",
      "Fix API v2.0 retry/timeout in Rivvl",
    ]) {
      expect(run(source).status).toBe("decline");
    }
  });

  it("declines meta questions and stop-shaped trailing mentions", () => {
    for (const source of [
      "What is running in Rivvl?",
      "In Rivvl, what is running?",
      "Stop auth in Rivvl",
      "Fix in Rivvl",
      "Fix the very long auth flow with many retries and backoffs today please in Rivvl",
      'Fix "auth and tests" in Rivvl',
      "Fix auth, then deploy in Rivvl",
      "Stop Rivvl authentication, then create a deployment task",
      "Fix auth then add release notes.",
    ]) {
      expect(run(source).status).toBe("decline");
    }
  });

  it("declines multiword negation to the provider tier", () => {
    // Changed contract: single object only. Multiword negation declines
    // here; the validator stays fail-closed for excluded evidence.
    const source = "Test auth but not in Rivvl.";
    const outcome = run(source);
    expect(outcome.status).toBe("decline");
  });

  it("proposes duplicates so the Director reports ambiguity, never a parser guess", () => {
    const dup: OrchestrationProjectShell = {
      ...rivvl,
      id: ProjectId.make("project-rivvl-2"),
    };
    const source = "Fix auth in Rivvl";
    const outcome = run(source, { projects: [rivvl, dup] });
    expect(outcome.status).toBe("proposal");
    if (outcome.status !== "proposal") return;
    const interpreted = interpretJarvisCommand(
      context({ utterance: source, projects: [rivvl, dup] }),
      ready(context({ utterance: source, projects: [rivvl, dup] })),
      outcome.proposal,
    );
    expect(interpreted.status).toBe("needs-input");
  });
});

describe("local-tier seam stays a disabled hook", () => {
  it("defaults to disabled and never proposes", () => {
    expect(JARVIS_LOCAL_TIER_DEFAULT).toEqual({ mode: "disabled" });
    const result = tryJarvisLocalTier({
      source: "Fix auth in Rivvl.",
      context: context({ utterance: "Fix auth in Rivvl." }),
    });
    expect(result).toEqual({ status: "decline", reason: "local-tier-disabled" });
  });

  it("never activates local inference, even in restricted mode", () => {
    const result = tryJarvisLocalTier({
      source: "Fix auth in Rivvl.",
      context: context({ utterance: "Fix auth in Rivvl." }),
      config: { mode: "restricted" },
    });
    expect(result).toEqual({ status: "decline", reason: "local-tier-disabled" });
  });
});
