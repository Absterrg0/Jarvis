import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  appendJarvisChoice,
  applyJarvisClarificationChoice,
  isJarvisShortcut,
  jarvisRequestFingerprint,
  jarvisErrorMessage,
  jarvisTaskStartedText,
  resolveJarvisRequestId,
} from "./JarvisManager.logic";

describe("Jarvis manager controls", () => {
  it("opens only for the exact non-repeating Cmd/Ctrl+Shift+J shortcut", () => {
    expect(
      isJarvisShortcut({
        key: "J",
        metaKey: true,
        ctrlKey: false,
        shiftKey: true,
        altKey: false,
      }),
    ).toBe(true);
    expect(
      isJarvisShortcut({
        key: "j",
        metaKey: false,
        ctrlKey: true,
        shiftKey: true,
        altKey: false,
      }),
    ).toBe(true);
    expect(
      isJarvisShortcut({
        key: "j",
        metaKey: false,
        ctrlKey: true,
        shiftKey: false,
        altKey: false,
      }),
    ).toBe(false);
    expect(
      isJarvisShortcut({
        key: "j",
        metaKey: true,
        ctrlKey: false,
        shiftKey: true,
        altKey: false,
        repeat: true,
      }),
    ).toBe(false);
  });

  it("adds a clarification choice without discarding the original instruction", () => {
    expect(appendJarvisChoice("Review this change", "Codex")).toBe("Review this change\nCodex");
    expect(appendJarvisChoice("", "Codex")).toBe("Codex");
  });

  it("reuses request ids only for the same utterance and selected target", () => {
    const base = {
      utterance: "Review the current changes.",
      projectRef: { nodeId: EnvironmentId.make("desktop"), projectId: ProjectId.make("rivvl") },
      referenceThreadId: "thread-1",
    };
    const fingerprint = jarvisRequestFingerprint(base);
    const createRequestId = vi.fn(() => "request-2");

    expect(
      resolveJarvisRequestId({
        currentRequestId: "request-1",
        currentFingerprint: fingerprint,
        nextFingerprint: fingerprint,
        createRequestId,
      }),
    ).toBe("request-1");
    expect(
      resolveJarvisRequestId({
        currentRequestId: "request-1",
        currentFingerprint: fingerprint,
        nextFingerprint: jarvisRequestFingerprint({
          ...base,
          utterance: "Review the tests too.",
        }),
        createRequestId,
      }),
    ).toBe("request-2");
    expect(
      resolveJarvisRequestId({
        currentRequestId: "request-1",
        currentFingerprint: fingerprint,
        nextFingerprint: jarvisRequestFingerprint({
          ...base,
          projectRef: {
            nodeId: EnvironmentId.make("laptop"),
            projectId: ProjectId.make("rivvl"),
          },
        }),
        createRequestId,
      }),
    ).toBe("request-2");
    expect(createRequestId).toHaveBeenCalledTimes(2);
  });

  it("replaces the invalid selection while preserving the objective", () => {
    expect(
      applyJarvisClarificationChoice(
        "Jarvis, use ImpossibleProvider to implement presence.",
        {
          status: "needs-input",
          reason: "provider-not-found",
          prompt: "Choose a provider.",
          choices: ["codex"],
        },
        "codex",
      ),
    ).toBe("Jarvis, use codex to implement presence.");
    expect(
      applyJarvisClarificationChoice(
        "Use Codex Unknown high to implement presence.",
        {
          status: "needs-input",
          reason: "model-unavailable",
          prompt: "Choose a model.",
          choices: ["gpt-5.6-sol"],
        },
        "gpt-5.6-sol",
      ),
    ).toBe("Use Codex gpt-5.6-sol high to implement presence.");
    expect(
      applyJarvisClarificationChoice(
        "Use Codex to implement presence.",
        {
          status: "needs-input",
          reason: "model-unavailable",
          prompt: "Choose a model.",
          choices: ["gpt-5.6-sol"],
        },
        "gpt-5.6-sol",
      ),
    ).toBe("Use Codex gpt-5.6-sol to implement presence.");
  });

  it("keeps server errors useful and provides a concise fallback", () => {
    expect(jarvisErrorMessage({ message: "Provider is unavailable." })).toBe(
      "Provider is unavailable.",
    );
    expect(jarvisErrorMessage(null)).toBe(
      "T3 couldn’t start that task. Check the connection and try again.",
    );
  });

  it("confirms the selected provider, model, and effort before hiding Companion", () => {
    expect(
      jarvisTaskStartedText({
        instanceId: "codex",
        model: "sol",
        options: [{ id: "reasoningEffort", value: "high" }],
      }),
    ).toBe("Starting codex sol at high effort.");
  });
});
