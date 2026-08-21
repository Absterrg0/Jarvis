import { assert, describe, it } from "@effect/vitest";

import {
  companionDevelopmentDiagnosticRecord,
  companionDevelopmentDispatchBlocker,
  companionDevelopmentReport,
  resolveCompanionDevelopmentLaunch,
} from "./development.ts";

describe("Companion development launch", () => {
  it("keeps development controls inert outside the explicit local development mode", () => {
    assert.deepEqual(
      resolveCompanionDevelopmentLaunch(["Jarvis Companion.exe", "--inject-text=run tests"]),
      { enabled: false },
    );
  });

  it("parses persistent local state, real-route text injection, reports, and diagnostics", () => {
    assert.deepEqual(
      resolveCompanionDevelopmentLaunch([
        "electron",
        "--jarvis-development",
        "--dev-data-dir=.jarvis-dev",
        "--diagnostics=.jarvis-dev/diagnostics.jsonl",
        "--inject-text=In Rivvl, run the tests",
        "--simulate-report=approval-needed",
      ]),
      {
        enabled: true,
        dataDir: ".jarvis-dev",
        diagnosticsPath: ".jarvis-dev/diagnostics.jsonl",
        injectText: "In Rivvl, run the tests",
        simulateReport: "approval-needed",
      },
    );
  });

  it("ignores unknown report scenarios instead of inventing a presentation", () => {
    assert.deepEqual(
      resolveCompanionDevelopmentLaunch([
        "electron",
        "--jarvis-development",
        "--simulate-report=progress",
      ]),
      { enabled: true },
    );
  });

  it("models every report kind through the ordinary overlay and speech contract", () => {
    assert.deepEqual(companionDevelopmentReport("completed"), {
      status: {
        state: "Finished — short version",
        detail:
          "I found one serious issue in the admin revocation flow. Type-checking passed, although lint could not run.",
        kind: "completed",
      },
      spoken:
        "I found one serious issue in the admin revocation flow. Type-checking passed, although lint could not run.",
    });
    assert.equal(companionDevelopmentReport("waiting-for-input").status.kind, "attention");
    assert.equal(companionDevelopmentReport("approval-needed").status.kind, "attention");
    assert.equal(companionDevelopmentReport("failed").status.kind, "error");
  });

  it("records the first real routing blocker and emits a compact inspectable trace", () => {
    assert.equal(
      companionDevelopmentDispatchBlocker({ paired: false, hasVoiceDefault: false }),
      "unpaired",
    );
    assert.equal(
      companionDevelopmentDispatchBlocker({ paired: true, hasVoiceDefault: false }),
      "missing-voice-default",
    );
    assert.isUndefined(
      companionDevelopmentDispatchBlocker({ paired: true, hasVoiceDefault: true }),
    );
    assert.equal(
      companionDevelopmentDiagnosticRecord({
        at: "2026-08-21T00:00:00.000Z",
        stage: "dispatch",
        phase: "host-result",
        detail: { kind: "started", threadId: "thread-1", ignored: undefined },
      }),
      `${JSON.stringify({
        at: "2026-08-21T00:00:00.000Z",
        stage: "dispatch",
        phase: "host-result",
        kind: "started",
        threadId: "thread-1",
      })}\n`,
    );
  });
});
