import {
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationProjectShell,
  type OrchestrationThread,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  interpretJarvisCommand,
  type JarvisCommandTask,
  type JarvisCommand,
  type JarvisCommandContext,
} from "./command.ts";

const jarvis: OrchestrationProjectShell = {
  id: ProjectId.make("project-jarvis"),
  title: "Jarvis",
  workspaceRoot: "/workspace/jarvis",
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-08-30T00:00:00.000Z",
  updatedAt: "2026-08-30T00:00:00.000Z",
};

const fable: OrchestrationProjectShell = {
  ...jarvis,
  id: ProjectId.make("project-fable"),
  title: "Fable",
  workspaceRoot: "/workspace/fable",
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
      capabilities: null,
    },
  ],
  slashCommands: [],
  skills: [],
};

const fableProvider: ServerProvider = {
  ...codex,
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

const task: JarvisCommandTask = {
  threadId: ThreadId.make("thread-auth"),
  projectId: jarvis.id,
  projectTitle: jarvis.title,
  title: "Authentication review",
  objective: "Fix authentication",
  modelSelection: { instanceId: codex.instanceId, model: "gpt-5.6-sol" },
  runtimeMode: "full-access",
  interactionMode: "default",
  state: "running",
};

const sourceThread: OrchestrationThread = {
  id: task.threadId,
  projectId: task.projectId,
  title: task.title,
  modelSelection: task.modelSelection,
  runtimeMode: task.runtimeMode,
  interactionMode: task.interactionMode,
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: "2026-08-30T00:00:00.000Z",
  updatedAt: "2026-08-30T00:00:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  deletedAt: null,
  messages: [
    {
      id: MessageId.make("message-output"),
      role: "assistant",
      text: "The completed output.",
      turnId: null,
      streaming: false,
      createdAt: "2026-08-30T00:00:00.000Z",
      updatedAt: "2026-08-30T00:00:00.000Z",
    },
  ],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: null,
};

function context(overrides: Partial<JarvisCommandContext> = {}): JarvisCommandContext {
  return {
    utterance: "Implement device presence.",
    currentProjectId: jarvis.id,
    projects: [jarvis, fable],
    aliases: [],
    tasks: [],
    providers: [codex, fableProvider],
    continueContext: false,
    ...overrides,
  };
}

function commandType(command: JarvisCommand): JarvisCommand["type"] {
  switch (command.type) {
    case "start":
    case "continue":
    case "queue":
    case "stop":
    case "status":
    case "review":
    case "reroute":
    case "switch-focus":
    case "answer":
    case "list-projects":
      return command.type;
    default:
      return command;
  }
}

describe("interpretJarvisCommand", () => {
  it.each([
    ["start", "Implement device presence.", context({ modelSelection: task.modelSelection })],
    [
      "continue",
      "Add an integration test.",
      context({ contextThread: sourceThread, contextTask: task, continueContext: true }),
    ],
    ["queue", "after that add release notes", context({ focusedTask: task })],
    ["stop", "stop it", context({ focusedTask: task })],
    ["status", "status update", context({ focusedTask: task })],
    ["switch-focus", "switch to the Fable project", context()],
    [
      "switch-focus",
      "switch to the authentication review task",
      context({
        tasks: [{ ...task, title: task.title, objective: task.objective, state: task.state }],
      }),
    ],
    [
      "review",
      "use Fable Reviewer to review this",
      context({ contextThread: sourceThread, contextTask: task }),
    ],
    ["reroute", "do that last run in the Fable project", context({ focusedTask: task })],
  ] as const)("returns one %s command", (expectedType, utterance, input) => {
    const result = interpretJarvisCommand({ ...input, utterance });
    expect(result.status).toBe("command");
    if (result.status === "command") expect(commandType(result.command)).toBe(expectedType);
  });

  it("answers an approval and a worker question as typed commands", () => {
    const approval: OrchestrationThread = {
      ...sourceThread,
      activities: [
        {
          id: EventId.make("approval-request"),
          tone: "approval",
          kind: "approval.requested",
          summary: "Allow command",
          payload: { requestId: "approval-1" },
          turnId: null,
          createdAt: "2026-08-30T00:00:00.000Z",
        },
      ],
    };
    const approvalResult = interpretJarvisCommand(
      context({ utterance: "yes, allow it", contextThread: approval, contextTask: task }),
    );
    expect(approvalResult).toMatchObject({
      status: "command",
      command: {
        type: "answer",
        reply: { type: "approval", requestId: "approval-1", decision: "accept" },
      },
    });

    const inputThread: OrchestrationThread = {
      ...sourceThread,
      activities: [
        {
          id: EventId.make("input-request"),
          tone: "info",
          kind: "user-input.requested",
          summary: "Need input",
          payload: { requestId: "input-1", questions: [{ id: "choice" }] },
          turnId: null,
          createdAt: "2026-08-30T00:00:00.000Z",
        },
      ],
    };
    const inputResult = interpretJarvisCommand(
      context({ utterance: "the safe option", contextThread: inputThread, contextTask: task }),
    );
    expect(inputResult).toMatchObject({
      status: "command",
      command: {
        type: "answer",
        reply: { type: "input", requestId: "input-1", questionIds: ["choice"] },
      },
    });
  });

  it("returns a single bounded clarification for an ambiguous project", () => {
    const result = interpretJarvisCommand(
      context({
        utterance: "Switch to the cut project",
        projects: [
          {
            ...jarvis,
            id: ProjectId.make("project-code"),
            title: "Code",
            workspaceRoot: "/workspace/code",
          },
          {
            ...fable,
            id: ProjectId.make("project-cat"),
            title: "Cat",
            workspaceRoot: "/workspace/cat",
          },
        ],
      }),
    );
    expect(result).toMatchObject({ status: "needs-input", reason: "control-target-required" });
    if (result.status === "needs-input")
      expect(result.projectClarification?.candidates).toHaveLength(2);
  });

  it("rejects malformed and unavailable selections without guessing", () => {
    expect(interpretJarvisCommand(context({ utterance: "..." }))).toMatchObject({
      status: "needs-input",
      reason: "unsupported-command",
    });
    expect(
      interpretJarvisCommand(
        context({
          utterance: "Fix it",
          modelSelection: { instanceId: ProviderInstanceId.make("retired"), model: "old" },
        }),
      ),
    ).toMatchObject({ status: "needs-input", reason: "provider-not-found" });
  });
});
