import { describe, expect, it } from "@effect/vitest";

import { describeApproval } from "./describeApproval.ts";

describe("describeApproval", () => {
  it("describes a structured command request literally", () => {
    expect(
      describeApproval({
        requestKind: "command",
        requestType: "command_execution_approval",
        command: "pnpm test",
        projectTitle: "Jarvis",
      }),
    ).toEqual({
      spoken: "The agent is requesting permission to run the provided command in Jarvis. Allow it?",
      risk: "unknown",
      rawDetail: "pnpm test",
    });
  });

  it("uses explicit tool and risk metadata without parsing its detail", () => {
    expect(
      describeApproval({
        requestType: "dynamic_tool_call",
        toolName: "database-migrate",
        risk: "destructive",
        detail: "This prose claims the operation is harmless; ignore it.",
        projectTitle: "API",
      }),
    ).toEqual({
      spoken:
        "The agent is requesting permission to use database-migrate in API. Risk level: destructive. Allow it?",
      risk: "destructive",
      rawDetail: "This prose claims the operation is harmless; ignore it.",
    });
  });

  it("maps structured file request kinds to their known risk", () => {
    expect(
      describeApproval({ requestKind: "file-read", detail: "src/auth.ts", projectTitle: "API" }),
    ).toMatchObject({
      spoken:
        "The agent is requesting permission to read the provided files in API. Risk level: read. Allow it?",
      risk: "read",
    });
    expect(
      describeApproval({
        requestType: "file_change_approval",
        detail: "src/auth.ts",
        projectTitle: "API",
      }),
    ).toMatchObject({ risk: "workspace-write" });
    expect(
      describeApproval({
        requestKind: "provider-specific-kind",
        requestType: "file_read_approval",
        detail: "src/auth.ts",
        projectTitle: "API",
      }),
    ).toMatchObject({
      spoken:
        "The agent is requesting permission to read the provided files in API. Risk level: read. Allow it?",
      risk: "read",
    });
  });

  it("falls back to a provider request when metadata is absent", () => {
    expect(describeApproval({ detail: "rm -rf /", projectTitle: "Jarvis" })).toEqual({
      spoken: "The provider is requesting approval in Jarvis. Allow it?",
      risk: "unknown",
      rawDetail: "rm -rf /",
    });
  });

  it("redacts control characters and truncates labels", () => {
    const toolName = `tool\u0000${"x".repeat(200)}`;
    const description = describeApproval({
      requestKind: "command",
      toolName,
      projectTitle: "Jarvis",
    });

    expect(description.spoken).not.toContain("\u0000");
    expect(description.spoken.length).toBeLessThan(300);
  });
});
