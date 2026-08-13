import {
  JarvisSpeakerClaimInput,
  MessageId,
  ProjectId,
  ThreadId,
  type JarvisVoiceReport,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  companionReportStatus,
  speakerPriority,
  spokenReportText,
} from "./JarvisVoiceReporter.logic";

const report: JarvisVoiceReport = {
  reportId: MessageId.make("message-1"),
  projectId: ProjectId.make("project-1"),
  threadId: ThreadId.make("thread-1"),
  kind: "completed",
  threadTitle: "Build the relay",
  providerName: "Codex",
  text: "Implemented **voice**.\n```ts\nsecret();\n```",
  createdAt: "2026-08-12T00:00:00.000Z",
};

describe("Jarvis voice reporting", () => {
  it("speaks actual lifecycle content without repeating the task as a robotic title", () => {
    expect(spokenReportText(report)).toBe(
      "All set. Implemented voice . Code changes are included in the written output.",
    );
    expect(
      spokenReportText({ ...report, kind: "waiting-for-input", text: "Which database?" }),
    ).toBe("I need one quick detail. Which database?");
    expect(spokenReportText({ ...report, kind: "approval-needed", text: "Run tests" })).toBe(
      "Quick check before I continue. Run tests",
    );
    expect(spokenReportText({ ...report, kind: "failed", text: "Disconnected" })).toBe(
      "I hit a snag. Disconnected",
    );
  });

  it("presents an actionable companion state for answers, questions, approvals, and failures", () => {
    expect(companionReportStatus(report)).toEqual({
      state: "All set",
      detail: "Implemented voice . Code changes are included in the written output.",
      kind: "started",
    });
    expect(
      companionReportStatus({ ...report, kind: "waiting-for-input", text: "Which database?" }),
    ).toEqual({ state: "I need your input", detail: "Which database?", kind: "review" });
    expect(
      companionReportStatus({ ...report, kind: "approval-needed", text: "Run tests" }),
    ).toEqual({ state: "One quick approval", detail: "Run tests", kind: "review" });
    expect(companionReportStatus({ ...report, kind: "failed", text: "Disconnected" })).toEqual({
      state: "I hit a snag",
      detail: "Disconnected",
      kind: "error",
    });
  });

  it("always elects the paired report relay before every other surface", () => {
    expect(speakerPriority({ relay: true, preferred: true, mobile: false, electron: true })).toBe(
      200,
    );
    expect(speakerPriority({ preferred: true, mobile: true, electron: false })).toBe(100);
    expect(speakerPriority({ preferred: false, mobile: false, electron: true })).toBe(75);
    expect(speakerPriority({ preferred: false, mobile: false, electron: false })).toBe(60);
    expect(speakerPriority({ preferred: false, mobile: true, electron: false })).toBe(40);
  });

  it("sends the relay priority through the typed speaker-claim boundary", () => {
    const priority = speakerPriority({
      relay: true,
      preferred: false,
      mobile: false,
      electron: true,
    });

    expect(() =>
      Schema.decodeUnknownSync(JarvisSpeakerClaimInput)({
        reportId: "report-1",
        deviceId: "companion-1",
        priority,
      }),
    ).not.toThrow();
  });
});
