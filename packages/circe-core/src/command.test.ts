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
  buildCirceFastSemanticPrompt,
  buildCirceSemanticPrompt,
  decodeCirceSemanticProposal,
  resolveCirceInstruction,
  interpretCirceCommand,
  interpretPendingCirceReply,
  prepareCirceSemanticTurn,
  type CirceCommand,
  type CirceCommandContext,
  type CirceCommandTask,
  type CirceSemanticProposal,
  type CirceSemanticProposalAction,
  type PreparedCirceSemanticTurn,
  type SemanticRef,
  type SemanticRole,
} from "./command.ts";

const circe: OrchestrationProjectShell = {
  id: ProjectId.make("project-beacon"),
  title: "Beacon",
  workspaceRoot: "/workspace/beacon",
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-08-30T00:00:00.000Z",
  updatedAt: "2026-08-30T00:00:00.000Z",
};
const fable: OrchestrationProjectShell = {
  ...circe,
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

const task: CirceCommandTask = {
  threadId: ThreadId.make("thread-auth"),
  projectId: circe.id,
  projectTitle: circe.title,
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
  pullRequests: [],
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

function context(
  overrides: Omit<Partial<CirceCommandContext>, "currentProjectId"> & {
    /** null omits the ambient project entirely. */
    readonly currentProjectId?: ProjectId | null;
  } = {},
): CirceCommandContext {
  const { currentProjectId = circe.id, ...rest } = overrides;
  const base: CirceCommandContext = {
    utterance: "Implement device presence.",
    currentProjectId: circe.id,
    projects: [circe, fable],
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
    ...rest,
  };
  if (currentProjectId === null) {
    const { currentProjectId: _omitted, ...withoutProject } = base;
    return withoutProject;
  }
  return { ...base, currentProjectId };
}

/** Cite an exact source span: the test helper copies text like the model must. */
function cite(source: string, text: string, from = 0): SemanticRef["span"] {
  const start = source.indexOf(text, from);
  if (start < 0) throw new Error(`cite: ${JSON.stringify(text)} not in ${JSON.stringify(source)}`);
  return { start, end: start + text.length, text };
}

function ref(
  source: string,
  role: SemanticRole,
  text: string,
  value = text,
  from = 0,
): SemanticRef {
  return { span: cite(source, text, from), role, value };
}

type RoleSpec =
  | { role: "destination"; text: string; value: string; from?: number }
  | { role: Exclude<SemanticRole, "destination">; text: string; value?: string; from?: number };

function proposal(
  action: CirceSemanticProposalAction,
  source: string,
  roles: ReadonlyArray<RoleSpec> = [],
  extra: Partial<CirceSemanticProposal> = {},
): CirceSemanticProposal {
  return {
    action,
    refs: roles.map(({ role, text, value, from }) => ref(source, role, text, value ?? text, from)),
    model: null,
    effort: null,
    answer: null,
    ...extra,
  };
}

function ready(
  input: CirceCommandContext,
): Extract<PreparedCirceSemanticTurn, { status: "ready" }> {
  const prepared = prepareCirceSemanticTurn(input);
  if (prepared.status !== "ready") throw new Error(prepared.prompt);
  return prepared;
}

function interpret(input: CirceCommandContext, candidate: CirceSemanticProposal) {
  return interpretCirceCommand(input, ready(input), candidate);
}

function commandType(command: CirceCommand): CirceCommand["type"] {
  return command.type;
}

describe("Beacon semantic command boundary", () => {
  it("composes acceptance speech from the accepted route, never proposal text", () => {
    const result = interpret(
      context({ utterance: "Fix authentication." }),
      proposal("start", "Fix authentication."),
    );
    expect(result).toMatchObject({
      status: "command",
      acknowledgement: "Request accepted for Beacon.",
      command: { type: "start", objective: "Fix authentication." },
    });
  });

  it.each([
    ["start", context(), proposal("start", "Implement device presence.")],
    [
      "continue",
      context({
        utterance: "Add an integration test.",
        contextThread: sourceThread,
        contextTask: task,
        continueContext: true,
      }),
      proposal("continue", "Add an integration test."),
    ],
    [
      "queue",
      context({ utterance: "Add release notes.", focusedTask: task }),
      proposal("queue", "Add release notes."),
    ],
    ["stop", context({ focusedTask: task }), proposal("stop", "Implement device presence.")],
    ["status", context({ focusedTask: task }), proposal("status", "Implement device presence.")],
    [
      "switch-focus",
      context({ utterance: "Switch to Fable." }),
      proposal("focus-project", "Switch to Fable.", [
        { role: "destination", text: "Fable", value: "Fable" },
      ]),
    ],
    [
      "switch-focus",
      context({
        utterance: "Focus Authentication review",
        tasks: [{ ...task, state: task.state }],
      }),
      proposal("focus-task", "Focus Authentication review", [
        { role: "task", text: "Authentication review" },
      ]),
    ],
    [
      "review",
      context({
        utterance: "Have Fable review the completed output.",
        contextThread: sourceThread,
        contextTask: task,
      }),
      proposal(
        "review",
        "Have Fable review the completed output.",
        [{ role: "provider", text: "Fable" }],
        { model: "Reviewer" },
      ),
    ],
    [
      "reroute",
      context({ focusedTask: task, utterance: "Move it to Fable." }),
      proposal("reroute", "Move it to Fable.", [
        { role: "destination", text: "to Fable", value: "Fable" },
      ]),
    ],
    ["list-projects", context(), proposal("list-projects", "Implement device presence.")],
    [
      "converse",
      context({ utterance: "What is new today?", currentProjectId: null }),
      proposal("converse", "What is new today?", [], { answer: "Nothing new." }),
    ],
  ] as const)("accepts one validated %s proposal", (expectedType, input, candidate) => {
    const result = interpret(input, candidate);
    expect(result.status).toBe("command");
    if (result.status === "command") expect(commandType(result.command)).toBe(expectedType);
  });

  it("runs a project-scoped question as a conversation thread", () => {
    const result = interpret(
      context({ utterance: "What is new today?" }),
      proposal("converse", "What is new today?", [], { answer: "Nothing new." }),
    );
    expect(result).toMatchObject({
      status: "command",
      command: {
        type: "start",
        flow: "conversation",
        projectId: circe.id,
        objective: "What is new today?",
      },
      acknowledgement: `Looking into that in ${circe.title}.`,
    });
  });

  it("continues the focused task when new work names no other project", () => {
    const result = interpret(
      context({
        utterance: "Redo the authentication with Better Auth.",
        focusedTask: task,
      }),
      proposal("start", "Redo the authentication with Better Auth."),
    );
    expect(result).toMatchObject({
      status: "command",
      command: {
        type: "continue",
        task: { threadId: task.threadId },
        instruction: "Redo the authentication with Better Auth.",
        taskSelection: "context",
      },
    });
  });

  it("corrects a split-name destination from the deterministic grounding", () => {
    const alertify: OrchestrationProjectShell = {
      ...circe,
      id: ProjectId.make("project-alertify"),
      title: "Alertify",
      workspaceRoot: "/workspace/alertify",
    };
    const result = interpret(
      context({
        utterance: "check pull requests in alert if i",
        currentProjectId: alertify.id,
        projects: [circe, alertify],
        inputMode: "voice",
      }),
      proposal("start", "check pull requests in alert if i", [
        { role: "destination", text: "in alert if i", value: "in alert if i" },
      ]),
    );
    expect(result).toMatchObject({
      status: "command",
      command: {
        type: "start",
        projectId: alertify.id,
        objective: "check pull requests in Alertify",
      },
      acknowledgement: "Request accepted for Alertify.",
    });
  });

  it("starts a separate task when the utterance asks for one", () => {
    const result = interpret(
      context({ utterance: "Start a new task to redo authentication.", focusedTask: task }),
      proposal("start", "Start a new task to redo authentication."),
    );
    expect(result).toMatchObject({ status: "command", command: { type: "start" } });
  });

  it("starts in a named project even while another task is focused", () => {
    const result = interpret(
      context({ utterance: "In Fable, redo authentication.", focusedTask: task }),
      proposal("start", "In Fable, redo authentication.", [
        { role: "destination", text: "In Fable", value: "Fable" },
      ]),
    );
    expect(result).toMatchObject({
      status: "command",
      command: { type: "start", projectId: fable.id },
    });
  });

  it("routes a spoken answer to the session-wide waiting task", () => {
    const waitingThread: OrchestrationThread = {
      ...sourceThread,
      id: ThreadId.make("thread-waiting"),
      title: "Find Open Pull Requests",
      activities: [
        {
          id: EventId.make("waiting-question"),
          tone: "info",
          kind: "user-input.requested",
          summary: "Question",
          payload: { requestId: "q-1", questions: [{ id: "choice" }] },
          turnId: null,
          createdAt: "2026-08-30T00:00:00.000Z",
        },
      ],
    };
    const quietThread: OrchestrationThread = {
      ...sourceThread,
      id: ThreadId.make("thread-focused"),
      title: "Focused work",
      activities: [],
    };
    const result = interpretPendingCirceReply(
      context({
        utterance: "I just trust you, go ahead with the best option",
        contextThread: quietThread,
        contextTask: { ...task, threadId: quietThread.id },
        pendingReplyThread: waitingThread,
        pendingReplyTask: {
          threadId: waitingThread.id,
          projectId: waitingThread.projectId,
          projectTitle: circe.title,
          title: waitingThread.title,
          objective: "Find open PRs",
          state: "ready",
        },
      }),
      "continue",
    );
    expect(result).toMatchObject({
      status: "command",
      command: {
        type: "answer",
        task: { threadId: waitingThread.id },
        instruction: "I just trust you, go ahead with the best option",
        reply: { type: "input", requestId: "q-1", questionIds: ["choice"] },
      },
    });
  });

  it("keeps the focused thread's own pin from being overridden by another waiter", () => {
    const waitingThread: OrchestrationThread = {
      ...sourceThread,
      id: ThreadId.make("thread-waiting-pin"),
      activities: [
        {
          id: EventId.make("waiting-question-pin"),
          tone: "info",
          kind: "user-input.requested",
          summary: "Question",
          payload: { requestId: "q-2", questions: [{ id: "choice" }] },
          turnId: null,
          createdAt: "2026-08-30T00:00:00.000Z",
        },
      ],
    };
    const quietThread: OrchestrationThread = {
      ...sourceThread,
      id: ThreadId.make("thread-focused-pin"),
      activities: [],
    };
    const result = interpretPendingCirceReply(
      context({
        utterance: "go ahead",
        contextThread: quietThread,
        contextTask: { ...task, threadId: quietThread.id },
        pendingReplyThread: waitingThread,
        pendingReplyTask: {
          threadId: waitingThread.id,
          projectId: waitingThread.projectId,
          projectTitle: circe.title,
          title: "Waiting",
          objective: "Waiting",
          state: "ready",
        },
        expectedReply: { kind: "input", requestId: "pinned-elsewhere" },
      }),
      "continue",
    );
    // The client pinned a request on its own focused thread; the session-wide
    // waiter must not silently absorb that answer.
    expect(result).toMatchObject({
      status: "needs-input",
      reason: "source-output-unavailable",
    });
  });

  it("asks for a destination instead of rerouting into the ambient project", () => {
    const result = interpret(
      context({ focusedTask: task }),
      proposal("reroute", "Implement device presence."),
    );
    expect(result).toMatchObject({
      status: "needs-input",
      reason: "control-target-required",
      prompt: "Which project should receive that task?",
    });
  });

  it("rejects a converse proposal without a bounded answer", () => {
    expect(
      interpret(
        context({ utterance: "What is new today?" }),
        proposal("converse", "What is new today?"),
      ),
    ).toMatchObject({ status: "needs-input" });
  });

  it("rejects a destination whose span never contained the named project", () => {
    const result = interpret(
      context({ focusedTask: task, utterance: "Move it somewhere." }),
      proposal("reroute", "Move it somewhere.", [
        { role: "destination", text: "somewhere", value: "Fable" },
      ]),
    );
    expect(result.status).toBe("needs-input");
    expect(result).toMatchObject({ reason: "control-target-required" });
  });

  it("does not mistake a substring for a project mention", () => {
    const app: OrchestrationProjectShell = {
      ...circe,
      id: ProjectId.make("project-app"),
      title: "App",
      workspaceRoot: "/workspace/app",
    };
    const result = interpret(
      context({ utterance: "make it happen", projects: [app, circe] }),
      proposal("start", "make it happen", [{ role: "destination", text: "happen", value: "App" }]),
    );
    expect(result.status).toBe("needs-input");
    expect(result).toMatchObject({ reason: "control-target-required" });
  });

  it("closes focus and continuation commands over stable authority only", () => {
    expect(
      interpret(
        context({ utterance: "Focus the Fable project." }),
        proposal("focus-project", "Focus the Fable project.", [
          { role: "destination", text: "Fable project", value: "Fable" },
        ]),
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
          utterance: "Focus Authentication review",
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
        proposal("focus-task", "Focus Authentication review", [
          { role: "task", text: "Authentication review" },
        ]),
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
        context({
          utterance: "Run the Authentication review tests.",
          focusedTask: task,
          recentCommandTasks: [task],
        }),
        proposal("continue", "Run the Authentication review tests.", [
          { role: "task", text: "Authentication review" },
        ]),
      ),
    ).toMatchObject({
      command: { type: "continue", taskSelection: "explicit" },
    });
    expect(
      interpret(
        context({
          utterance: "Run the Authentication review tests.",
          currentProjectId: ProjectId.make("deleted-current-project"),
          focusedTask: task,
          recentCommandTasks: [task],
        }),
        proposal("continue", "Run the Authentication review tests.", [
          { role: "task", text: "Authentication review" },
        ]),
      ),
    ).toMatchObject({
      status: "command",
      command: { type: "continue", task: { threadId: task.threadId } },
    });
    expect(
      interpret(
        context({
          utterance: "Run the tests.",
          contextThread: sourceThread,
          contextTask: task,
          continueContext: true,
        }),
        proposal("continue", "Run the tests."),
      ),
    ).toMatchObject({
      command: { type: "continue", taskSelection: "context" },
    });
  });

  it("resolves provider, model, and reasoning against the live catalog", () => {
    const source = "Use Codex to implement device presence.";
    const result = interpret(
      context({ utterance: source }),
      proposal("start", source, [{ role: "provider", text: "Codex" }], {
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

  it("fills the descriptor default when an explicit selection omits effort", () => {
    const result = interpret(
      context({
        modelSelection: { instanceId: codex.instanceId, model: "gpt-5.6-sol" },
      }),
      proposal("start", "Implement device presence."),
    );
    expect(result).toMatchObject({
      status: "command",
      command: {
        type: "start",
        modelSelection: {
          instanceId: codex.instanceId,
          model: "gpt-5.6-sol",
          options: [{ id: "reasoningEffort", value: "medium" }],
        },
      },
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
        context({ utterance: "Fix it.", providers: [provider] }),
        proposal("start", "Fix it."),
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
        proposal("continue", "Allow it."),
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
        proposal("continue", "Keep working on it."),
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
        proposal("continue", "Implement device presence."),
      ),
    ).toMatchObject({
      status: "command",
      command: {
        type: "answer",
        reply: { type: "input", requestId: "input-1", questionIds: ["choice"] },
      },
    });
  });

  it("returns needs-input when two distinct requests wait instead of answering the latest", () => {
    const ambiguousThread: OrchestrationThread = {
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
        {
          id: EventId.make("input-request"),
          tone: "info",
          kind: "user-input.requested",
          summary: "Need input",
          payload: { requestId: "input-1", questions: [{ id: "choice" }] },
          turnId: null,
          createdAt: "2026-08-30T00:00:01.000Z",
        },
      ],
    };
    expect(
      interpret(
        context({
          utterance: "Allow it.",
          contextThread: ambiguousThread,
          contextTask: task,
          continueContext: true,
        }),
        proposal("continue", "Allow it."),
      ),
    ).toMatchObject({ status: "needs-input" });
  });

  it("rejects a bare answer when the null snapshot meets a newly opened request", () => {
    const freshPendingThread: OrchestrationThread = {
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
          contextThread: freshPendingThread,
          contextTask: task,
          continueContext: true,
          expectedReply: null,
        }),
        proposal("continue", "Allow it."),
      ),
    ).toMatchObject({
      status: "needs-input",
      reason: "source-output-unavailable",
    });
  });

  it.each([
    ["stop", proposal("stop", "Stop that task.")],
    ["status", proposal("status", "Stop that task.")],
    ["queue", proposal("queue", "Stop that task.")],
    ["review", proposal("review", "Stop that task.")],
    ["start", proposal("start", "Stop that task.")],
  ] as const)(
    "never turns an explicit %s proposal into a pending-reply answer",
    (_name, candidate) => {
      const pendingThread: OrchestrationThread = {
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
      for (const expectedReply of [
        undefined,
        null,
        { kind: "approval", requestId: "approval-1" },
        { kind: "approval", requestId: "approval-stale" },
      ] as const) {
        expect(
          interpret(
            context({
              utterance: "Stop that task.",
              contextThread: pendingThread,
              contextTask: task,
              focusedTask: task,
              continueContext: true,
              ...(expectedReply === undefined ? {} : { expectedReply }),
            }),
            candidate,
          ),
        ).not.toMatchObject({
          status: "command",
          command: { type: "answer" },
        });
      }
    },
  );

  it("leaves stop on its ordinary policy when the null snapshot meets a new request", () => {
    const freshPendingThread: OrchestrationThread = {
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
        utterance: "Stop that task.",
        contextThread: freshPendingThread,
        contextTask: task,
        focusedTask: task,
        continueContext: true,
        expectedReply: null,
      }),
      proposal("stop", "Stop that task."),
    );
    expect(result.status).toBe("command");
    if (result.status === "command") expect(commandType(result.command)).toBe("stop");
  });

  describe("deterministic prepass without a classified action", () => {
    const pendingThread = (
      kind: "approval.requested" | "user-input.requested",
      requestId: string,
    ): OrchestrationThread => ({
      ...sourceThread,
      activities: [
        {
          id: EventId.make(`event-${requestId}`),
          tone: "info",
          kind,
          summary: "Pending request",
          payload: {
            requestId,
            ...(kind === "user-input.requested" ? { questions: [{ id: "choice" }] } : {}),
          },
          turnId: null,
          createdAt: "2026-08-30T00:00:00.000Z",
        },
      ],
    });

    it.each([
      ["Allow it.", "accept"],
      ["Deny it.", "decline"],
      ["yes", "accept"],
      ["no", "decline"],
    ])("answers a bare approval verdict without classification: %s", (utterance, decision) => {
      expect(
        interpretPendingCirceReply(
          context({
            utterance,
            contextThread: pendingThread("approval.requested", "approval-1"),
            contextTask: task,
            continueContext: true,
          }),
        ),
      ).toMatchObject({
        status: "command",
        command: {
          type: "answer",
          reply: { type: "approval", requestId: "approval-1", decision },
        },
      });
    });

    it.each([
      "Stop that task.",
      "what's the status?",
      "don't stop task",
      "do not start over",
      "allow it?",
      "maybe allow it",
      "Use the safe option.",
    ])("defers anything beyond a bare verdict to classification: %s", (utterance) => {
      expect(
        interpretPendingCirceReply(
          context({
            utterance,
            contextThread: pendingThread("approval.requested", "approval-1"),
            contextTask: task,
            continueContext: true,
          }),
        ),
      ).toBeNull();
      expect(
        interpretPendingCirceReply(
          context({
            utterance: "Use the safe option.",
            contextThread: pendingThread("user-input.requested", "input-1"),
            contextTask: task,
            continueContext: true,
          }),
        ),
      ).toBeNull();
    });

    it("rejects a stale pin before any none-handling so it never falls into a semantic start", () => {
      expect(
        interpretPendingCirceReply(
          context({
            utterance: "Allow it.",
            contextThread: sourceThread,
            contextTask: task,
            continueContext: true,
            expectedReply: { kind: "approval", requestId: "request-closed" },
          }),
        ),
      ).toMatchObject({ status: "needs-input", reason: "source-output-unavailable" });
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
    const source = "In Fable, review the release.";
    const result = interpret(
      context({
        utterance: source,
        contextThread: approvalThread,
        contextTask: task,
        continueContext: true,
      }),
      proposal("review", source, [{ role: "destination", text: "In Fable", value: "Fable" }]),
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
        proposal(expectedType, utterance),
      );
      expect(result.status).toBe("command");
      if (result.status === "command") expect(commandType(result.command)).toBe(expectedType);
    },
  );

  it("resolves named controls against the bounded recent-task catalog", () => {
    const otherTask: CirceCommandTask = {
      ...task,
      threadId: ThreadId.make("other-thread"),
      title: "Release preparation",
      objective: "Prepare the release",
    };
    const stopSource = "Stop Release preparation.";
    const result = interpret(
      context({ utterance: stopSource, focusedTask: task, recentCommandTasks: [task, otherTask] }),
      proposal("stop", stopSource, [{ role: "task", text: "Release preparation" }]),
    );
    expect(result).toMatchObject({
      status: "command",
      command: { type: "stop", task: { threadId: otherTask.threadId } },
    });

    const continueSource = "Add a release checklist to Release preparation.";
    expect(
      interpret(
        context({
          utterance: continueSource,
          focusedTask: task,
          recentCommandTasks: [task, otherTask],
        }),
        proposal("continue", continueSource, [{ role: "task", text: "Release preparation" }]),
      ),
    ).toMatchObject({
      status: "command",
      command: { type: "continue", task: { threadId: otherTask.threadId } },
    });

    const reviewSource = "Review the Release preparation work.";
    expect(
      interpret(
        context({
          utterance: reviewSource,
          focusedTask: task,
          recentCommandTasks: [task, otherTask],
        }),
        proposal("review", reviewSource, [{ role: "task", text: "Release preparation" }]),
      ),
    ).toMatchObject({
      status: "command",
      command: { type: "review", sourceTask: { threadId: otherTask.threadId } },
    });
  });

  it("returns stable task candidates when a named control is ambiguous", () => {
    const duplicateTask: CirceCommandTask = {
      ...task,
      threadId: ThreadId.make("thread-auth-duplicate"),
    };
    const source = "Stop Authentication review.";

    expect(
      interpret(
        context({
          utterance: source,
          focusedTask: task,
          recentCommandTasks: [task, duplicateTask],
        }),
        proposal("stop", source, [{ role: "task", text: "Authentication review" }]),
      ),
    ).toMatchObject({
      status: "needs-input",
      taskClarification: {
        candidates: [{ threadId: task.threadId }, { threadId: duplicateTask.threadId }],
      },
    });
  });

  it("keeps ambiguous acoustic project grounding ahead of the model", () => {
    const prepared = prepareCirceSemanticTurn(
      context({
        utterance: "Switch to Ripple project",
        inputMode: "voice",
        projects: [
          { ...circe, id: ProjectId.make("ripple-one"), title: "Ripple" },
          { ...fable, id: ProjectId.make("ripple-two"), title: "Ripple" },
        ],
      }),
    );
    expect(prepared).toMatchObject({ status: "needs-input", reason: "control-target-required" });
    if (prepared.status === "needs-input")
      expect(prepared.projectClarification?.candidates).toHaveLength(2);
  });

  it("rejects a destination span that never contained the named project", () => {
    const source = "Implement device presence.";
    expect(
      interpret(
        context({ utterance: source }),
        proposal("focus-project", source, [
          { role: "destination", text: "device", value: "Fable" },
        ]),
      ),
    ).toMatchObject({ status: "needs-input", reason: "control-target-required" });
  });

  it("rejects an internal provider instance id emitted as a catalog name", () => {
    const input = context({ utterance: "Fix it." });
    const prompt = buildCirceSemanticPrompt(input, ready(input));
    expect(prompt).not.toContain("reasoningEffort");
    expect(prompt).not.toContain('"High"');
    expect(
      interpret(
        input,
        proposal("start", "Fix it.", [{ role: "provider", text: "Fix", value: "fable-alt" }]),
      ),
    ).toMatchObject({ status: "needs-input", reason: "provider-not-found" });
  });

  it("rejects malformed proposals and unavailable saved selections", () => {
    expect(() =>
      decodeCirceSemanticProposal({
        action: "dispatch",
        refs: [],
        model: null,
        effort: null,
        answer: null,
      }),
    ).toThrow();
    expect(() =>
      decodeCirceSemanticProposal(
        proposal("converse", "What is new today?", [], { answer: "x".repeat(401) }),
      ),
    ).toThrow();
    expect(() =>
      decodeCirceSemanticProposal(
        proposal("start", "Fix it.", [{ role: "task", text: "", value: "x" }]),
      ),
    ).toThrow();
    expect(
      interpret(
        context({
          utterance: "Fix it.",
          modelSelection: { instanceId: ProviderInstanceId.make("retired"), model: "old" },
        }),
        proposal("start", "Fix it."),
      ),
    ).toMatchObject({ status: "needs-input", reason: "provider-not-found" });
  });

  it("decodes explicit null selections without compatibility defaults", () => {
    expect(
      decodeCirceSemanticProposal({
        action: "start",
        refs: [],
        model: null,
        effort: null,
        answer: null,
      }),
    ).toMatchObject({ action: "start", model: null, effort: null, answer: null, refs: [] });
  });

  it("decodes an ordered sequence and rejects nested sequence steps", () => {
    const step = { action: "start" as const, refs: [], model: null, effort: null, answer: null };
    const decoded = decodeCirceSemanticProposal({
      action: "sequence",
      refs: [],
      model: null,
      effort: null,
      answer: null,
      steps: [step, { ...step, action: "stop" as const }],
    });
    expect(decoded.steps?.map((entry) => entry.action)).toEqual(["start", "stop"]);
    // Steps never nest: a sequence inside a step is not a valid step action.
    expect(() =>
      decodeCirceSemanticProposal({
        action: "sequence",
        refs: [],
        model: null,
        effort: null,
        answer: null,
        steps: [{ ...step, action: "sequence" as never }],
      }),
    ).toThrow();
  });
});

describe("proposal preparation contract", () => {
  const rivvl: OrchestrationProjectShell = {
    ...circe,
    id: ProjectId.make("project-rivvl"),
    title: "Rivvl",
    workspaceRoot: "/workspace/rivvl",
  };
  const claudeProvider: ServerProvider = {
    ...codex,
    instanceId: ProviderInstanceId.make("claude"),
    driver: ProviderDriverKind.make("claude"),
    displayName: "Claude",
    models: [
      {
        slug: "claude-default",
        name: "Claude Default",
        shortName: "Default",
        isCustom: false,
        capabilities: null,
      },
    ],
  };

  function voiceContext(utterance: string): CirceCommandContext {
    return context({
      utterance,
      inputMode: "voice",
      currentProjectId: circe.id,
      projects: [circe, rivvl],
      providers: [codex, claudeProvider],
    });
  }

  it("carries the original transcript and advisory mention in the prompt", () => {
    const input = voiceContext("Check auth in Rivvl");
    const prompt = buildCirceSemanticPrompt(input, ready(input));
    expect(prompt).toContain("Check auth in Rivvl");
    expect(prompt).toContain("Original transcript");
    expect(prompt).toContain("Heard project mention");
    expect(prompt).toContain("Model proposes never authorizes");
    expect(prompt).not.toContain("Deterministic project route");
  });

  it("builds a compact fx prompt that states the proposal schema", () => {
    const input = voiceContext("Check auth in Rivvl");
    const full = buildCirceSemanticPrompt(input, ready(input));
    const fast = buildCirceFastSemanticPrompt(input, ready(input));
    expect(fast).toContain('"action"');
    expect(fast).toContain('"destination|task|subject|excluded|correction|provider"');
    expect(fast).toContain("Check auth in Rivvl");
    expect(fast).toContain("Original transcript");
    expect(fast.length).toBeLessThan(full.length / 2);
  });

  it("keeps the ASR original in the prepared turn with advisory mention evidence", () => {
    const prepared = prepareCirceSemanticTurn(voiceContext("check the authentication in Rivvl"));
    expect(prepared.status).toBe("ready");
    if (prepared.status !== "ready") return;
    expect(prepared.utterance).toBe("check the authentication in Rivvl");
    expect(prepared.sourceUtterance).toBe("check the authentication in Rivvl");
    expect(prepared.asrEvidence?.heard).toBe("Rivvl");
    expect("projectId" in prepared).toBe(false);
  });

  it("leaves routing to cited refs instead of deterministic wrappers", () => {
    const prepared = prepareCirceSemanticTurn(voiceContext("In Rivvl compare with Beacon"));
    expect(prepared.status).toBe("ready");
    if (prepared.status !== "ready") return;
    expect("projectId" in prepared).toBe(false);
    expect(prepared.asrEvidence?.heard).toBe("Rivvl");
  });

  it("keeps incidental mentions verbatim with no route of its own", () => {
    const prepared = prepareCirceSemanticTurn(voiceContext("PRs mentioning Rivvl in Beacon repo"));
    expect(prepared.status).toBe("ready");
    if (prepared.status !== "ready") return;
    expect("projectId" in prepared).toBe(false);
    expect(prepared.utterance).toContain("mentioning Rivvl");
  });

  it("keeps incidental mentions inside the instruction for a branch-shaped request", () => {
    const prepared = prepareCirceSemanticTurn(voiceContext("In Rivvl, check out branch Zivil."));
    expect(prepared.status).toBe("ready");
    if (prepared.status !== "ready") return;
    expect(prepared.utterance).toContain("branch Zivil");
  });

  it("reads a provider choice from Ask-phrasing without losing the destination", () => {
    const source = "Ask Claude investigate login failure in Beacon";
    const input = voiceContext(source);
    const result = interpret(
      input,
      proposal("start", source, [
        { role: "provider", text: "Claude" },
        { role: "destination", text: "in Beacon", value: "Beacon" },
      ]),
    );
    expect(result).toMatchObject({
      status: "command",
      command: { type: "start", objective: "Ask Claude investigate login failure" },
    });
    if (result.status !== "command" || result.command.type !== "start") return;
    expect(result.command.projectId).toBe(circe.id);
  });

  it("treats a negated stop plus status wording as status, and says so in the prompt", () => {
    const input = voiceContext("Don't stop auth task tell status");
    const prompt = buildCirceSemanticPrompt(input, ready(input));
    expect(prompt).toMatchObject(/negation/i);
    const source = "Don't stop auth task tell status";
    const result = interpret(
      context({
        utterance: source,
        focusedTask: task,
        recentCommandTasks: [task],
      }),
      proposal("status", source),
    );
    expect(result).toMatchObject({ status: "command", command: { type: "status" } });
  });

  it("asks with the exact heard text for a destination outside the catalog", () => {
    const source = "Check auth in Deleted";
    const result = interpret(
      voiceContext(source),
      proposal("start", source, [{ role: "destination", text: "in Deleted", value: "Deleted" }]),
    );
    expect(result).toMatchObject({
      status: "needs-input",
      reason: "control-target-required",
      prompt: "I couldn't match Deleted to a project.",
    });
  });

  it("composes acceptance speech for continuations from the accepted task", () => {
    const settledTask: CirceCommandTask = { ...task, state: "ready" };
    const settledThread: OrchestrationThread = { ...sourceThread, id: settledTask.threadId };
    const result = interpret(
      context({
        utterance: "Run the tests.",
        contextThread: settledThread,
        contextTask: settledTask,
        continueContext: true,
      }),
      proposal("continue", "Run the tests."),
    );
    expect(result).toMatchObject({
      status: "command",
      acknowledgement: "Request accepted for Authentication review.",
    });
  });

  it("composes acceptance speech for the accepted project without model text", () => {
    const source = "Check auth in Rivvl";
    const routed = interpret(
      voiceContext(source),
      proposal("start", source, [{ role: "destination", text: "in Rivvl", value: "Rivvl" }]),
    );
    expect(routed).toMatchObject({
      status: "command",
      acknowledgement: "Request accepted for Rivvl.",
    });

    const plain = interpret(
      context({ utterance: "Fix authentication." }),
      proposal("start", "Fix authentication."),
    );
    expect(plain).toMatchObject({
      status: "command",
      acknowledgement: "Request accepted for Beacon.",
    });
  });
});

describe("compound, exclusion, extraction, and host-ack contract", () => {
  const rivvl: OrchestrationProjectShell = {
    ...circe,
    id: ProjectId.make("project-rivvl"),
    title: "Rivvl",
    workspaceRoot: "/workspace/rivvl",
  };

  function voiceContext(utterance: string): CirceCommandContext {
    return context({
      utterance,
      inputMode: "voice",
      currentProjectId: circe.id,
      projects: [circe, rivvl],
    });
  }

  it("never executes the lead fragment of a compound request", () => {
    const source = "Fix auth then add release notes";
    const result = interpret(context({ utterance: source }), proposal("unsupported", source));
    expect(result).toMatchObject({ status: "needs-input", reason: "unsupported-command" });
  });

  it("rejects two task refs structurally without reading conjunctions", () => {
    const source = "Fix auth then add release notes";
    const result = interpret(
      voiceContext(source),
      proposal("start", source, [
        { role: "task", text: "Fix auth" },
        { role: "task", text: "release notes" },
      ]),
    );
    expect(result).toMatchObject({
      status: "needs-input",
      reason: "unsupported-command",
      prompt: expect.stringMatching(/one action/i),
    });
  });

  it("maps an explicit unsupported proposal to needs-input", () => {
    const source = "Fix auth then add release notes";
    const result = interpret(voiceContext(source), proposal("unsupported", source));
    expect(result).toMatchObject({
      status: "needs-input",
      reason: "unsupported-command",
      prompt: expect.stringMatching(/one action/i),
    });
  });

  it("leaves negation to the proposal instead of dispatching a stop the user ruled out", () => {
    const source = "Don't stop auth task tell status";
    const result = interpret(
      context({
        utterance: source,
        focusedTask: task,
        recentCommandTasks: [task],
      }),
      proposal("status", source),
    );
    expect(result).toMatchObject({ status: "command", command: { type: "status" } });
    expect(result).not.toMatchObject({ status: "command", command: { type: "stop" } });
  });

  it("extracts the destination-free instruction from a cited wrapper", () => {
    const source = "Check if there are any GitHub PRs in Rivvl";
    const prepared = prepareCirceSemanticTurn(voiceContext(source));
    expect(prepared.status).toBe("ready");
    if (prepared.status !== "ready") return;
    expect(resolveCirceInstruction(prepared.sourceUtterance, [cite(source, " in Rivvl")])).toBe(
      "Check if there are any GitHub PRs",
    );
  });

  it("keeps incidental mentions while removing only the cited span", () => {
    const source = "In Rivvl compare with Beacon";
    const prepared = prepareCirceSemanticTurn(voiceContext(source));
    expect(prepared.status).toBe("ready");
    if (prepared.status !== "ready") return;
    expect(resolveCirceInstruction(prepared.sourceUtterance, [cite(source, "In Rivvl ")])).toBe(
      "compare with Beacon",
    );
  });

  it("falls back to the original transcript for empty or unjustified spans", () => {
    const source = "Check auth in Rivvl";
    expect(resolveCirceInstruction(source, [])).toBe(source);
    expect(resolveCirceInstruction(source, [{ start: 999, end: 1005 }])).toBe(source);
    expect(resolveCirceInstruction(source, [{ start: 5, end: 5 }])).toBe(source);
    expect(
      resolveCirceInstruction(source, [
        { start: 0, end: 8 },
        { start: 4, end: 12 },
      ]),
    ).toBe(source);
  });

  it("preserves a bare named target with no cited wrapper", () => {
    const source = "Open Rivvl.";
    expect(resolveCirceInstruction(source, [])).toBe(source);
  });

  it("preserves the object of look-at instead of treating at as a destination", () => {
    const source = "Look at Rivvl";
    expect(resolveCirceInstruction(source, [])).toBe(source);
  });

  it("removes a cited mid-sentence wrapper mechanically, keeping neighbors exact", () => {
    const source = "check health at VPS";
    expect(resolveCirceInstruction(source, [cite(source, " at VPS")])).toBe("check health");
    const mid = "Fix auth in Rivvl today";
    expect(resolveCirceInstruction(mid, [cite(mid, "in Rivvl")])).toBe("Fix auth  today");
    expect(resolveCirceInstruction(mid, [cite(mid, " in Rivvl")])).toBe("Fix auth today");
  });

  it("dispatches the deterministic extraction for a fully cited turn", () => {
    const source = "PRs mentioning Rivvl in Beacon repo";
    const result = interpret(
      voiceContext(source),
      proposal("start", source, [
        { role: "subject", text: "Rivvl" },
        { role: "destination", text: "in Beacon repo", value: "Beacon" },
      ]),
    );
    expect(result).toMatchObject({
      status: "command",
      command: { type: "start", objective: "PRs mentioning Rivvl" },
    });
  });

  it("keeps host-composed acceptance for the accepted command", () => {
    const source = "Check auth in Rivvl";
    const result = interpret(
      voiceContext(source),
      proposal("start", source, [{ role: "destination", text: "in Rivvl", value: "Rivvl" }]),
    );
    expect(result).toMatchObject({
      status: "command",
      acknowledgement: "Request accepted for Rivvl.",
    });
  });

  it("keeps one coding task with many constraints as a single start", () => {
    const source = "Fix auth with retries and backoff in Rivvl";
    const result = interpret(
      voiceContext(source),
      proposal("start", source, [{ role: "destination", text: "in Rivvl", value: "Rivvl" }]),
    );
    expect(result).toMatchObject({
      status: "command",
      command: { type: "start", objective: "Fix auth with retries and backoff" },
    });
  });
});

describe("instruction fidelity contract", () => {
  const rivvl: OrchestrationProjectShell = {
    ...circe,
    id: ProjectId.make("project-rivvl"),
    title: "Rivvl",
    workspaceRoot: "/workspace/rivvl",
  };
  const claudeProvider: ServerProvider = {
    ...codex,
    instanceId: ProviderInstanceId.make("claude"),
    driver: ProviderDriverKind.make("claude"),
    displayName: "Claude",
    models: [
      {
        slug: "claude-default",
        name: "Claude Default",
        shortName: "Default",
        isCustom: false,
        capabilities: null,
      },
    ],
  };

  function voiceContext(utterance: string, providers = [codex, claudeProvider]) {
    return context({
      utterance,
      inputMode: "voice",
      currentProjectId: circe.id,
      projects: [circe, rivvl],
      providers,
    });
  }

  it("dispatches the deterministic extraction, never proposal wording", () => {
    const source = "In Rivvl compare Rivvl budgets";
    const result = interpret(
      voiceContext(source),
      proposal("start", source, [
        { role: "destination", text: "In Rivvl", value: "Rivvl" },
        { role: "subject", text: "Rivvl", value: "Rivvl", from: 9 },
      ]),
    );
    expect(result).toMatchObject({
      status: "command",
      command: { type: "start", objective: "compare Rivvl budgets" },
    });
  });

  it("preserves negation from the transcript", () => {
    const source = "Don't change the auth flow in Rivvl";
    const result = interpret(
      voiceContext(source),
      proposal("start", source, [{ role: "destination", text: "in Rivvl", value: "Rivvl" }]),
    );
    expect(result).toMatchObject({
      status: "command",
      command: { type: "start", objective: "Don't change the auth flow" },
    });
  });

  it("preserves provider words from the transcript", () => {
    const source = "Ask Claude investigate login failure in Beacon";
    const result = interpret(
      voiceContext(source),
      proposal("start", source, [
        { role: "provider", text: "Claude" },
        { role: "destination", text: "in Beacon", value: "Beacon" },
      ]),
    );
    expect(result).toMatchObject({
      status: "command",
      command: { type: "start", objective: "Ask Claude investigate login failure" },
    });
  });

  it("dispatches the original when the turn cites nothing", () => {
    const result = interpret(
      context({ utterance: "Fix the login flow" }),
      proposal("start", "Fix the login flow"),
    );
    expect(result).toMatchObject({
      status: "command",
      command: { type: "start", objective: "Fix the login flow" },
    });
  });

  it("dispatches the original when the transcript carries the negation", () => {
    const source = "Do not restart Authentication review";
    const result = interpret(
      context({
        utterance: source,
        focusedTask: task,
        recentCommandTasks: [task],
      }),
      proposal("continue", source, [{ role: "task", text: "Authentication review" }]),
    );
    expect(result).toMatchObject({
      status: "command",
      command: { type: "continue", instruction: "Do not restart Authentication review" },
    });
  });

  it("dispatches the original when the transcript names the project outside a wrapper", () => {
    const result = interpret(
      context({ utterance: "Check Rivvl auth status", projects: [circe, rivvl] }),
      proposal("start", "Check Rivvl auth status"),
    );
    expect(result).toMatchObject({
      status: "command",
      command: { type: "start", objective: "Check Rivvl auth status" },
    });
  });

  it("keeps a quoted incidental mention in the dispatched extraction", () => {
    const source = 'PRs mentioning "Rivvl" in Beacon repo';
    const result = interpret(
      voiceContext(source),
      proposal("start", source, [
        { role: "subject", text: '"Rivvl"', value: "Rivvl" },
        { role: "destination", text: "in Beacon repo", value: "Beacon" },
      ]),
    );
    expect(result).toMatchObject({
      status: "command",
      command: { type: "start", objective: 'PRs mentioning "Rivvl"' },
    });
  });

  it("leaves provider selection to defaults when subjects name providers", () => {
    const source = "Compare Codex output with Claude";
    const result = interpret(
      voiceContext(source),
      proposal("start", source, [
        { role: "subject", text: "Codex" },
        { role: "subject", text: "Claude" },
      ]),
    );
    expect(result).toMatchObject({
      status: "command",
      command: {
        type: "start",
        objective: "Compare Codex output with Claude",
        modelSelection: { instanceId: codex.instanceId },
      },
    });
  });

  it("routes a Unicode project name through exact span offsets", () => {
    const cafe: OrchestrationProjectShell = {
      ...circe,
      id: ProjectId.make("project-cafe"),
      title: "Café",
      workspaceRoot: "/workspace/cafe",
    };
    const source = "Check auth in Café";
    const result = interpret(
      context({ utterance: source, projects: [circe, cafe] }),
      proposal("start", source, [{ role: "destination", text: "in Café", value: "Café" }]),
    );
    expect(result).toMatchObject({
      status: "command",
      command: { type: "start", objective: "Check auth" },
    });
    if (result.status !== "command" || result.command.type !== "start") return;
    expect(result.command.projectId).toBe(cafe.id);
  });

  it("derives acceptance speech naming the accepted project", () => {
    const source = "Check auth in Rivvl";
    const result = interpret(
      voiceContext(source),
      proposal("start", source, [{ role: "destination", text: "in Rivvl", value: "Rivvl" }]),
    );
    expect(result).toMatchObject({
      status: "command",
      acknowledgement: "Request accepted for Rivvl.",
    });
  });

  it("derives acceptance speech naming the accepted task", () => {
    const settledTask: CirceCommandTask = { ...task, state: "ready" };
    const settledThread: OrchestrationThread = { ...sourceThread, id: settledTask.threadId };
    const result = interpret(
      context({
        utterance: "Run the tests.",
        contextThread: settledThread,
        contextTask: settledTask,
        continueContext: true,
      }),
      proposal("continue", "Run the tests."),
    );
    expect(result).toMatchObject({
      status: "command",
      acknowledgement: "Request accepted for Authentication review.",
    });
  });
});

describe("explicit evidence contract", () => {
  const alpha: OrchestrationProjectShell = {
    ...circe,
    id: ProjectId.make("project-alpha"),
    title: "Alpha",
    workspaceRoot: "/workspace/alpha",
  };
  const beta: OrchestrationProjectShell = {
    ...circe,
    id: ProjectId.make("project-beta"),
    title: "Beta",
    workspaceRoot: "/workspace/beta",
  };
  const rivvl: OrchestrationProjectShell = {
    ...circe,
    id: ProjectId.make("project-rivvl"),
    title: "Rivvl",
    workspaceRoot: "/workspace/rivvl",
  };

  function catalogContext(
    utterance: string,
    options: { readonly voice?: boolean; readonly current?: ProjectId } = {},
  ): CirceCommandContext {
    return context({
      utterance,
      currentProjectId: options.current ?? beta.id,
      projects: [alpha, beta],
      ...(options.voice === true ? { inputMode: "voice" as const } : {}),
    });
  }

  it("grounds a cited leading destination independent of the work verb", () => {
    for (const utterance of [
      "In Alpha, examine logs mentioning Beta",
      "In Alpha, document the release",
      "In Alpha, fix the flaky test",
    ]) {
      const result = interpret(
        catalogContext(utterance),
        proposal("start", utterance, [
          { role: "destination", text: "In Alpha", value: "Alpha" },
          ...(utterance.includes("Beta") ? [{ role: "subject" as const, text: "Beta" }] : []),
        ]),
      );
      expect(result).toMatchObject({
        status: "command",
        command: { type: "start" },
      });
      if (result.status !== "command" || result.command.type !== "start") continue;
      expect(result.command.projectId).toBe(alpha.id);
    }
  });

  it("routes to the cited destination while keeping the incidental mention", () => {
    const source = "In Alpha, examine logs mentioning Beta";
    const result = interpret(
      catalogContext(source),
      proposal("start", source, [
        { role: "destination", text: "In Alpha,", value: "Alpha" },
        { role: "subject", text: "Beta" },
      ]),
    );
    expect(result).toMatchObject({
      status: "command",
      command: { type: "start", objective: "examine logs mentioning Beta" },
    });
    if (result.status !== "command" || result.command.type !== "start") return;
    expect(result.command.projectId).toBe(alpha.id);
    expect(result.command.projectId).not.toBe(beta.id);
  });

  it("falls back to ambient without refs instead of guessing a cited name", () => {
    const source = "In Alpha, examine logs mentioning Beta";
    const result = interpret(catalogContext(source), proposal("start", source));
    expect(result).toMatchObject({
      status: "command",
      command: { type: "start", objective: source },
    });
    if (result.status !== "command" || result.command.type !== "start") return;
    expect(result.command.projectId).toBe(beta.id);
  });

  it("routes the GitHub PRs request to Rivvl typed", () => {
    const source = "Check if there are any GitHub PRs in Rivvl";
    const input = context({
      utterance: source,
      currentProjectId: circe.id,
      projects: [circe, rivvl],
    });
    const result = interpret(
      input,
      proposal("start", source, [{ role: "destination", text: "in Rivvl", value: "Rivvl" }]),
    );
    expect(result).toMatchObject({
      status: "command",
      command: { type: "start", objective: "Check if there are any GitHub PRs" },
    });
    if (result.status !== "command" || result.command.type !== "start") return;
    expect(result.command.projectId).toBe(rivvl.id);
  });

  it("routes the GitHub PRs request to Rivvl voiced", () => {
    const source = "Check if there are any GitHub PRs in Rivvl";
    const input = context({
      utterance: source,
      inputMode: "voice",
      currentProjectId: circe.id,
      projects: [circe, rivvl],
    });
    const prepared = prepareCirceSemanticTurn(input);
    expect(prepared.status).toBe("ready");
    const result = interpret(
      input,
      proposal("start", source, [{ role: "destination", text: "in Rivvl", value: "Rivvl" }]),
    );
    expect(result).toMatchObject({
      status: "command",
      command: { type: "start", objective: "Check if there are any GitHub PRs" },
    });
    if (result.status !== "command" || result.command.type !== "start") return;
    expect(result.command.projectId).toBe(rivvl.id);
  });

  it("never withholds a cited destination behind an earlier bare mention", () => {
    const source = "Check whether Beacon believes in Rivvl";
    const prepared = prepareCirceSemanticTurn(
      context({
        utterance: source,
        currentProjectId: circe.id,
        projects: [circe, rivvl],
      }),
    );
    expect(prepared.status).toBe("ready");
    const result = interpret(
      context({
        utterance: source,
        currentProjectId: circe.id,
        projects: [circe, rivvl],
      }),
      proposal("start", source, [
        { role: "subject", text: "Beacon" },
        { role: "destination", text: "in Rivvl", value: "Rivvl" },
      ]),
    );
    expect(result).toMatchObject({
      status: "command",
      command: { type: "start", objective: "Check whether Beacon believes" },
    });
    if (result.status !== "command" || result.command.type !== "start") return;
    expect(result.command.projectId).toBe(rivvl.id);
  });

  it("routes past a mention-verb complement to the cited destination", () => {
    const atlas: OrchestrationProjectShell = {
      ...circe,
      id: ProjectId.make("project-atlas"),
      title: "Atlas",
      workspaceRoot: "/workspace/atlas",
    };
    const beacon: OrchestrationProjectShell = {
      ...circe,
      id: ProjectId.make("project-beacon"),
      title: "Beacon",
      workspaceRoot: "/workspace/beacon",
    };
    const source = "Check PRs mentioning Beacon in Atlas repository";
    const result = interpret(
      context({ utterance: source, currentProjectId: atlas.id, projects: [atlas, beacon] }),
      proposal("start", source, [
        { role: "subject", text: "Beacon" },
        { role: "destination", text: "in Atlas repository", value: "Atlas" },
      ]),
    );
    expect(result).toMatchObject({
      status: "command",
      command: { type: "start", objective: "Check PRs mentioning Beacon" },
    });
    if (result.status !== "command" || result.command.type !== "start") return;
    expect(result.command.projectId).toBe(atlas.id);
  });

  it("asks instead of routing when the cited destination was never spoken that way", () => {
    const atlas: OrchestrationProjectShell = {
      ...circe,
      id: ProjectId.make("project-atlas"),
      title: "Atlas",
      workspaceRoot: "/workspace/atlas",
    };
    const beacon: OrchestrationProjectShell = {
      ...circe,
      id: ProjectId.make("project-beacon"),
      title: "Beacon",
      workspaceRoot: "/workspace/beacon",
    };
    const source = "Check whether Atlas mentions Beacon";
    const input = context({
      utterance: source,
      currentProjectId: atlas.id,
      projects: [atlas, beacon],
    });
    expect(prepareCirceSemanticTurn(input)).toMatchObject({ status: "ready" });
    const result = interpret(
      input,
      proposal("start", source, [{ role: "destination", text: "mentions", value: "Beacon" }]),
    );
    expect(result).toMatchObject({ status: "needs-input", reason: "control-target-required" });
  });

  it("asks with the heard spelling when a typo value does not echo its span", () => {
    const source = "Switch to the Rivvil project.";
    const input = context({
      utterance: source,
      currentProjectId: circe.id,
      projects: [circe, rivvl],
    });
    const result = interpret(
      input,
      proposal("focus-project", source, [{ role: "destination", text: "Rivvil", value: "Rivvl" }]),
    );
    expect(result).toMatchObject({ status: "needs-input", reason: "control-target-required" });
    if (result.status !== "needs-input") return;
    expect(result.choices).toEqual(["Rivvl — rivvl"]);
  });

  it("attaches project candidates to the malformed-span question so titles resolve", () => {
    const source = "Check auth in Rivvl";
    const input = context({
      utterance: source,
      currentProjectId: circe.id,
      projects: [circe, rivvl],
    });
    const result = interpret(input, {
      action: "start",
      refs: [{ span: { start: 11, end: 19, text: "in Rivvl " }, role: "subject", value: "x" }],
      model: null,
      effort: null,
      answer: null,
    });
    expect(result).toMatchObject({ status: "needs-input", reason: "control-target-required" });
    if (result.status !== "needs-input") return;
    expect(result.choices).toEqual(["Beacon", "Rivvl"]);
    expect(result.projectClarification?.candidates.map((c) => String(c.projectId))).toEqual([
      String(circe.id),
      String(rivvl.id),
    ]);
  });

  describe("focus-project ambient guard (dev-asr-01)", () => {
    const liveSource = "Switch to the Rivvil project.";
    function focusInput(source: string, overrides: Partial<Parameters<typeof context>[0]> = {}) {
      return context({
        utterance: source,
        currentProjectId: circe.id,
        projects: [circe, rivvl],
        ...overrides,
      });
    }

    it("clarifies omitted refs instead of choosing ambient (live wrong-accept shape)", () => {
      const result = interpret(focusInput(liveSource), proposal("focus-project", liveSource));
      expect(result).toMatchObject({ status: "needs-input", reason: "control-target-required" });
      expect(result).not.toMatchObject({
        status: "command",
        command: { type: "switch-focus" },
      });
      if (result.status !== "needs-input") return;
      expect(result.projectClarification?.candidates.map((c) => String(c.projectId))).toEqual(
        expect.arrayContaining([String(circe.id), String(rivvl.id)]),
      );
    });

    it("clarifies subject-only evidence instead of choosing ambient", () => {
      const result = interpret(
        focusInput(liveSource),
        proposal("focus-project", liveSource, [{ role: "subject", text: "Rivvil" }]),
      );
      expect(result).toMatchObject({ status: "needs-input", reason: "control-target-required" });
    });

    it("clarifies excluded-only evidence instead of choosing ambient", () => {
      const result = interpret(
        focusInput(liveSource),
        proposal("focus-project", liveSource, [{ role: "excluded", text: "Rivvil" }]),
      );
      expect(result).toMatchObject({ status: "needs-input", reason: "control-target-required" });
    });

    it("clarifies generic omitted refs without a Rivvil phrase patch", () => {
      const source = "Switch to Fable.";
      const input = context({
        utterance: source,
        currentProjectId: circe.id,
        projects: [circe, fable],
      });
      const result = interpret(input, proposal("focus-project", source));
      expect(result).toMatchObject({ status: "needs-input", reason: "control-target-required" });
      expect(result).not.toMatchObject({
        status: "command",
        command: { type: "switch-focus" },
      });
    });

    it("routes exact focus evidence while preserving the source", () => {
      const source = "Switch to Fable.";
      const input = context({
        utterance: source,
        currentProjectId: circe.id,
        projects: [circe, fable],
      });
      const prepared = ready(input);
      expect(prepared.sourceUtterance).toBe(source);
      const result = interpretCirceCommand(
        input,
        prepared,
        proposal("focus-project", source, [{ role: "destination", text: "Fable", value: "Fable" }]),
      );
      expect(result).toEqual({
        status: "command",
        command: { type: "switch-focus", target: { type: "project", projectId: fable.id } },
      });
    });

    it("routes a typed pending confirmation without destination refs", () => {
      const input = focusInput(liveSource, { confirmedProjectId: rivvl.id });
      const result = interpret(input, proposal("focus-project", liveSource));
      expect(result).toEqual({
        status: "command",
        command: { type: "switch-focus", target: { type: "project", projectId: rivvl.id } },
      });
    });

    it("clarifies a stale confirmation instead of choosing ambient or a phantom", () => {
      const input = focusInput(liveSource, {
        confirmedProjectId: ProjectId.make("project-gone"),
      });
      const result = interpret(input, proposal("focus-project", liveSource));
      expect(result).toMatchObject({ status: "needs-input", reason: "control-target-required" });
      expect(result).not.toMatchObject({
        status: "command",
        command: { type: "switch-focus" },
      });
    });

    it("clarifies a reroute without destination unless a confirmation authorizes it", () => {
      const rerouteSource = "Move Authentication review to Fable.";
      const base = context({
        utterance: rerouteSource,
        currentProjectId: circe.id,
        projects: [circe, fable],
        focusedTask: task,
        recentCommandTasks: [task],
      });
      const missing = interpretCirceCommand(
        base,
        ready(base),
        proposal("reroute", rerouteSource, [{ role: "task", text: "Authentication review" }]),
      );
      expect(missing).toMatchObject({ status: "needs-input", reason: "control-target-required" });

      const confirmed = context({
        utterance: rerouteSource,
        currentProjectId: circe.id,
        projects: [circe, fable],
        focusedTask: task,
        recentCommandTasks: [task],
        confirmedProjectId: fable.id,
      });
      const routed = interpretCirceCommand(
        confirmed,
        ready(confirmed),
        proposal("reroute", rerouteSource, [{ role: "task", text: "Authentication review" }]),
      );
      expect(routed).toMatchObject({
        status: "command",
        command: { type: "reroute", targetProjectId: fable.id },
      });
    });
  });
});

describe("correction and task-state contract", () => {
  it("routes a repair to the corrected project with the full wording kept", () => {
    const vps: OrchestrationProjectShell = {
      ...circe,
      id: ProjectId.make("project-vps"),
      title: "VPS",
      workspaceRoot: "/workspace/vps",
    };
    const rivvl: OrchestrationProjectShell = {
      ...circe,
      id: ProjectId.make("project-rivvl"),
      title: "Rivvl",
      workspaceRoot: "/workspace/rivvl",
    };
    const source = "No I meant VPS deployment not Rivvl verify health";
    const result = interpret(
      context({
        utterance: source,
        currentProjectId: circe.id,
        projects: [circe, rivvl, vps],
      }),
      proposal("start", source, [
        { role: "correction", text: "VPS" },
        { role: "excluded", text: "Rivvl" },
      ]),
    );
    expect(result).toMatchObject({
      status: "command",
      command: { type: "start", objective: source },
    });
    if (result.status !== "command" || result.command.type !== "start") return;
    expect(result.command.projectId).toBe(vps.id);
  });

  it("clarifies instead of defaulting to an excluded ambient project", () => {
    const rivvl: OrchestrationProjectShell = {
      ...circe,
      id: ProjectId.make("project-rivvl"),
      title: "Rivvl",
      workspaceRoot: "/workspace/rivvl",
    };
    const source = "Check auth not in Rivvl";
    const result = interpret(
      context({
        utterance: source,
        currentProjectId: rivvl.id,
        projects: [circe, rivvl],
      }),
      proposal("start", source, [{ role: "excluded", text: "Rivvl" }]),
    );
    expect(result).toMatchObject({ status: "needs-input", reason: "control-target-required" });
    expect(result).not.toMatchObject({ status: "command", command: { type: "start" } });
  });

  it("steers running work and continues settled work from typed state", () => {
    const runningSource = "Tell Authentication review to use SQLite instead.";
    const running = interpret(
      context({ utterance: runningSource, focusedTask: task, recentCommandTasks: [task] }),
      proposal("continue", runningSource, [{ role: "task", text: "Authentication review" }]),
    );
    expect(running).toMatchObject({
      status: "command",
      command: { type: "continue", mode: "steer" },
    });

    const settled: CirceCommandTask = { ...task, state: "ready" };
    const settledSource = "Tell Authentication review to use SQLite instead.";
    const continued = interpret(
      context({ utterance: settledSource, focusedTask: settled, recentCommandTasks: [settled] }),
      proposal("steer", settledSource, [{ role: "task", text: "Authentication review" }]),
    );
    expect(continued).toMatchObject({
      status: "command",
      command: { type: "continue", mode: "continuation" },
    });
  });

  it("keeps queue intent on settled work for the host dispatcher", () => {
    const settled: CirceCommandTask = { ...task, state: "ready" };
    const source = "Queue a note for Authentication review.";
    const result = interpret(
      context({ utterance: source, focusedTask: settled, recentCommandTasks: [settled] }),
      proposal("queue", source, [{ role: "task", text: "Authentication review" }]),
    );
    expect(result).toMatchObject({
      status: "command",
      command: { type: "queue" },
    });
  });

  it("shows a pending approval to the model instead of leaving it to guess", () => {
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
    const prompt = buildCirceSemanticPrompt(
      context({ utterance: "Yes, allow it.", contextThread: approvalThread }),
      ready(context({ utterance: "Yes, allow it.", contextThread: approvalThread })),
    );
    expect(prompt).toContain("Pending request: approval");
    expect(prompt).toMatchObject(/pending/i);
  });
});

describe("red evidence: old failures stay fixed", () => {
  it("never selects an excluded project or strips its negation", () => {
    const source = "Check auth but not in Fable";
    const input = context({ utterance: source });
    const prepared = ready(input);
    expect("projectId" in prepared).toBe(false);
    const result = interpret(
      input,
      proposal("start", source, [{ role: "excluded", text: "Fable" }]),
    );
    expect(result).toMatchObject({
      status: "command",
      command: { type: "start", objective: "Check auth but not in Fable" },
    });
    if (result.status !== "command" || result.command.type !== "start") return;
    expect(result.command.projectId).toBe(circe.id);
    expect(result.command.projectId).not.toBe(fable.id);
  });

  it("preserves the literal double space through wrapper deletion", () => {
    const source = "Fix a  b in Fable";
    const input = context({ utterance: source, inputMode: "voice" });
    const result = interpret(
      input,
      proposal("start", source, [{ role: "destination", text: "in Fable", value: "Fable" }]),
    );
    expect(result).toMatchObject({
      status: "command",
      command: { type: "start", objective: "Fix a  b" },
    });
  });

  it("removes the whole cited wrapper, leaving no article or preposition behind", () => {
    const source = "Check auth in the Fable repo";
    const input = context({ utterance: source });
    const result = interpret(
      input,
      proposal("start", source, [
        { role: "destination", text: "in the Fable repo", value: "Fable" },
      ]),
    );
    expect(result).toMatchObject({
      status: "command",
      command: { type: "start", objective: "Check auth" },
    });
    if (result.status !== "command" || result.command.type !== "start") return;
    expect(result.command.projectId).toBe(fable.id);
  });

  it("never routes a subject mention without a cited destination", () => {
    const source = "Find docs about Fable";
    const input = context({ utterance: source });
    const subjectOnly = interpret(
      input,
      proposal("start", source, [{ role: "subject", text: "Fable" }]),
    );
    expect(subjectOnly).toMatchObject({
      status: "command",
      command: { type: "start", objective: "Find docs about Fable" },
    });
    if (subjectOnly.status !== "command" || subjectOnly.command.type !== "start") return;
    expect(subjectOnly.command.projectId).toBe(circe.id);
  });

  it("composes acceptance from the accepted route, so unknown names cannot leak into speech", () => {
    const source = "Shipping release notes";
    const input = context({ utterance: source });
    const result = interpret(input, proposal("start", source));
    expect(result).toMatchObject({
      status: "command",
      acknowledgement: "Request accepted for Beacon.",
      command: { type: "start", objective: "Shipping release notes" },
    });
  });

  it("never lets an unknown project name reach the spoken acknowledgement", () => {
    const source = "Shipping the release to UnknownProject.";
    const input = context({ utterance: source });
    const result = interpret(input, proposal("start", source));
    expect(result).toMatchObject({
      status: "command",
      acknowledgement: "Request accepted for Beacon.",
    });
    if (result.status !== "command") return;
    expect(result.acknowledgement ?? "").not.toContain("UnknownProject");
  });

  it("contains an incidental mention cited as a destination instead of routing it", () => {
    for (const destination of ["about Fable", "Fable"]) {
      const source = "Find documentation about Fable.";
      const result = interpret(
        context({ utterance: source }),
        proposal("start", source, [{ role: "destination", text: destination, value: "Fable" }]),
      );
      expect(result).toMatchObject({ status: "needs-input" });
      expect(result).not.toMatchObject({ status: "command", command: { type: "start" } });
    }
  });

  it("contains a destination for a project the transcript ruled out", () => {
    const source = "Test auth but not in Fable.";
    const result = interpret(
      context({ utterance: source }),
      proposal("start", source, [{ role: "destination", text: "in Fable", value: "Fable" }]),
    );
    expect(result).toMatchObject({ status: "needs-input" });
    expect(result).not.toMatchObject({ status: "command", command: { type: "start" } });
  });

  it("contains a quoted task mention instead of dispatching its control", () => {
    const source = 'Explain phrase "Authentication review".';
    const result = interpret(
      context({ utterance: source, focusedTask: task, recentCommandTasks: [task] }),
      proposal("status", source, [
        { role: "task", text: '"Authentication review"', value: "Authentication review" },
      ]),
    );
    expect(result).toMatchObject({ status: "needs-input" });
    expect(result).not.toMatchObject({ status: "command" });
  });

  it("maps an explicit unsupported proposal for a multiple-control request to needs-input", () => {
    const source = "Stop Authentication review and create a deployment task";
    // Containment lives in explicit proposal bounds: the model proposes
    // unsupported for two independent controls (per prompt), and the
    // Director answers needs-input. The Director reads refs, not
    // conjunctions; a single-control mis-proposal here is model-semantic
    // uncertainty, not host authority.
    const result = interpret(
      context({ utterance: source, focusedTask: task, recentCommandTasks: [task] }),
      proposal("unsupported", source),
    );
    expect(result).toMatchObject({ status: "needs-input", reason: "unsupported-command" });
    expect(result).not.toMatchObject({ status: "command", command: { type: "stop" } });
  });

  it("keeps one coding task with steps as a single start", () => {
    const source = "Fix auth, then run its tests";
    const result = interpret(context({ utterance: source }), proposal("start", source));
    expect(result).toMatchObject({ status: "command", command: { type: "start" } });
  });
});

describe("v1 destructive-action guard", () => {
  it("refuses a stop proposal when the transcript opens by ruling stop out", () => {
    const source = "Don't stop the Authentication review";
    const input = context({ utterance: source, focusedTask: task });
    const result = interpret(
      input,
      proposal("stop", source, [{ role: "task", text: "Authentication review" }]),
    );
    expect(result).toMatchObject({ status: "needs-input", reason: "unsupported-command" });
  });

  it("refuses a reroute proposal when the transcript opens with never", () => {
    const source = "Never move auth to Fable";
    const input = context({ utterance: source, focusedTask: task });
    const result = interpret(
      input,
      proposal("reroute", source, [{ role: "destination", text: "to Fable", value: "Fable" }]),
    );
    expect(result).toMatchObject({ status: "needs-input", reason: "unsupported-command" });
  });

  it("still dispatches an affirmative stop", () => {
    const source = "Stop the Authentication review";
    const input = context({ utterance: source, focusedTask: task });
    const result = interpret(
      input,
      proposal("stop", source, [{ role: "task", text: "Authentication review" }]),
    );
    expect(result).toMatchObject({ status: "command", command: { type: "stop" } });
  });

  it("treats a bare discourse no as a correction, not a negation", () => {
    const source = "No, stop the Authentication review";
    const input = context({ utterance: source, focusedTask: task });
    const result = interpret(
      input,
      proposal("stop", source, [{ role: "task", text: "Authentication review" }]),
    );
    expect(result).toMatchObject({ status: "command", command: { type: "stop" } });
  });
});

describe("v1 simple-command hardening", () => {
  it("never turns a quoted command into a control action", () => {
    const source = 'Say "stop the server" in Fable.';
    const input = context({ utterance: source });
    const result = interpret(
      input,
      proposal("start", source, [{ role: "destination", text: " in Fable", value: "Fable" }]),
    );
    expect(result).toMatchObject({
      status: "command",
      command: { type: "start", objective: 'Say "stop the server".' },
    });
    if (result.status !== "command" || result.command.type !== "start") return;
    expect(result.command.projectId).toBe(fable.id);
  });

  it("asks instead of resolving a quoted command as a task", () => {
    const source = 'Say "stop the server" in Fable.';
    const input = context({ utterance: source });
    const result = interpret(
      input,
      proposal("start", source, [
        { role: "destination", text: " in Fable", value: "Fable" },
        { role: "task", text: "stop the server", value: "stop the server" },
      ]),
    );
    expect(result).toMatchObject({ status: "needs-input", reason: "control-target-required" });
  });

  it("proceeds ambient with full wording when the exclusion names another project", () => {
    const source = "Check auth except in Fable";
    const input = context({ utterance: source });
    const result = interpret(
      input,
      proposal("start", source, [{ role: "excluded", text: "Fable" }]),
    );
    expect(result).toMatchObject({
      status: "command",
      command: { type: "start", objective: "Check auth except in Fable" },
    });
    if (result.status !== "command" || result.command.type !== "start") return;
    expect(result.command.projectId).toBe(circe.id);
  });

  it("routes a leading destination even without a comma", () => {
    const source = "In Fable fix auth";
    const input = context({ utterance: source });
    const result = interpret(
      input,
      proposal("start", source, [{ role: "destination", text: "In Fable ", value: "Fable" }]),
    );
    expect(result).toMatchObject({
      status: "command",
      command: { type: "start", objective: "fix auth" },
    });
    if (result.status !== "command" || result.command.type !== "start") return;
    expect(result.command.projectId).toBe(fable.id);
  });

  it("treats provider names inside the work as subjects, not selection", () => {
    const source = "Compare Codex output with Claude output";
    const input = context({ utterance: source });
    const result = interpret(input, proposal("start", source));
    expect(result).toMatchObject({
      status: "command",
      command: { type: "start", objective: "Compare Codex output with Claude output" },
    });
    if (result.status !== "command" || result.command.type !== "start") return;
    expect(result.command.projectId).toBe(circe.id);
  });

  it("refuses a lookup or website proposal that reaches the Director", () => {
    // The originating client runs these bounded actions; a proposal that
    // arrives here must never be misread as a new coding task.
    const lookup = interpret(
      context({ utterance: "What's the weather in Ahmedabad?" }),
      proposal("lookup", "What's the weather in Ahmedabad?", [], {
        lookup: { kind: "weather", location: "Ahmedabad", day: "now" },
      }),
    );
    expect(lookup).toMatchObject({ status: "needs-input", reason: "unsupported-command" });
    const website = interpret(
      context({ utterance: "Open YouTube" }),
      proposal("open-website", "Open YouTube", [], { website: "YouTube" }),
    );
    expect(website).toMatchObject({ status: "needs-input", reason: "unsupported-command" });
  });

  it("falls back to the first available provider when no default is set", () => {
    // The app can answer "which provider" from what is installed, so a new
    // task must not stop to ask when neither the node nor the project names
    // a default.
    const { nodeDefaultModelSelection: _omitDefault, ...input } = context({
      utterance: "Fix authentication.",
    });
    const result = interpret(input, proposal("start", "Fix authentication."));
    expect(result).toMatchObject({
      status: "command",
      command: {
        type: "start",
        modelSelection: { instanceId: codex.instanceId, model: "gpt-5.6-sol" },
      },
    });
  });

  it("skips a provider the catalog marks unavailable when falling back", () => {
    // The orb and mesh read `availability` too, so the Director must not
    // launch a provider the picker already renders unavailable.
    const { nodeDefaultModelSelection: _omitDefault, ...input } = context({
      utterance: "Fix authentication.",
      providers: [{ ...codex, availability: "unavailable" }, fableProvider],
    });
    const result = interpret(input, proposal("start", "Fix authentication."));
    expect(result).toMatchObject({
      status: "command",
      command: {
        type: "start",
        modelSelection: { instanceId: fableProvider.instanceId, model: "fable-reviewer" },
      },
    });
  });
});
