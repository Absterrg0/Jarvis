import { assert, describe, it } from "@effect/vitest";

import { pairCompanionHost, submitCompanionTask, type HostFetch } from "./host.ts";

function response(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

describe("Jarvis Host companion API", () => {
  it("exchanges a hash pairing token through the host auth endpoint", async () => {
    const requests: Array<{ readonly url: string; readonly body: string }> = [];
    const fetch: HostFetch = async (url, init) => {
      requests.push({ url, body: init.body });
      return response({});
    };

    assert.deepEqual(
      await pairCompanionHost({
        fetch,
        pairingUrl: "http://100.78.179.56:3773/pair#token=one-time-token",
      }),
      { ok: true, host: "http://100.78.179.56:3773/" },
    );
    assert.deepEqual(requests, [
      {
        url: "http://100.78.179.56:3773/api/auth/browser-session",
        body: JSON.stringify({ credential: "one-time-token" }),
      },
    ]);
  });

  it("sends a transcript directly to the authenticated Jarvis endpoint", async () => {
    const requests: Array<{ readonly url: string; readonly body: string }> = [];
    const fetch: HostFetch = async (url, init) => {
      requests.push({ url, body: init.body });
      return response({
        projectId: "project-1",
        result: {
          status: "started",
          threadId: "thread-1",
          objective: "Review the current implementation",
        },
      });
    };

    assert.deepEqual(
      await submitCompanionTask({
        fetch,
        host: "http://jarvis-host:3773/",
        utterance: "Review the current implementation",
      }),
      {
        kind: "started",
        projectId: "project-1",
        threadId: "thread-1",
        objective: "Review the current implementation",
      },
    );
    assert.deepEqual(requests, [
      {
        url: "http://jarvis-host:3773/api/orchestration/jarvis",
        body: JSON.stringify({ utterance: "Review the current implementation" }),
      },
    ]);
  });

  it("makes an expired session actionable instead of pretending the host received a task", async () => {
    const fetch: HostFetch = async () => response({ code: "auth_invalid" }, 401);

    assert.deepEqual(
      await submitCompanionTask({
        fetch,
        host: "http://jarvis-host:3773/",
        utterance: "Review the current implementation",
      }),
      {
        kind: "error",
        needsPairing: true,
        message: "This companion needs a fresh pairing link from Jarvis Host.",
      },
    );
  });

  it("carries a spoken follow-up back to the exact reported thread", async () => {
    const requests: Array<{ readonly body: string }> = [];
    const fetch: HostFetch = async (_url, init) => {
      requests.push({ body: init.body });
      return response({
        projectId: "project-1",
        result: {
          status: "started",
          threadId: "thread-1",
          objective: "Continue",
        },
      });
    };

    await submitCompanionTask({
      fetch,
      host: "http://jarvis-host:3773/",
      utterance: "Continue",
      projectId: "project-1",
      contextThreadId: "thread-1",
    });

    assert.deepEqual(requests, [
      {
        body: JSON.stringify({
          utterance: "Continue",
          projectId: "project-1",
          contextThreadId: "thread-1",
        }),
      },
    ]);
  });

  it("explains when the laptop is running an older Jarvis Host", async () => {
    const fetch: HostFetch = async () => response({}, 404);

    assert.deepEqual(
      await submitCompanionTask({
        fetch,
        host: "http://jarvis-host:3773/",
        utterance: "Review the current implementation",
      }),
      {
        kind: "error",
        needsPairing: false,
        message:
          "Jarvis Host needs the matching direct-task update before it can start voice tasks.",
      },
    );
  });

  it("distinguishes an empty host from a host missing the direct-task route", async () => {
    const fetch: HostFetch = async () =>
      response({ code: "not_found", reason: "project_not_found" }, 404);

    assert.deepEqual(
      await submitCompanionTask({
        fetch,
        host: "http://jarvis-host:3773/",
        utterance: "Use Codex Sol high to review the implementation.",
      }),
      {
        kind: "error",
        needsPairing: false,
        message:
          "No active project exists on Jarvis Host yet. Open or create a project on the laptop, then try again.",
      },
    );
  });
});
