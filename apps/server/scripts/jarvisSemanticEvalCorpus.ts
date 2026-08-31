export type JarvisSemanticEvalCase = {
  readonly id: string;
  readonly utterance: string;
  readonly action:
    | "start"
    | "continue"
    | "steer"
    | "queue"
    | "stop"
    | "status"
    | "review"
    | "reroute"
    | "focus-project"
    | "focus-task"
    | "list-projects";
  readonly task?: string;
  readonly project?: string;
  readonly provider?: string;
  readonly continueContext?: boolean;
};

export const jarvisSemanticEvalCorpus: ReadonlyArray<JarvisSemanticEvalCase> = [
  {
    id: "start-01",
    utterance: "Fix the login redirect in Rivvl.",
    action: "start",
    project: "Rivvl",
  },
  { id: "start-02", utterance: "Add keyboard navigation to the command menu.", action: "start" },
  {
    id: "start-03",
    utterance: "Use Codex to tighten the websocket retry logic.",
    action: "start",
    provider: "Codex",
  },
  {
    id: "start-04",
    utterance: "In Jarvis, document the three capability presets.",
    action: "start",
    project: "Jarvis",
  },
  {
    id: "start-05",
    utterance: "Ask Claude to fix the flaky cache test.",
    action: "start",
    provider: "Claude",
  },
  {
    id: "start-06",
    utterance: "Create a health check for the VPS worker.",
    action: "start",
    project: "VPS",
  },
  {
    id: "start-07",
    utterance: "Refactor the task title formatter without changing behavior.",
    action: "start",
  },
  {
    id: "start-08",
    utterance: "Use Codex in Rivvl to add an auth integration test.",
    action: "start",
    project: "Rivvl",
    provider: "Codex",
  },
  { id: "start-09", utterance: "Investigate why mobile reconnects twice.", action: "start" },
  {
    id: "start-10",
    utterance: "Have Claude update the release checklist in Jarvis.",
    action: "start",
    project: "Jarvis",
    provider: "Claude",
  },

  {
    id: "continue-01",
    utterance: "Continue Rivvl authentication and run the integration tests.",
    action: "continue",
    task: "Rivvl authentication",
  },
  {
    id: "continue-02",
    utterance: "On the release docs task, add the upgrade notes.",
    action: "continue",
    task: "Release docs",
  },
  {
    id: "continue-03",
    utterance: "Continue deployment rollout and verify the health endpoint.",
    action: "continue",
    task: "Deployment rollout",
  },
  {
    id: "continue-04",
    utterance: "Go back to checkout cleanup and remove the dead branch.",
    action: "continue",
    task: "Checkout cleanup",
  },
  {
    id: "continue-05",
    utterance: "Now add an example for remote nodes.",
    action: "continue",
    continueContext: true,
  },
  {
    id: "continue-06",
    utterance: "Run the focused tests next.",
    action: "continue",
    continueContext: true,
  },
  {
    id: "continue-07",
    utterance: "Keep going and update the user docs.",
    action: "continue",
    continueContext: true,
  },

  {
    id: "steer-01",
    utterance: "Tell Rivvl authentication to use SQLite instead.",
    action: "steer",
    task: "Rivvl authentication",
  },
  {
    id: "steer-02",
    utterance: "For deployment rollout, do not restart the healthy node.",
    action: "steer",
    task: "Deployment rollout",
  },
  {
    id: "steer-03",
    utterance: "Change Rivvl authentication to test the token refresh path first.",
    action: "steer",
    task: "Rivvl authentication",
  },
  {
    id: "steer-04",
    utterance: "Tell deployment rollout to keep the existing tunnel.",
    action: "steer",
    task: "Deployment rollout",
  },
  {
    id: "steer-05",
    utterance: "Redirect Rivvl authentication: preserve the old cookie migration.",
    action: "steer",
    task: "Rivvl authentication",
  },
  {
    id: "steer-06",
    utterance: "While deployment rollout is running, check disk space before continuing.",
    action: "steer",
    task: "Deployment rollout",
  },

  {
    id: "queue-01",
    utterance: "After Rivvl authentication finishes, update the release notes.",
    action: "queue",
    task: "Rivvl authentication",
  },
  {
    id: "queue-02",
    utterance: "Queue a smoke test after deployment rollout.",
    action: "queue",
    task: "Deployment rollout",
  },
  {
    id: "queue-03",
    utterance: "When checkout cleanup is done, run the linter.",
    action: "queue",
    task: "Checkout cleanup",
  },
  {
    id: "queue-04",
    utterance: "After release docs, check every link.",
    action: "queue",
    task: "Release docs",
  },
  {
    id: "queue-05",
    utterance: "Add a rollback note after deployment rollout completes.",
    action: "queue",
    task: "Deployment rollout",
  },

  {
    id: "stop-01",
    utterance: "Stop Rivvl authentication.",
    action: "stop",
    task: "Rivvl authentication",
  },
  {
    id: "stop-02",
    utterance: "Cancel deployment rollout now.",
    action: "stop",
    task: "Deployment rollout",
  },
  {
    id: "stop-03",
    utterance: "Interrupt the checkout cleanup task.",
    action: "stop",
    task: "Checkout cleanup",
  },
  {
    id: "stop-04",
    utterance: "Stop release docs and clear its follow-ups.",
    action: "stop",
    task: "Release docs",
  },
  {
    id: "stop-05",
    utterance: "Please halt Rivvl authentication.",
    action: "stop",
    task: "Rivvl authentication",
  },

  {
    id: "status-01",
    utterance: "What's the status of Rivvl authentication?",
    action: "status",
    task: "Rivvl authentication",
  },
  {
    id: "status-02",
    utterance: "Is deployment rollout still running?",
    action: "status",
    task: "Deployment rollout",
  },
  {
    id: "status-03",
    utterance: "How did checkout cleanup finish?",
    action: "status",
    task: "Checkout cleanup",
  },
  {
    id: "status-04",
    utterance: "Give me the current state of release docs.",
    action: "status",
    task: "Release docs",
  },
  {
    id: "status-05",
    utterance: "Report on the Rivvl authentication task.",
    action: "status",
    task: "Rivvl authentication",
  },

  {
    id: "review-01",
    utterance: "Have Claude review Rivvl authentication.",
    action: "review",
    task: "Rivvl authentication",
    provider: "Claude",
  },
  {
    id: "review-02",
    utterance: "Use Codex to review the checkout cleanup result.",
    action: "review",
    task: "Checkout cleanup",
    provider: "Codex",
  },
  {
    id: "review-03",
    utterance: "Ask Claude for an independent review of release docs.",
    action: "review",
    task: "Release docs",
    provider: "Claude",
  },
  {
    id: "review-04",
    utterance: "Review deployment rollout with Codex.",
    action: "review",
    task: "Deployment rollout",
    provider: "Codex",
  },

  {
    id: "reroute-01",
    utterance: "Move Rivvl authentication to the VPS project.",
    action: "reroute",
    task: "Rivvl authentication",
    project: "VPS",
  },
  {
    id: "reroute-02",
    utterance: "Redo checkout cleanup in Rivvl.",
    action: "reroute",
    task: "Checkout cleanup",
    project: "Rivvl",
  },
  {
    id: "reroute-03",
    utterance: "Move deployment rollout into Jarvis.",
    action: "reroute",
    task: "Deployment rollout",
    project: "Jarvis",
  },

  {
    id: "focus-project-01",
    utterance: "Switch to the Rivvl project.",
    action: "focus-project",
    project: "Rivvl",
  },
  {
    id: "focus-project-02",
    utterance: "Use VPS for new work.",
    action: "focus-project",
    project: "VPS",
  },
  {
    id: "focus-task-01",
    utterance: "Focus the release docs task.",
    action: "focus-task",
    task: "Release docs",
  },
  {
    id: "focus-task-02",
    utterance: "Switch to Rivvl authentication.",
    action: "focus-task",
    task: "Rivvl authentication",
  },
  { id: "list-projects-01", utterance: "What projects do I have?", action: "list-projects" },
];
