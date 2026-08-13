import { MessageId, ProjectId, ThreadId, type JarvisVoiceReport } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { speakerPriority, spokenReportText } from "./JarvisVoiceReporter.logic";

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
  it("describes each lifecycle state and omits code blocks", () => {
    expect(spokenReportText(report)).toBe(
      "Codex completed Build the relay. Implemented voice . Code changes are included in the written output.",
    );
    expect(
      spokenReportText({ ...report, kind: "waiting-for-input", text: "Which database?" }),
    ).toBe("Codex needs your input for Build the relay. Which database?");
    expect(spokenReportText({ ...report, kind: "approval-needed", text: "Run tests" })).toBe(
      "Codex needs approval for Build the relay. Run tests",
    );
    expect(spokenReportText({ ...report, kind: "failed", text: "Disconnected" })).toBe(
      "Codex failed on Build the relay. Disconnected",
    );
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
});
