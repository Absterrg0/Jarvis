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

const decodeJarvisSemanticIntent = Schema.decodeUnknownSync(JarvisSemanticIntent);

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
  state: "running",
};
const taskModelSelection = { instanceId: codex.instanceId, model: "gpt-5.6-sol" } as const;
const sourceThread: OrchestrationThread = {
  id: task.threadId,
  projectId: task.projectId,
  title: task.title,
  modelSelection: taskModelSelection,
  runtimeMode: "full-access",
  interactionMode: "default",
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
    nodeDefaultModelSelection: taskModelSelection,
    continueContext: false,
    ...overrides,
  };
}

function intent(overrides: Partial<JarvisSemanticIntent> = {}): JarvisSemanticIntent {
  return {
    action: "start",
    acknowledgement: null,
    project: null,
    task: null,
    instruction: null,
    provider: null,
    model: null,
    effort: null,
    answer: null,
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
  it("keeps the supervisor acknowledgement outside the closed command", () => {
    expect(
      interpret(
        context(),
        intent({
          acknowledgement: "Taking a look at the auth.",
          instruction: "Fix authentication.",
        }),
      ),
    ).toMatchObject({
      status: "command",
      acknowledgement: "Taking a look at the auth.",
      command: {
        type: "start",
        objective: "Fix authentication.",
      },
    });
  });

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
    [
      "switch-focus",
      context({ utterance: "Switch to Fable." }),
      intent({ action: "focus-project", project: "Fable" }),
    ],
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
    [
      "reroute",
      context({ focusedTask: task, utterance: "Move it to Fable." }),
      intent({ action: "reroute", project: "Fable" }),
    ],
    ["list-projects", context(), intent({ action: "list-projects" })],
    [
      "converse",
      context({ utterance: "What is new today?" }),
      intent({ action: "converse", instruction: "What is new today?", answer: "Nothing new." }),
    ],
  ] as const)("accepts one validated %s proposal", (expectedType, input, proposal) => {
    const result = interpret(input, proposal);
    expect(result.status).toBe("command");
    if (result.status === "command") expect(commandType(result.command)).toBe(expectedType);
  });

  it("asks for a destination instead of rerouting into the ambient project", () => {
    const result = interpret(context({ focusedTask: task }), intent({ action: "reroute" }));
    expect(result).toMatchObject({
      status: "needs-input",
      reason: "control-target-required",
      prompt: "Which project should receive that task?",
    });
  });

  it("rejects a converse proposal without a bounded answer", () => {
    expect(
      interpret(context({ utterance: "What is new today?" }), intent({ action: "converse" })),
    ).toMatchObject({ status: "needs-input" });
  });

  it("rejects a model-proposed project the utterance never named", () => {
    const result = interpret(
      context({ focusedTask: task }),
      intent({ action: "reroute", project: "Fable" }),
    );
    expect(result.status).toBe("needs-input");
    expect(result).toMatchObject({ reason: "control-target-required" });
  });

  it("does not mistake a substring for a project mention", () => {
    const app: OrchestrationProjectShell = {
      ...jarvis,
      id: ProjectId.make("project-app"),
      title: "App",
      workspaceRoot: "/workspace/app",
    };
    const result = interpret(
      context({ utterance: "make it happen", projects: [app, jarvis] }),
      intent({ action: "start", project: "App", instruction: "Make it happen." }),
    );
    expect(result.status).toBe("needs-input");
    expect(result).toMatchObject({ reason: "control-target-required" });
  });

  it("closes focus and continuation commands over stable authority only", () => {
    expect(
      interpret(
        context({ utterance: "Focus the Fable project." }),
        intent({
          action: "focus-project",
          acknowledgement: "This must not become control output.",
          project: "Fable",
        }),
      ),
    ).toEqual({
      status: "command",
      command: {
        type: "switch-focus",
        target: { type: "project", projectId: fable.id },
      },
    });

    expect(
      interpret(
        context({
          tasks: [
            {
              threadId: task.threadId,
              projectId: task.projectId,
              title: task.title,
              objective: task.objective,
              state: task.state,
            },
          ],
        }),
        intent({ action: "focus-task", task: task.title }),
      ),
    ).toEqual({
      status: "command",
      command: {
        type: "switch-focus",
        target: { type: "task", task: { threadId: task.threadId } },
      },
    });

    expect(
      interpret(
        context({ focusedTask: task, recentCommandTasks: [task] }),
        intent({ action: "continue", task: task.title, instruction: "Run the tests." }),
      ),
    ).toMatchObject({
      command: { type: "continue", taskSelection: "explicit" },
    });
    expect(
      interpret(
        context({
          currentProjectId: ProjectId.make("deleted-current-project"),
          focusedTask: task,
          recentCommandTasks: [task],
        }),
        intent({ action: "continue", task: task.title, instruction: "Run the tests." }),
      ),
    ).toMatchObject({
      status: "command",
      command: { type: "continue", task: { threadId: task.threadId } },
    });
    expect(
      interpret(
        context({ contextThread: sourceThread, contextTask: task, continueContext: true }),
        intent({ action: "continue", instruction: "Run the tests." }),
      ),
    ).toMatchObject({
      command: { type: "continue", taskSelection: "context" },
    });
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

  it("returns the typed model draft when an explicit selection still needs effort", () => {
    const result = interpret(
      context({
        modelSelection: { instanceId: codex.instanceId, model: "gpt-5.6-sol" },
      }),
      intent({ instruction: "Implement device presence." }),
    );
    expect(result).toMatchObject({
      status: "needs-input",
      reason: "effort-missing",
      modelDraft: { instanceId: codex.instanceId, model: "gpt-5.6-sol" },
    });
  });

  it("uses the provider default model and its default options when names are omitted", () => {
    const provider: ServerProvider = {
      ...codex,
      models: [
        { ...codex.models[0]!, isDefault: true },
        {
          ...codex.models[0]!,
          slug: "gpt-5.6-terra",
          name: "GPT-5.6 Terra",
          shortName: "Terra",
          isDefault: false,
        },
      ],
    };
    expect(
      interpret(
        context({ providers: [provider] }),
        intent({ instruction: "Fix it.", provider: "Codex", model: null, effort: null }),
      ),
    ).toMatchObject({
      status: "command",
      command: {
        type: "start",
        modelSelection: {
          model: "gpt-5.6-sol",
          options: [{ id: "reasoningEffort", value: "medium" }],
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

  it("does not swallow new-direction commands as pending-reply answers", () => {
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
    const result = interpret(
      context({
        utterance: "In Fable, review the release.",
        contextThread: approvalThread,
        contextTask: task,
        continueContext: true,
      }),
      intent({
        action: "review",
        instruction: "Review the release.",
        provider: "Fable",
        model: "Reviewer",
      }),
    );
    expect(result.status).toBe("command");
    if (result.status === "command") expect(commandType(result.command)).toBe("review");
  });

  it.each([
    ["stop", "stop that task"],
    ["status", "what's the status?"],
  ] as const)(
    "keeps %s ahead of pending-reply answers through its early branch",
    (expectedType, utterance) => {
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
      const result = interpret(
        context({
          utterance,
          focusedTask: task,
          contextThread: approvalThread,
          contextTask: task,
          continueContext: true,
        }),
        intent({ action: expectedType }),
      );
      expect(result.status).toBe("command");
      if (result.status === "command") expect(commandType(result.command)).toBe(expectedType);
    },
  );

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

    expect(
      interpret(
        context({ focusedTask: task, recentCommandTasks: [task, otherTask] }),
        intent({
          action: "continue",
          task: "Release preparation",
          instruction: "Add a release checklist.",
        }),
      ),
    ).toMatchObject({
      status: "command",
      command: { type: "continue", task: { threadId: otherTask.threadId } },
    });

    expect(
      interpret(
        context({ focusedTask: task, recentCommandTasks: [task, otherTask] }),
        intent({
          action: "review",
          task: "Release preparation",
          instruction: "Review the release work.",
          provider: "Fable",
          model: "Reviewer",
        }),
      ),
    ).toMatchObject({
      status: "command",
      command: { type: "review", sourceTask: { threadId: otherTask.threadId } },
    });
  });

  it("returns stable task candidates when a named control is ambiguous", () => {
    const duplicateTask: JarvisCommandTask = {
      ...task,
      threadId: ThreadId.make("thread-auth-duplicate"),
    };

    expect(
      interpret(
        context({ focusedTask: task, recentCommandTasks: [task, duplicateTask] }),
        intent({ action: "stop", task: "Authentication review" }),
      ),
    ).toMatchObject({
      status: "needs-input",
      taskClarification: {
        candidates: [{ threadId: task.threadId }, { threadId: duplicateTask.threadId }],
      },
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
    const prompt = buildJarvisSemanticPrompt(input, ready(input));
    expect(prompt).not.toContain("fable-alt");
    expect(prompt).not.toContain("reasoningEffort");
    expect(prompt).not.toContain('"High"');
    expect(
      interpret(
        input,
        intent({ instruction: "Fix it.", provider: "fable-alt", model: "Reviewer" }),
      ),
    ).toMatchObject({ status: "needs-input", reason: "provider-not-found" });
  });

  it("rejects malformed proposals and unavailable saved selections", () => {
    expect(() =>
      decodeJarvisSemanticIntent({
        action: "dispatch",
        projectId: jarvis.id,
      }),
    ).toThrow();
    expect(() =>
      decodeJarvisSemanticIntent(
        intent({ acknowledgement: "x".repeat(121), instruction: "Fix it." }),
      ),
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

  it("accepts compatible semantic proposals that predate spoken acknowledgements", () => {
    const compatibleIntent = intent({ instruction: "Fix it." });
    const { acknowledgement: _, ...withoutAcknowledgement } = compatibleIntent;

    expect(decodeJarvisSemanticIntent(withoutAcknowledgement)).toMatchObject({
      action: "start",
      acknowledgement: null,
      instruction: "Fix it.",
    });
  });
});
