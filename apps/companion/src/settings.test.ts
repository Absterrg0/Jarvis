import { assert, describe, it } from "@effect/vitest";

import {
  parseCompanionSettings,
  withoutCompanionDefault,
  withCompanionDefault,
  withCompanionHost,
} from "./settings.ts";

describe("companion settings", () => {
  it("keeps existing host-only settings readable", () => {
    assert.deepEqual(parseCompanionSettings({ host: "https://jarvis-host.tailnet.ts.net/" }), {
      host: "https://jarvis-host.tailnet.ts.net/",
    });
  });

  it("persists an explicit project target independently of the visible T3 project", () => {
    assert.deepEqual(
      parseCompanionSettings({
        host: "https://jarvis-host.tailnet.ts.net/",
        projectTarget: {
          id: "project-jarvis",
          title: "Jarvis",
          workspaceRoot: "/work/Jarvis",
        },
      }),
      {
        host: "https://jarvis-host.tailnet.ts.net/",
        projectTarget: {
          id: "project-jarvis",
          title: "Jarvis",
          workspaceRoot: "/work/Jarvis",
        },
      },
    );
  });

  it("retains defaults only when the companion stays paired to that host", () => {
    const configured = withCompanionDefault(
      { host: "https://jarvis-host.tailnet.ts.net/" },
      { instanceId: "codex", model: "gpt-5.6-sol" },
    );
    assert.deepEqual(withCompanionHost(configured, "https://another-host.tailnet.ts.net/"), {
      host: "https://another-host.tailnet.ts.net/",
    });
    assert.deepEqual(
      withCompanionHost(configured, "https://jarvis-host.tailnet.ts.net/"),
      configured,
    );
  });

  it("does not persist malformed selection values from the renderer", () => {
    assert.deepEqual(
      parseCompanionSettings({
        host: "https://jarvis-host.tailnet.ts.net/",
        defaultModelSelection: { instanceId: "codex", model: "gpt-5.6-sol", options: [{}] },
      }),
      { host: "https://jarvis-host.tailnet.ts.net/" },
    );
  });

  it("can clear a stale default without dropping the host pairing", () => {
    assert.deepEqual(
      withoutCompanionDefault({
        host: "https://jarvis-host.tailnet.ts.net/",
        defaultModelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
      }),
      { host: "https://jarvis-host.tailnet.ts.net/" },
    );
  });

  it("defaults to a fresh thread while preserving an explicit continue preference", () => {
    assert.deepEqual(
      parseCompanionSettings({
        host: "https://jarvis-host.tailnet.ts.net/",
        conversationMode: "continue-last-thread",
      }),
      {
        host: "https://jarvis-host.tailnet.ts.net/",
        conversationMode: "continue-last-thread",
      },
    );
    assert.deepEqual(
      parseCompanionSettings({
        host: "https://jarvis-host.tailnet.ts.net/",
        conversationMode: "anything-else",
      }),
      { host: "https://jarvis-host.tailnet.ts.net/" },
    );
  });

  it("restores the exact last task reference for safe controls after restart", () => {
    assert.deepEqual(
      parseCompanionSettings({
        host: "https://jarvis-host.tailnet.ts.net/",
        attentionTarget: {
          projectId: "project-1",
          threadId: "thread-1",
          reportKind: "approval-needed",
        },
      }).attentionTarget,
      { projectId: "project-1", threadId: "thread-1", reportKind: "approval-needed" },
    );
  });

  it("restores a pending project confirmation only for the same Host", () => {
    const pending = parseCompanionSettings({
      host: "https://jarvis-host.tailnet.ts.net/",
      pendingProjectTask: {
        transcript: "Check the PR in ripple",
        heardAlias: "ripple",
        projects: [{ id: "project-rivvl", title: "Rivvl", workspaceRoot: "/work/rivvl" }],
      },
    });
    assert.equal(pending.pendingProjectTask?.transcript, "Check the PR in ripple");
    assert.equal(pending.pendingProjectTask?.heardAlias, "ripple");
    assert.deepEqual(withCompanionHost(pending, "https://jarvis-host.tailnet.ts.net/"), pending);
    assert.deepEqual(withCompanionHost(pending, "https://other.tailnet.ts.net/"), {
      host: "https://other.tailnet.ts.net/",
    });
  });
});
