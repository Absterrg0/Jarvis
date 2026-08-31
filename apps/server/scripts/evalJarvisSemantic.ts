// @effect-diagnostics nodeBuiltinImport:off - standalone eval mirrors the production Codex process boundary.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationProjectShell,
  type OrchestrationThread,
  type ServerProvider,
} from "@t3tools/contracts";
import {
  buildJarvisSemanticPrompt,
  interpretJarvisCommand,
  JarvisSemanticIntent,
  prepareJarvisSemanticTurn,
  type JarvisCommandContext,
  type JarvisCommandTask,
} from "@t3tools/jarvis-core/command";
import * as Schema from "effect/Schema";

import { toJsonSchemaObject } from "../src/textGeneration/TextGenerationUtils.ts";
import {
  jarvisSemanticEvalCorpus,
  type JarvisSemanticEvalCase,
} from "./jarvisSemanticEvalCorpus.ts";

const projects: ReadonlyArray<OrchestrationProjectShell> = [
  {
    id: ProjectId.make("eval-project-jarvis"),
    title: "Jarvis",
    workspaceRoot: "/eval/jarvis",
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-08-31T00:00:00.000Z",
    updatedAt: "2026-08-31T00:00:00.000Z",
  },
  {
    id: ProjectId.make("eval-project-rivvl"),
    title: "Rivvl",
    workspaceRoot: "/eval/rivvl",
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-08-31T00:00:00.000Z",
    updatedAt: "2026-08-31T00:00:00.000Z",
  },
  {
    id: ProjectId.make("eval-project-vps"),
    title: "VPS",
    workspaceRoot: "/eval/vps",
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-08-31T00:00:00.000Z",
    updatedAt: "2026-08-31T00:00:00.000Z",
  },
];

const codex: ServerProvider = {
  instanceId: ProviderInstanceId.make("eval-codex"),
  driver: ProviderDriverKind.make("codex"),
  displayName: "Codex",
  enabled: true,
  installed: true,
  version: "eval",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-08-31T00:00:00.000Z",
  models: [
    {
      slug: "gpt-5.6-luna",
      name: "GPT-5.6 Luna",
      shortName: "Luna",
      isCustom: false,
      isDefault: true,
      capabilities: null,
    },
    {
      slug: "gpt-5.6-sol",
      name: "GPT-5.6 Sol",
      shortName: "Sol",
      isCustom: false,
      isDefault: false,
      capabilities: null,
    },
  ],
  slashCommands: [],
  skills: [],
};

const claude: ServerProvider = {
  ...codex,
  instanceId: ProviderInstanceId.make("eval-claude"),
  driver: ProviderDriverKind.make("claude"),
  displayName: "Claude",
  models: [
    {
      slug: "claude-sonnet",
      name: "Claude Sonnet",
      shortName: "Sonnet",
      isCustom: false,
      isDefault: true,
      capabilities: null,
    },
  ],
};

const taskSpecs = [
  {
    threadId: ThreadId.make("eval-thread-rivvl-auth"),
    projectId: projects[1]!.id,
    projectTitle: "Rivvl",
    title: "Rivvl authentication",
    objective: "Fix token refresh and login redirects",
    state: "running" as const,
  },
  {
    threadId: ThreadId.make("eval-thread-checkout"),
    projectId: projects[0]!.id,
    projectTitle: "Jarvis",
    title: "Checkout cleanup",
    objective: "Remove dead checkout branches",
    state: "ready" as const,
  },
  {
    threadId: ThreadId.make("eval-thread-deployment"),
    projectId: projects[2]!.id,
    projectTitle: "VPS",
    title: "Deployment rollout",
    objective: "Roll the worker update across the VPS nodes",
    state: "running" as const,
  },
  {
    threadId: ThreadId.make("eval-thread-docs"),
    projectId: projects[0]!.id,
    projectTitle: "Jarvis",
    title: "Release docs",
    objective: "Write the release and upgrade documentation",
    state: "ready" as const,
  },
] satisfies ReadonlyArray<JarvisCommandTask>;

const contextThread: OrchestrationThread = {
  id: taskSpecs[3]!.threadId,
  projectId: taskSpecs[3]!.projectId,
  title: taskSpecs[3]!.title,
  modelSelection: { instanceId: codex.instanceId, model: "gpt-5.6-luna" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: "2026-08-31T00:00:00.000Z",
  updatedAt: "2026-08-31T00:00:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  deletedAt: null,
  messages: [
    {
      id: MessageId.make("eval-message-docs"),
      role: "assistant",
      text: "The base release notes are complete.",
      turnId: null,
      streaming: false,
      createdAt: "2026-08-31T00:00:00.000Z",
      updatedAt: "2026-08-31T00:00:00.000Z",
    },
  ],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: null,
};

function contextFor(entry: JarvisSemanticEvalCase): JarvisCommandContext {
  return {
    utterance: entry.utterance,
    currentProjectId: projects[0]!.id,
    projects,
    aliases: [],
    tasks: taskSpecs.map((task) => ({
      threadId: task.threadId,
      projectId: task.projectId,
      title: task.title,
      objective: task.objective,
      state: task.state,
    })),
    recentCommandTasks: taskSpecs,
    focusedTask: taskSpecs[3]!,
    contextTask: taskSpecs[3]!,
    contextThread,
    providers: [codex, claude],
    supervisorModelSelection: {
      instanceId: codex.instanceId,
      model: "gpt-5.6-luna",
      options: [{ id: "reasoningEffort", value: "low" }],
    },
    nodeDefaultModelSelection: { instanceId: codex.instanceId, model: "gpt-5.6-luna" },
    continueContext: entry.continueContext === true,
  };
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function score(expected: string | undefined, actual: string | null): boolean | undefined {
  return expected === undefined ? undefined : actual === expected;
}

const model = option("--model") ?? "gpt-5.6-luna";
const effort = option("--effort") ?? "low";
const caseFilter = option("--case");
const requestedLimit = Number(option("--limit") ?? jarvisSemanticEvalCorpus.length);
if (!Number.isInteger(requestedLimit) || requestedLimit < 1) {
  throw new Error("--limit must be a positive integer.");
}
const jsonOutput = process.argv.includes("--json");
const selectedCases = jarvisSemanticEvalCorpus
  .filter((entry) => caseFilter === undefined || entry.id.includes(caseFilter))
  .slice(0, requestedLimit);
if (selectedCases.length === 0) throw new Error("No semantic eval cases matched.");

const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "jarvis-semantic-eval-"));
const schemaPath = NodePath.join(directory, "intent.schema.json");
NodeFS.writeFileSync(schemaPath, JSON.stringify(toJsonSchemaObject(JarvisSemanticIntent)), "utf8");
const decodeIntent = Schema.decodeUnknownSync(JarvisSemanticIntent);
const results: Array<{
  id: string;
  expectedAction: string;
  actualAction?: string;
  actionCorrect: boolean;
  taskCorrect?: boolean;
  projectCorrect?: boolean;
  providerCorrect?: boolean;
  clarification?: string;
  error?: string;
}> = [];

try {
  for (const [index, entry] of selectedCases.entries()) {
    const context = contextFor(entry);
    const prepared = prepareJarvisSemanticTurn(context);
    if (prepared.status !== "ready") {
      results.push({
        id: entry.id,
        expectedAction: entry.action,
        actionCorrect: false,
        clarification: prepared.reason,
        error: "The deterministic preflight rejected the eval fixture.",
      });
      continue;
    }
    const outputPath = NodePath.join(directory, `${entry.id}.json`);
    const run = NodeChildProcess.spawnSync(
      process.env.JARVIS_SEMANTIC_EVAL_CODEX ?? "codex",
      [
        "exec",
        "--ignore-user-config",
        "--ignore-rules",
        "--disable",
        "shell_tool",
        "--disable",
        "apps",
        "--disable",
        "browser_use",
        "--disable",
        "computer_use",
        "--disable",
        "image_generation",
        "--disable",
        "unified_exec",
        "--disable",
        "code_mode_host",
        "--disable",
        "multi_agent",
        "--disable",
        "in_app_browser",
        "--disable",
        "view_image",
        "--disable",
        "workspace_dependencies",
        "--disable",
        "plugins",
        "--disable",
        "hooks",
        "--ephemeral",
        "--skip-git-repo-check",
        "--sandbox",
        "read-only",
        "--model",
        model,
        "--config",
        `model_reasoning_effort="${effort}"`,
        "--output-schema",
        schemaPath,
        "--output-last-message",
        outputPath,
        "-",
      ],
      {
        cwd: directory,
        input: buildJarvisSemanticPrompt(context, prepared),
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        timeout: 120_000,
      },
    );
    if (run.status !== 0) {
      const detail = (
        run.error?.message ||
        run.stderr ||
        run.stdout ||
        `codex exited ${run.status}`
      )
        .trim()
        .slice(-2_000);
      results.push({
        id: entry.id,
        expectedAction: entry.action,
        actionCorrect: false,
        error: detail,
      });
      if (!jsonOutput)
        process.stdout.write(`[${index + 1}/${selectedCases.length}] ${entry.id}: ERROR\n`);
      continue;
    }
    try {
      const intent = decodeIntent(JSON.parse(NodeFS.readFileSync(outputPath, "utf8")));
      const interpretation = interpretJarvisCommand(context, prepared, intent);
      const taskCorrect = score(entry.task, intent.task);
      const projectCorrect = score(entry.project, intent.project);
      const providerCorrect = score(entry.provider, intent.provider);
      const result = {
        id: entry.id,
        expectedAction: entry.action,
        actualAction: intent.action,
        actionCorrect: intent.action === entry.action,
        ...(taskCorrect === undefined ? {} : { taskCorrect }),
        ...(projectCorrect === undefined ? {} : { projectCorrect }),
        ...(providerCorrect === undefined ? {} : { providerCorrect }),
        ...(interpretation.status === "needs-input"
          ? { clarification: interpretation.reason }
          : {}),
      };
      results.push(result);
      if (!jsonOutput) {
        const passed =
          result.actionCorrect &&
          result.taskCorrect !== false &&
          result.projectCorrect !== false &&
          result.providerCorrect !== false &&
          result.clarification === undefined;
        process.stdout.write(
          `[${index + 1}/${selectedCases.length}] ${entry.id}: ${passed ? "PASS" : "MISS"} (${intent.action})\n`,
        );
      }
    } catch (error) {
      results.push({
        id: entry.id,
        expectedAction: entry.action,
        actionCorrect: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
} finally {
  NodeFS.rmSync(directory, { recursive: true, force: true });
}

const metric = (key: "actionCorrect" | "taskCorrect" | "projectCorrect" | "providerCorrect") => {
  const values = results.flatMap((result) =>
    result[key] === undefined ? [] : [result[key] === true],
  );
  return {
    correct: values.filter(Boolean).length,
    total: values.length,
    accuracy: values.length === 0 ? null : values.filter(Boolean).length / values.length,
  };
};
const report = {
  model,
  effort,
  cases: results.length,
  action: metric("actionCorrect"),
  taskSelection: metric("taskCorrect"),
  projectSelection: metric("projectCorrect"),
  providerSelection: metric("providerCorrect"),
  clarificationRate:
    results.length === 0
      ? null
      : results.filter((result) => result.clarification !== undefined).length / results.length,
  errors: results.filter((result) => result.error !== undefined).length,
  results,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (report.errors > 0) process.exitCode = 1;
