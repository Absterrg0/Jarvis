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
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  buildJarvisSemanticPrompt,
  interpretJarvisCommand,
  JarvisSemanticIntent,
  prepareJarvisSemanticTurn,
  type JarvisCommand,
  type JarvisCommandContext,
  type JarvisCommandTask,
  type PreparedJarvisSemanticTurn,
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
      capabilities: {
        optionDescriptors: [
          {
            id: "reasoningEffort",
            label: "Reasoning",
            type: "select",
            options: [
              { id: "medium", label: "Medium", isDefault: true },
              { id: "high", label: "High" },
            ],
          },
        ],
      },
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
    supervisorModelSelection: {
      instanceId: codex.instanceId,
      model: "gpt-5.6-sol",
      options: [{ id: "reasoningEffort", value: "medium" }],
    },
    nodeDefaultModelSelection: task.modelSelection,
    continueContext: false,
    ...overrides,
  };
}

function intent(overrides: Partial<JarvisSemanticIntent> = {}): JarvisSemanticIntent {
  return {
    action: "start",
    project: null,
    task: null,
    instruction: null,
    provider: null,
    model: null,
    effort: null,
    ...overrides,
  };
}

function ready(
  input: JarvisCommandContext,
): Extract<PreparedJarvisSemanticTurn, { status: "ready" }> {
  const prepared = prepareJarvisSemanticTurn(input);
  if (prepared.status !== "ready") throw new Error(prepared.prompt);
  return prepared;
}

function interpret(input: JarvisCommandContext, proposal: JarvisSemanticIntent) {
  return interpretJarvisCommand(input, ready(input), proposal);
}

function commandType(command: JarvisCommand): JarvisCommand["type"] {
  return command.type;
}

describe("Jarvis semantic command boundary", () => {
  it.each([
    ["start", context(), intent({ instruction: "Implement device presence." })],
    [
      "continue",
      context({ contextThread: sourceThread, contextTask: task, continueContext: true }),
      intent({ action: "continue", instruction: "Add an integration test." }),
    ],
    [
      "queue",
      context({ focusedTask: task }),
      intent({ action: "queue", instruction: "Add release notes." }),
    ],
    ["stop", context({ focusedTask: task }), intent({ action: "stop" })],
    ["status", context({ focusedTask: task }), intent({ action: "status" })],
    ["switch-focus", context(), intent({ action: "focus-project", project: "Fable" })],
    [
      "switch-focus",
      context({ tasks: [{ ...task, state: task.state }] }),
      intent({ action: "focus-task", task: "Authentication review" }),
    ],
    [
      "review",
      context({ contextThread: sourceThread, contextTask: task }),
      intent({
        action: "review",
        instruction: "Review the completed output.",
        provider: "Fable",
        model: "Reviewer",
      }),
    ],
    ["reroute", context({ focusedTask: task }), intent({ action: "reroute", project: "Fable" })],
    ["list-projects", context(), intent({ action: "list-projects" })],
  ] as const)("accepts one validated %s proposal", (expectedType, input, proposal) => {
    const result = interpret(input, proposal);
    expect(result.status).toBe("command");
    if (result.status === "command") expect(commandType(result.command)).toBe(expectedType);
  });

  it("resolves provider, model, and reasoning against the live catalog", () => {
    const result = interpret(
      context(),
      intent({
        instruction: "Implement device presence.",
        provider: "Codex",
        model: "Sol",
        effort: "High",
      }),
    );
    expect(result).toMatchObject({
      status: "command",
      command: {
        type: "start",
        modelSelection: {
          instanceId: codex.instanceId,
          model: "gpt-5.6-sol",
          options: [{ id: "reasoningEffort", value: "high" }],
        },
      },
    });
  });

  it("answers typed approval and worker-input state without granting model authority", () => {
    const approvalThread: OrchestrationThread = {
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
    expect(
      interpret(
        context({
          utterance: "Allow it.",
          contextThread: approvalThread,
          contextTask: task,
          continueContext: true,
        }),
        intent({ action: "continue", instruction: "Allow it." }),
      ),
    ).toMatchObject({
      status: "command",
      command: {
        type: "answer",
        reply: { type: "approval", requestId: "approval-1", decision: "accept" },
      },
    });

    expect(
      interpret(
        context({
          utterance: "Keep working on it.",
          contextThread: approvalThread,
          contextTask: task,
          continueContext: true,
        }),
        intent({ action: "continue", instruction: "Allow it." }),
      ),
    ).toMatchObject({ status: "needs-input", choices: ["allow", "deny"] });

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
    expect(
      interpret(
        context({ contextThread: inputThread, contextTask: task, continueContext: true }),
        intent({ action: "continue", instruction: "Use the safe option." }),
      ),
    ).toMatchObject({
      status: "command",
      command: {
        type: "answer",
        reply: { type: "input", requestId: "input-1", questionIds: ["choice"] },
      },
    });
  });

  it("resolves named controls against the bounded recent-task catalog", () => {
    const otherTask: JarvisCommandTask = {
      ...task,
      threadId: ThreadId.make("other-thread"),
      title: "Release preparation",
      objective: "Prepare the release",
    };
    const result = interpret(
      context({ focusedTask: task, recentCommandTasks: [task, otherTask] }),
      intent({ action: "stop", task: "Release preparation" }),
    );
    expect(result).toMatchObject({
      status: "command",
      command: { type: "stop", task: { threadId: otherTask.threadId } },
    });
  });

  it("keeps ambiguous acoustic project grounding ahead of the model", () => {
    const prepared = prepareJarvisSemanticTurn(
      context({
        utterance: "Switch to Ripple project",
        inputMode: "voice",
        projects: [
          { ...jarvis, id: ProjectId.make("ripple-one"), title: "Ripple" },
          { ...fable, id: ProjectId.make("ripple-two"), title: "Ripple" },
        ],
      }),
    );
    expect(prepared).toMatchObject({ status: "needs-input", reason: "control-target-required" });
    if (prepared.status === "needs-input")
      expect(prepared.projectClarification?.candidates).toHaveLength(2);
  });

  it("rejects an internal id emitted as a project name", () => {
    expect(
      interpret(context(), intent({ action: "focus-project", project: "project-fable" })),
    ).toMatchObject({ status: "needs-input", reason: "control-target-required" });
  });

  it("rejects an internal provider instance id emitted as a catalog name", () => {
    const input = context();
    expect(buildJarvisSemanticPrompt(input, ready(input))).not.toContain("fable-alt");
    expect(
      interpret(
        input,
        intent({ instruction: "Fix it.", provider: "fable-alt", model: "Reviewer" }),
      ),
    ).toMatchObject({ status: "needs-input", reason: "provider-not-found" });
  });

  it("rejects malformed proposals and unavailable saved selections", () => {
    expect(() =>
      Schema.decodeUnknownSync(JarvisSemanticIntent)({
        action: "dispatch",
        projectId: jarvis.id,
      }),
    ).toThrow();
    expect(
      interpret(
        context({
          modelSelection: { instanceId: ProviderInstanceId.make("retired"), model: "old" },
        }),
        intent({ instruction: "Fix it." }),
      ),
    ).toMatchObject({ status: "needs-input", reason: "provider-not-found" });
  });
});
