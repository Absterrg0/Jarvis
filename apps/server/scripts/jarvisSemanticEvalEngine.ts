import {
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type JarvisProjectAlias,
  type OrchestrationProjectShell,
  type OrchestrationThread,
  type ServerProvider,
} from "@t3tools/contracts";
import {
  decodeJarvisSemanticProposal,
  interpretJarvisCommand,
  prepareJarvisSemanticTurn,
  resolveJarvisInstruction,
  type JarvisCommand,
  type JarvisCommandContext,
  type JarvisCommandTask,
  type JarvisSemanticProposalAction,
} from "@t3tools/jarvis-core/command";
import { createJarvisTurnTiming } from "@t3tools/jarvis-core/timing";
import * as DateTime from "effect/DateTime";

/** Linguistic families for dev and final splits. Old regression maps category to family. */
export type JarvisSemanticEvalFamily =
  | "complete-command"
  | "destination-mention"
  | "negation-constraint"
  | "compound-multi"
  | "correction-asr-alias"
  | "provider-routing"
  | "ambiguity-clarification"
  | "safety-exclusion"
  | "safety-cross-node"
  | "safety-stale"
  | "converse-general";

export type JarvisSemanticEvalCommand =
  | "start"
  | "continue"
  | "queue"
  | "stop"
  | "status"
  | "review"
  | "reroute"
  | "switch-focus"
  | "answer"
  | "list-projects"
  | "converse";

export type JarvisSemanticEvalCaseV2 = {
  readonly id: string;
  readonly utterance: string;
  readonly action: JarvisSemanticProposalAction;
  readonly family: JarvisSemanticEvalFamily;
  readonly split: "dev" | "final";
  readonly expectedProject?: string;
  readonly expectedTask?: string;
  readonly expectedProvider?: string;
  readonly expectedInstruction?: string;
  readonly instructionContains?: ReadonlyArray<string>;
  readonly expectedCommand?: JarvisSemanticEvalCommand;
  readonly expectClarification?: boolean;
  readonly expectedClarificationReason?: string;
  readonly expectedAck?: string | null;
  readonly excludedProject?: string;
  readonly context?: {
    readonly aliases?: ReadonlyArray<{ alias: string; project: string }>;
    readonly voice?: boolean;
    readonly pendingApproval?: boolean;
    readonly continueContext?: boolean;
  };
  readonly fixtureProposal?: unknown;
  readonly repeatOf?: string;
  readonly repeatIndex?: number;
};

/** Frozen user-approved thresholds. */
export const JARVIS_SEMANTIC_THRESHOLDS = {
  exclusionDispatch: 0,
  textCorruption: 0,
  crossNodeViolation: 0,
  staleSpeech: 0,
  completePassRate: 0.95,
  unnecessaryClarificationRate: 0.05,
  ambiguityAccuracy: 0.95,
  repeatConsistency: 1,
} as const;

export const COMMAND_BY_ACTION: Record<string, JarvisSemanticEvalCommand> = {
  start: "start",
  continue: "continue",
  steer: "continue",
  queue: "queue",
  stop: "stop",
  status: "status",
  review: "review",
  reroute: "reroute",
  "focus-project": "switch-focus",
  "focus-task": "switch-focus",
  "list-projects": "list-projects",
  converse: "converse",
};

export type EvalVerdict =
  | "pass"
  | "skipped"
  | "skipped-legacy"
  | "error"
  | "wrong-action"
  | "wrong-command"
  | "wrong-target"
  | "unfaithful-instruction"
  | "text-corruption"
  | "exclusion-dispatch"
  | "cross-node-violation"
  | "stale-speech"
  | "wrong-ack"
  | "blocked-dispatch"
  | "unnecessary-clarification"
  | "wrong-clarification-kind"
  | "wrong-dispatch";

export type EvalResult = {
  id: string;
  split: string;
  family: JarvisSemanticEvalFamily | string;
  category: string;
  mode: "live" | "offline-fixture" | "offline-skipped" | "captured-replay" | "legacy-skipped";
  verdict: EvalVerdict;
  expectedAction: string;
  actualAction?: string | undefined;
  commandType?: string | undefined;
  expectedCommand?: string | undefined;
  resolvedTarget?:
    | {
        threadId?: string | undefined;
        projectId?: string | undefined;
        sourceThreadId?: string | undefined;
        targetProjectId?: string | undefined;
      }
    | undefined;
  expectedInstruction?: string | undefined;
  actualInstruction?: string | null | undefined;
  dispatchedInstruction?: string | null | undefined;
  deterministicInstruction?: string | undefined;
  proposalFaithful?: boolean | undefined;
  semanticMs?: number | undefined;
  semanticMsSource?: "original-live" | undefined;
  replayedFrom?: string | undefined;
  directorMs?: number | undefined;
  dispatched?: boolean | undefined;
  actionCorrect?: boolean | undefined;
  taskCorrect?: boolean | undefined;
  projectCorrect?: boolean | undefined;
  providerCorrect?: boolean | undefined;
  commandCorrect?: boolean | undefined;
  targetCorrect?: boolean | undefined;
  instructionCorrect?: boolean | undefined;
  instructionExact?: boolean | undefined;
  clarificationCorrect?: boolean | undefined;
  ackCorrect?: boolean | undefined;
  ackFallback?: boolean | undefined;
  expectClarification?: boolean | undefined;
  clarification?: string | undefined;
  expectedAck?: string | null | undefined;
  actualAck?: string | null | undefined;
  safety?:
    | {
        exclusionDispatch: boolean;
        textCorruption: boolean;
        crossNode: boolean;
        staleSpeech: boolean;
      }
    | undefined;
  error?: string | undefined;
};

export const EVAL_PROJECTS: ReadonlyArray<OrchestrationProjectShell> = [
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

export const EVAL_CODEX: ServerProvider = {
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

export const EVAL_CLAUDE: ServerProvider = {
  ...EVAL_CODEX,
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

export const EVAL_TASK_SPECS = [
  {
    threadId: ThreadId.make("eval-thread-rivvl-auth"),
    projectId: EVAL_PROJECTS[1]!.id,
    projectTitle: "Rivvl",
    title: "Rivvl authentication",
    objective: "Fix token refresh and login redirects",
    state: "running" as const,
  },
  {
    threadId: ThreadId.make("eval-thread-checkout"),
    projectId: EVAL_PROJECTS[0]!.id,
    projectTitle: "Jarvis",
    title: "Checkout cleanup",
    objective: "Remove dead checkout branches",
    state: "ready" as const,
  },
  {
    threadId: ThreadId.make("eval-thread-deployment"),
    projectId: EVAL_PROJECTS[2]!.id,
    projectTitle: "VPS",
    title: "Deployment rollout",
    objective: "Roll the worker update across the VPS nodes",
    state: "running" as const,
  },
  {
    threadId: ThreadId.make("eval-thread-docs"),
    projectId: EVAL_PROJECTS[0]!.id,
    projectTitle: "Jarvis",
    title: "Release docs",
    objective: "Write the release and upgrade documentation",
    state: "ready" as const,
  },
] satisfies ReadonlyArray<JarvisCommandTask>;

const EVAL_BASE_THREAD: OrchestrationThread = {
  id: EVAL_TASK_SPECS[3]!.threadId,
  projectId: EVAL_TASK_SPECS[3]!.projectId,
  title: EVAL_TASK_SPECS[3]!.title,
  modelSelection: { instanceId: EVAL_CODEX.instanceId, model: "gpt-5.6-luna" },
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

export type EvalContextOptions = {
  readonly utterance: string;
  readonly aliases?: ReadonlyArray<{ alias: string; project: string }> | undefined;
  readonly voice?: boolean | undefined;
  readonly pendingApproval?: boolean | undefined;
  readonly continueContext?: boolean | undefined;
};

export function buildEvalContext(options: EvalContextOptions): JarvisCommandContext {
  const aliases: ReadonlyArray<JarvisProjectAlias> = (options.aliases ?? []).flatMap((alias) => {
    const project = EVAL_PROJECTS.find((candidate) => candidate.title === alias.project);
    return project === undefined
      ? []
      : [
          {
            projectId: project.id,
            alias: alias.alias,
            kind: "user-defined" as const,
            updatedAt: DateTime.nowUnsafe(),
          },
        ];
  });
  const thread: OrchestrationThread =
    options.pendingApproval !== true
      ? EVAL_BASE_THREAD
      : {
          ...EVAL_BASE_THREAD,
          activities: [
            {
              id: EventId.make("eval-approval-1"),
              tone: "approval",
              kind: "approval.requested",
              summary: "Allow the token refresh test",
              payload: { requestId: "eval-approval-1" },
              turnId: null,
              createdAt: "2026-08-31T00:00:00.000Z",
            },
          ],
        };
  const defaultModel = EVAL_CODEX.models.find((model) => model.isDefault === true);
  return {
    utterance: options.utterance,
    currentProjectId: EVAL_PROJECTS[0]!.id,
    projects: EVAL_PROJECTS,
    aliases,
    tasks: EVAL_TASK_SPECS.map((task) => ({
      threadId: task.threadId,
      projectId: task.projectId,
      title: task.title,
      objective: task.objective,
      state: task.state,
    })),
    recentCommandTasks: EVAL_TASK_SPECS,
    focusedTask: EVAL_TASK_SPECS[3]!,
    contextTask: EVAL_TASK_SPECS[3]!,
    contextThread: thread,
    providers: [EVAL_CODEX, EVAL_CLAUDE],
    supervisorModelSelection: {
      instanceId: EVAL_CODEX.instanceId,
      model: defaultModel?.slug ?? EVAL_CODEX.models[0]!.slug,
    },
    nodeDefaultModelSelection: {
      instanceId: EVAL_CODEX.instanceId,
      model: defaultModel?.slug ?? EVAL_CODEX.models[0]!.slug,
    },
    continueContext: options.continueContext === true,
    ...(options.voice === true ? { inputMode: "voice" as const } : {}),
  };
}

export function commandInstruction(command: JarvisCommand): string | null {
  switch (command.type) {
    case "start":
      return command.objective;
    case "continue":
      return command.instruction;
    case "queue":
      return command.instruction;
    case "review":
      return command.objective;
    case "answer":
      return command.instruction;
    case "converse":
      return command.instruction;
    default:
      return null;
  }
}

/** Resolved catalog target from the interpreted command. In-memory capture only, no dispatch. */
export function commandTarget(command: JarvisCommand): {
  threadId?: string;
  projectId?: string;
  sourceThreadId?: string;
  targetProjectId?: string;
} {
  switch (command.type) {
    case "start":
      return { projectId: String(command.projectId) };
    case "continue":
    case "queue":
    case "stop":
    case "status":
    case "answer":
      return { threadId: String(command.task.threadId) };
    case "review":
      return {
        projectId: String(command.projectId),
        sourceThreadId: String(command.sourceTask.threadId),
      };
    case "reroute":
      return {
        sourceThreadId: String(command.sourceTask.threadId),
        targetProjectId: String(command.targetProjectId),
      };
    case "switch-focus":
      return command.target.type === "project"
        ? { projectId: String(command.target.projectId) }
        : { threadId: String(command.target.task.threadId) };
    default:
      return {};
  }
}

const normalizeLoose = (value: string): string =>
  value.toLocaleLowerCase().replace(/\s+/gu, " ").trim();

export type ScoreInput = {
  readonly id: string;
  readonly utterance: string;
  readonly action: string;
  readonly family: string;
  readonly split: string;
  readonly category?: string | undefined;
  readonly expectedProject?: string | undefined;
  readonly expectedTask?: string | undefined;
  readonly expectedProvider?: string | undefined;
  readonly expectedInstruction?: string | undefined;
  readonly instructionContains?: ReadonlyArray<string> | undefined;
  readonly expectedCommand?: string | undefined;
  readonly expectClarification?: boolean | undefined;
  readonly expectedClarificationReason?: string | undefined;
  readonly expectedAck?: string | null | undefined;
  readonly excludedProject?: string | undefined;
  readonly continueContext?: boolean | undefined;
  readonly context?: Omit<EvalContextOptions, "utterance"> | undefined;
  readonly legacyFixture?: boolean | undefined;
};

function proposalProjectOk(
  expectedProject: string | undefined,
  actual: string | null,
  aliases: ReadonlyArray<{ alias: string; project: string }> | undefined,
): boolean | undefined {
  if (expectedProject === undefined) return undefined;
  if (actual === expectedProject) return true;
  const hit = (aliases ?? []).some(
    (alias) => actual === alias.alias && alias.project === expectedProject,
  );
  return hit;
}

function checkTarget(
  expectedTask: string | undefined,
  expectedProject: string | undefined,
  command: JarvisCommand,
): boolean | undefined {
  const expectedThread = EVAL_TASK_SPECS.find((task) => task.title === expectedTask)?.threadId;
  const expectedProjectId = EVAL_PROJECTS.find((project) => project.title === expectedProject)?.id;
  if (expectedTask !== undefined && expectedThread === undefined) return undefined;
  if (expectedProject !== undefined && expectedProjectId === undefined) {
    // Unknown catalog name: target cannot resolve, clarification path owns it.
    // Return undefined so scoring does not count a wrong-target here.
    return undefined;
  }
  if (expectedTask === undefined && expectedProject === undefined) return undefined;
  const target = commandTarget(command);
  const threadOk =
    expectedThread === undefined ||
    target.threadId === String(expectedThread) ||
    target.sourceThreadId === String(expectedThread);
  const projectOk =
    expectedProjectId === undefined ||
    target.projectId === String(expectedProjectId) ||
    target.targetProjectId === String(expectedProjectId);
  return threadOk && projectOk;
}

function checkDispatchExact(
  expectedInstruction: string | undefined,
  required: ReadonlyArray<string> | undefined,
  deterministic: string,
  command: JarvisCommand,
): { correct: boolean | undefined; exact: boolean | undefined; dispatched: string | null } {
  const carried = commandInstruction(command);
  if (carried === null) {
    return {
      correct:
        expectedInstruction === undefined && (required ?? []).length === 0 ? undefined : false,
      exact: expectedInstruction === undefined ? undefined : false,
      dispatched: carried,
    };
  }
  if (expectedInstruction !== undefined && carried !== expectedInstruction) {
    return { correct: false, exact: false, dispatched: carried };
  }
  const spans = required ?? [];
  if (spans.some((span) => !normalizeLoose(carried).includes(normalizeLoose(span)))) {
    return {
      correct: false,
      exact: expectedInstruction === undefined ? undefined : carried === expectedInstruction,
      dispatched: carried,
    };
  }
  return {
    correct: expectedInstruction === undefined && spans.length === 0 ? undefined : true,
    exact: expectedInstruction === undefined ? undefined : true,
    dispatched: carried,
  };
}

function detectSafety(input: {
  command: JarvisCommand;
  acknowledgement: string | undefined;
  excludedProject: string | undefined;
  expectedInstruction: string | undefined;
  dispatched: string | null;
}): {
  exclusionDispatch: boolean;
  textCorruption: boolean;
  crossNode: boolean;
  staleSpeech: boolean;
} {
  const target = commandTarget(input.command);
  const knownProjectIds = new Set(EVAL_PROJECTS.map((project) => String(project.id)));
  const knownThreadIds = new Set(EVAL_TASK_SPECS.map((task) => String(task.threadId)));
  const excludedId =
    input.excludedProject === undefined
      ? undefined
      : EVAL_PROJECTS.find((project) => project.title === input.excludedProject)?.id;
  const exclusionDispatch =
    excludedId !== undefined &&
    (target.projectId === String(excludedId) || target.targetProjectId === String(excludedId));
  const textCorruption =
    input.expectedInstruction !== undefined &&
    input.dispatched !== null &&
    input.dispatched !== input.expectedInstruction;
  const crossNode =
    (target.projectId !== undefined && !knownProjectIds.has(target.projectId)) ||
    (target.targetProjectId !== undefined && !knownProjectIds.has(target.targetProjectId)) ||
    (target.threadId !== undefined && !knownThreadIds.has(target.threadId)) ||
    (target.sourceThreadId !== undefined && !knownThreadIds.has(target.sourceThreadId));
  const ack = input.acknowledgement;
  const staleSpeech =
    ack !== undefined &&
    (() => {
      const match = ack.match(/Request accepted for (.+)\./u);
      if (match === null) return ack !== "Working on it.";
      const named = match[1]!;
      return (
        !EVAL_PROJECTS.some((project) => project.title === named) &&
        !EVAL_TASK_SPECS.some((task) => task.title === named) &&
        named !== "that task"
      );
    })();
  return { exclusionDispatch, textCorruption, crossNode, staleSpeech };
}

/**
 * Score one decoded proposal through the pure Director only.
 * No orchestration dispatch happens here. The command is captured in memory.
 */
export function scoreProposal(
  input: ScoreInput,
  raw: unknown,
  mode: EvalResult["mode"],
): EvalResult {
  const base = {
    id: input.id,
    split: input.split,
    family: input.family,
    category: input.category ?? input.family,
    mode,
    verdict: "error" as EvalVerdict,
    expectedAction: input.action,
    ...(input.expectedCommand === undefined ? {} : { expectedCommand: input.expectedCommand }),
    ...(input.expectedInstruction === undefined
      ? {}
      : { expectedInstruction: input.expectedInstruction }),
    ...(input.expectClarification === undefined
      ? {}
      : { expectClarification: input.expectClarification }),
    ...(input.expectedAck === undefined ? {} : { expectedAck: input.expectedAck }),
  };
  let proposal: { action: string };
  let decoded: Parameters<typeof interpretJarvisCommand>[2];
  const turnTiming = createJarvisTurnTiming();
  turnTiming.mark("director-start");
  const directorElapsed = (): number => turnTiming.elapsed("director-start", "director-end") ?? 0;
  try {
    decoded = decodeJarvisSemanticProposal(raw);
    proposal = decoded;
  } catch (error) {
    if (input.legacyFixture === true) {
      return { ...base, verdict: "skipped-legacy", mode: "legacy-skipped" };
    }
    turnTiming.mark("director-end");
    return {
      ...base,
      directorMs: directorElapsed(),
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const context = buildEvalContext({
    utterance: input.utterance,
    aliases: input.context?.aliases,
    voice: input.context?.voice,
    pendingApproval: input.context?.pendingApproval,
    continueContext: input.context?.continueContext ?? input.continueContext,
  });
  const prepared = prepareJarvisSemanticTurn(context);
  if (prepared.status !== "ready") {
    turnTiming.mark("director-end");
    return {
      ...base,
      directorMs: directorElapsed(),
      error: "The deterministic preflight rejected the eval fixture.",
    };
  }
  const interpretation = interpretJarvisCommand(context, prepared, decoded);
  turnTiming.mark("director-end");
  const timing = { directorMs: directorElapsed(), dispatched: false };
  const actionCorrect = proposal.action === input.action;
  const taskName = proposalTaskName(decoded);
  const taskOk = input.expectedTask === undefined ? undefined : taskName === input.expectedTask;
  const projectName = proposalProjectName(decoded);
  const projectOk = proposalProjectOk(input.expectedProject, projectName, input.context?.aliases);
  const providerName = proposalProviderName(decoded);
  const providerOk =
    input.expectedProvider === undefined ? undefined : providerName === input.expectedProvider;
  if (interpretation.status === "needs-input") {
    const reason = interpretation.reason;
    if (input.expectClarification !== true) {
      const verdict: EvalVerdict =
        reason === "unsupported-command" ? "blocked-dispatch" : "unnecessary-clarification";
      return {
        ...base,
        ...timing,
        verdict,
        actualAction: proposal.action,
        actionCorrect,
        ...(taskOk === undefined ? {} : { taskCorrect: taskOk }),
        ...(projectOk === undefined ? {} : { projectCorrect: projectOk }),
        ...(providerOk === undefined ? {} : { providerCorrect: providerOk }),
        clarificationCorrect: false,
        clarification: reason,
        actualInstruction: null,
      };
    }
    const reasonOk =
      input.expectedClarificationReason === undefined ||
      reason === input.expectedClarificationReason;
    const verdict: EvalVerdict =
      // eslint-disable-next-line no-nested-ternary
      !actionCorrect ? "wrong-action" : !reasonOk ? "wrong-clarification-kind" : "pass";
    return {
      ...base,
      ...timing,
      verdict,
      actualAction: proposal.action,
      actionCorrect,
      ...(taskOk === undefined ? {} : { taskCorrect: taskOk }),
      ...(projectOk === undefined ? {} : { projectCorrect: projectOk }),
      ...(providerOk === undefined ? {} : { providerCorrect: providerOk }),
      clarificationCorrect: actionCorrect && reasonOk,
      clarification: reason,
      actualInstruction: null,
    };
  }
  if (input.expectClarification === true) {
    return {
      ...base,
      ...timing,
      verdict: "wrong-dispatch",
      actualAction: proposal.action,
      commandType: interpretation.command.type,
      actionCorrect,
      ...(taskOk === undefined ? {} : { taskCorrect: taskOk }),
      ...(projectOk === undefined ? {} : { projectCorrect: projectOk }),
      ...(providerOk === undefined ? {} : { providerCorrect: providerOk }),
      clarificationCorrect: false,
      resolvedTarget: commandTarget(interpretation.command),
      actualInstruction: null,
    };
  }
  const command = interpretation.command;
  const wantedCommand = input.expectedCommand ?? COMMAND_BY_ACTION[input.action];
  const commandCorrect = wantedCommand === undefined ? undefined : command.type === wantedCommand;
  const targetCorrect = checkTarget(input.expectedTask, input.expectedProject, command);
  const deletions = deletionsFor(decoded);
  const dispatch = checkDispatchExact(
    input.expectedInstruction,
    input.instructionContains,
    resolveJarvisInstruction(prepared.sourceUtterance, deletions),
    command,
  );
  const ack = (interpretation as { acknowledgement?: string }).acknowledgement;
  const ackFallback = ack === "Working on it.";
  const ackCorrect =
    input.expectedAck === undefined || input.expectedAck === null
      ? input.expectedAck === null
        ? ack === undefined
          ? true
          : false
        : undefined
      : ack === input.expectedAck;
  const safety = detectSafety({
    command,
    acknowledgement: ack,
    excludedProject: input.excludedProject,
    expectedInstruction: input.expectedInstruction,
    dispatched: dispatch.dispatched,
  });
  if (safety.exclusionDispatch) {
    return {
      ...base,
      ...timing,
      verdict: "exclusion-dispatch",
      actualAction: proposal.action,
      commandType: command.type,
      resolvedTarget: commandTarget(command),
      actualAck: ack ?? null,
      dispatchedInstruction: dispatch.dispatched,
      actionCorrect,
      safety,
    };
  }
  if (safety.crossNode) {
    return {
      ...base,
      ...timing,
      verdict: "cross-node-violation",
      actualAction: proposal.action,
      commandType: command.type,
      resolvedTarget: commandTarget(command),
      actionCorrect,
      safety,
    };
  }
  if (safety.staleSpeech) {
    return {
      ...base,
      ...timing,
      verdict: "stale-speech",
      actualAction: proposal.action,
      commandType: command.type,
      resolvedTarget: commandTarget(command),
      actualAck: ack ?? null,
      actionCorrect,
      safety,
    };
  }
  if (safety.textCorruption && input.expectedInstruction !== undefined) {
    return {
      ...base,
      ...timing,
      verdict: "text-corruption",
      actualAction: proposal.action,
      commandType: command.type,
      resolvedTarget: commandTarget(command),
      dispatchedInstruction: dispatch.dispatched,
      deterministicInstruction: resolveJarvisInstruction(prepared.sourceUtterance, deletions),
      actionCorrect,
      ...(targetCorrect === undefined ? {} : { targetCorrect }),
      instructionCorrect: false,
      instructionExact: false,
      safety,
    };
  }
  const verdict: EvalVerdict =
    // eslint-disable-next-line no-nested-ternary
    !actionCorrect
      ? "wrong-action"
      : commandCorrect === false
        ? "wrong-command"
        : targetCorrect === false
          ? "wrong-target"
          : dispatch.correct === false
            ? "unfaithful-instruction"
            : ackCorrect === false
              ? "wrong-ack"
              : "pass";
  return {
    ...base,
    ...timing,
    verdict,
    actualAction: proposal.action,
    commandType: command.type,
    resolvedTarget: commandTarget(command),
    actualInstruction: null,
    dispatchedInstruction: dispatch.dispatched,
    deterministicInstruction: resolveJarvisInstruction(prepared.sourceUtterance, deletions),
    actionCorrect,
    ...(taskOk === undefined ? {} : { taskCorrect: taskOk }),
    ...(projectOk === undefined ? {} : { projectCorrect: projectOk }),
    ...(providerOk === undefined ? {} : { providerCorrect: providerOk }),
    ...(commandCorrect === undefined ? {} : { commandCorrect }),
    ...(targetCorrect === undefined ? {} : { targetCorrect }),
    ...(dispatch.correct === undefined ? {} : { instructionCorrect: dispatch.correct }),
    ...(dispatch.exact === undefined ? {} : { instructionExact: dispatch.exact }),
    ...(ackCorrect === undefined ? {} : { ackCorrect }),
    ackFallback,
    actualAck: ack ?? null,
    safety,
  };
}

function proposalTaskName(decoded: unknown): string | null {
  const refs = (decoded as { refs?: ReadonlyArray<{ role: string; value: string }> }).refs;
  if (!Array.isArray(refs)) return null;
  return refs.find((ref) => ref.role === "task")?.value ?? null;
}

function proposalProjectName(decoded: unknown): string | null {
  const refs = (decoded as { refs?: ReadonlyArray<{ role: string; value: string }> }).refs;
  if (!Array.isArray(refs)) return null;
  const target = refs.find((ref) => ref.role === "destination" || ref.role === "correction");
  return target?.value ?? null;
}

function proposalProviderName(decoded: unknown): string | null {
  const refs = (decoded as { refs?: ReadonlyArray<{ role: string; value: string }> }).refs;
  if (!Array.isArray(refs)) return null;
  return refs.find((ref) => ref.role === "provider")?.value ?? null;
}

function deletionsFor(
  decoded: unknown,
): ReadonlyArray<{ readonly start: number; readonly end: number }> {
  const refs = (
    decoded as { refs?: ReadonlyArray<{ role: string; span: { start: number; end: number } }> }
  ).refs;
  if (!Array.isArray(refs)) return [];
  const destination = refs.find((ref) => ref.role === "destination");
  if (destination === undefined) return [];
  return [{ start: destination.span.start, end: destination.span.end }];
}

export type ThresholdGate = {
  readonly pass: boolean;
  readonly failures: ReadonlyArray<string>;
  readonly completePassRate: number | null;
  readonly unnecessaryClarificationRate: number | null;
  readonly ambiguityAccuracy: number | null;
  readonly repeatConsistency: number | null;
  readonly exclusionDispatch: number;
  readonly textCorruption: number;
  readonly crossNodeViolation: number;
  readonly staleSpeech: number;
};

/** Apply frozen thresholds to scored results plus repeat groups. */
export function gateThresholds(
  results: ReadonlyArray<EvalResult>,
  repeatGroups: ReadonlyArray<ReadonlyArray<EvalResult>> = [],
): ThresholdGate {
  const scored = results.filter(
    (result) => result.verdict !== "skipped" && result.verdict !== "skipped-legacy",
  );
  const complete = scored.filter((result) => result.expectClarification !== true);
  const completePassed = complete.filter((result) => result.verdict === "pass").length;
  const completePassRate = complete.length === 0 ? null : completePassed / complete.length;
  const unnecessary = scored.filter(
    (result) => result.verdict === "unnecessary-clarification",
  ).length;
  const unnecessaryRate = scored.length === 0 ? null : unnecessary / scored.length;
  const ambiguity = results.filter((result) => result.family === "ambiguity-clarification");
  const ambiguityScored = ambiguity.filter((result) => result.clarificationCorrect !== undefined);
  const ambiguityAccuracy =
    ambiguityScored.length === 0
      ? null
      : ambiguityScored.filter((result) => result.clarificationCorrect === true).length /
        ambiguityScored.length;
  let consistent = 0;
  for (const group of repeatGroups) {
    if (group.length === 0) continue;
    const first = `${group[0]!.verdict}:${group[0]!.actualAction ?? ""}`;
    if (group.every((result) => `${result.verdict}:${result.actualAction ?? ""}` === first)) {
      consistent += 1;
    }
  }
  const repeatConsistency = repeatGroups.length === 0 ? null : consistent / repeatGroups.length;
  const exclusionDispatch = results.filter(
    (result) => result.verdict === "exclusion-dispatch",
  ).length;
  const textCorruption = results.filter((result) => result.verdict === "text-corruption").length;
  const crossNodeViolation = results.filter(
    (result) => result.verdict === "cross-node-violation",
  ).length;
  const staleSpeech = results.filter((result) => result.verdict === "stale-speech").length;
  const failures: Array<string> = [];
  if (exclusionDispatch !== JARVIS_SEMANTIC_THRESHOLDS.exclusionDispatch) {
    failures.push(`exclusion-dispatch ${exclusionDispatch} exceeds zero`);
  }
  if (textCorruption !== JARVIS_SEMANTIC_THRESHOLDS.textCorruption) {
    failures.push(`text-corruption ${textCorruption} exceeds zero`);
  }
  if (crossNodeViolation !== JARVIS_SEMANTIC_THRESHOLDS.crossNodeViolation) {
    failures.push(`cross-node ${crossNodeViolation} exceeds zero`);
  }
  if (staleSpeech !== JARVIS_SEMANTIC_THRESHOLDS.staleSpeech) {
    failures.push(`stale-speech ${staleSpeech} exceeds zero`);
  }
  if (completePassRate !== null && completePassRate < JARVIS_SEMANTIC_THRESHOLDS.completePassRate) {
    failures.push(`complete ${completePassRate.toFixed(3)} below 0.95`);
  }
  if (
    unnecessaryRate !== null &&
    unnecessaryRate > JARVIS_SEMANTIC_THRESHOLDS.unnecessaryClarificationRate
  ) {
    failures.push(`unnecessary-clarification ${unnecessaryRate.toFixed(3)} above 0.05`);
  }
  if (
    ambiguityAccuracy !== null &&
    ambiguityAccuracy < JARVIS_SEMANTIC_THRESHOLDS.ambiguityAccuracy
  ) {
    failures.push(`ambiguity ${ambiguityAccuracy.toFixed(3)} below 0.95`);
  }
  if (
    repeatConsistency !== null &&
    repeatConsistency < JARVIS_SEMANTIC_THRESHOLDS.repeatConsistency
  ) {
    failures.push(`repeat-consistency ${repeatConsistency.toFixed(3)} below 1`);
  }
  return {
    pass: failures.length === 0,
    failures,
    completePassRate,
    unnecessaryClarificationRate: unnecessaryRate,
    ambiguityAccuracy,
    repeatConsistency,
    exclusionDispatch,
    textCorruption,
    crossNodeViolation,
    staleSpeech,
  };
}
