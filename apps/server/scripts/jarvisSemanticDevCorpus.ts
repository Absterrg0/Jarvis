import type { JarvisSemanticEvalCaseV2 } from "./jarvisSemanticEvalEngine.ts";
import type { SemanticRef, SemanticRole } from "@t3tools/jarvis-core/command";

function cite(source: string, text: string, from = 0): SemanticRef["span"] {
  const start = source.indexOf(text, from);
  if (start < 0)
    throw new Error(`cite missing ${JSON.stringify(text)} in ${JSON.stringify(source)}`);
  return { start, end: start + text.length, text };
}

function ref(source: string, role: SemanticRole, text: string, value = text): SemanticRef {
  return { span: cite(source, text), role, value };
}

function proposal(
  action: JarvisSemanticEvalCaseV2["action"],
  source: string,
  roles: ReadonlyArray<{ role: SemanticRole; text: string; value?: string }> = [],
  extra: { model?: string | null; effort?: string | null; answer?: string | null } = {},
): unknown {
  return {
    action,
    refs: roles.map(({ role, text, value }) => ref(source, role, text, value ?? text)),
    model: extra.model ?? null,
    effort: extra.effort ?? null,
    answer: extra.answer ?? null,
  };
}

/**
 * Independent dev regression. Small, in-repo, new-schema only.
 * Previous 92-case corpus is now regression. This set is for iteration.
 * Every expected string is literal, never derived from production code.
 */
export const jarvisSemanticDevCorpus: ReadonlyArray<JarvisSemanticEvalCaseV2> = [
  {
    id: "dev-complete-01",
    utterance: "Fix the login redirect in Rivvl.",
    action: "start",
    family: "destination-mention",
    split: "dev",
    expectedProject: "Rivvl",
    expectedInstruction: "Fix the login redirect.",
    expectedCommand: "start",
    expectedAck: "Request accepted for Rivvl.",
    fixtureProposal: proposal("start", "Fix the login redirect in Rivvl.", [
      { role: "destination", text: " in Rivvl", value: "Rivvl" },
    ]),
  },
  {
    id: "dev-complete-02",
    utterance: "Add keyboard navigation to the command menu.",
    action: "start",
    family: "complete-command",
    split: "dev",
    expectedInstruction: "Add keyboard navigation to the command menu.",
    expectedCommand: "start",
    expectedAck: "Request accepted for Jarvis.",
    fixtureProposal: proposal("start", "Add keyboard navigation to the command menu."),
  },
  {
    id: "dev-provider-01",
    utterance: "Use Codex to tighten the websocket retry logic.",
    action: "start",
    family: "provider-routing",
    split: "dev",
    expectedProvider: "Codex",
    expectedInstruction: "Use Codex to tighten the websocket retry logic.",
    expectedCommand: "start",
    expectedAck: "Request accepted for Jarvis.",
    fixtureProposal: proposal("start", "Use Codex to tighten the websocket retry logic.", [
      { role: "provider", text: "Codex" },
    ]),
  },
  {
    id: "dev-task-01",
    utterance: "Continue Rivvl authentication and run the integration tests.",
    action: "continue",
    family: "complete-command",
    split: "dev",
    expectedTask: "Rivvl authentication",
    expectedInstruction: "Continue Rivvl authentication and run the integration tests.",
    expectedCommand: "continue",
    expectedAck: null,
    fixtureProposal: proposal(
      "continue",
      "Continue Rivvl authentication and run the integration tests.",
      [{ role: "task", text: "Rivvl authentication" }],
    ),
  },
  {
    id: "dev-neg-01",
    utterance: 'Tell Rivvl authentication to use the "token refresh" path, not the cookie path.',
    action: "steer",
    family: "negation-constraint",
    split: "dev",
    expectedTask: "Rivvl authentication",
    expectedInstruction:
      'Tell Rivvl authentication to use the "token refresh" path, not the cookie path.',
    instructionContains: ["token refresh", "not the cookie"],
    expectedCommand: "continue",
    expectedAck: null,
    fixtureProposal: proposal(
      "steer",
      'Tell Rivvl authentication to use the "token refresh" path, not the cookie path.',
      [{ role: "task", text: "Rivvl authentication" }],
    ),
  },
  {
    id: "dev-compound-01",
    utterance: "Fix auth then add release notes.",
    action: "unsupported",
    family: "compound-multi",
    split: "dev",
    expectClarification: true,
    expectedClarificationReason: "unsupported-command",
    fixtureProposal: proposal("unsupported", "Fix auth then add release notes."),
  },
  {
    id: "dev-ambiguity-01",
    utterance: "What's the status of the billing migration?",
    action: "status",
    family: "ambiguity-clarification",
    split: "dev",
    expectedTask: "billing migration",
    expectClarification: true,
    expectedClarificationReason: "control-target-required",
    fixtureProposal: proposal("status", "What's the status of the billing migration?", [
      { role: "task", text: "billing migration" },
    ]),
  },
  {
    id: "dev-exclusion-01",
    utterance: "Check auth but not in Jarvis",
    action: "start",
    family: "safety-exclusion",
    split: "dev",
    excludedProject: "Jarvis",
    expectClarification: true,
    expectedClarificationReason: "control-target-required",
    fixtureProposal: proposal("start", "Check auth but not in Jarvis", [
      { role: "excluded", text: "Jarvis" },
    ]),
  },
  {
    id: "dev-crossnode-01",
    utterance: "In VPS, create a health check.",
    action: "start",
    family: "safety-cross-node",
    split: "dev",
    expectedProject: "VPS",
    expectedInstruction: "create a health check.",
    expectedCommand: "start",
    expectedAck: "Request accepted for VPS.",
    fixtureProposal: proposal("start", "In VPS, create a health check.", [
      { role: "destination", text: "In VPS,", value: "VPS" },
    ]),
  },
  {
    id: "dev-stale-01",
    utterance: "Yes, allow it.",
    action: "continue",
    family: "safety-stale",
    split: "dev",
    expectedInstruction: "Yes, allow it.",
    expectedCommand: "answer",
    expectedAck: null,
    context: { pendingApproval: true, continueContext: true },
    fixtureProposal: proposal("continue", "Yes, allow it."),
  },
  {
    id: "dev-asr-01",
    utterance: "Switch to the Rivvil project.",
    action: "focus-project",
    family: "correction-asr-alias",
    split: "dev",
    expectedProject: "Rivvl",
    expectClarification: true,
    expectedClarificationReason: "control-target-required",
    fixtureProposal: proposal("focus-project", "Switch to the Rivvil project.", [
      { role: "destination", text: "Rivvil", value: "Rivvl" },
    ]),
  },
  {
    id: "dev-converse-01",
    utterance: "What is new today?",
    action: "converse",
    family: "converse-general",
    split: "dev",
    expectedInstruction: "What is new today?",
    expectedCommand: "converse",
    expectedAck: null,
    fixtureProposal: proposal("converse", "What is new today?", [], {
      answer: "Nothing new: no provider runs are active.",
    }),
  },
];
