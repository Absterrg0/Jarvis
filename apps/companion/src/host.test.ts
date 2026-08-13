import { assert, describe, it } from "@effect/vitest";

import {
  getCompanionProjectCatalog,
  manageCompanionProjectAlias,
  getCompanionProviderCatalog,
  pairCompanionHost,
  submitCompanionTask,
  type HostFetch,
} from "./host.ts";

function response(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

describe("Jarvis Host companion API", () => {
  it("persists a pronunciation only through the explicit alias mutation", async () => {
    const requests: Array<{ readonly url: string; readonly body: string }> = [];
    const fetch: HostFetch = async (url, init) => {
      requests.push({ url, body: init.body ?? "" });
      return response({ changed: true });
    };
    assert.isTrue(
      await manageCompanionProjectAlias({
        fetch,
        host: "http://jarvis-host:3773/",
        projectId: "project-rivvl",
        alias: "ripple",
      }),
    );
    assert.deepEqual(requests, [
      {
        url: "http://jarvis-host:3773/api/orchestration/jarvis/project-aliases",
        body: JSON.stringify({
          action: "set",
          projectId: "project-rivvl",
          alias: "ripple",
          kind: "confirmed-pronunciation",
        }),
      },
    ]);
  });
  it("times out provider discovery instead of leaving setup stuck checking forever", async () => {
    const fetch: HostFetch = async (_url, init) =>
      await new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });

    assert.deepEqual(
      await getCompanionProviderCatalog({
        fetch,
        host: "http://jarvis-host:3773/",
        timeoutMs: 1,
      }),
      {
        kind: "error",
        needsPairing: false,
        message: "Jarvis Host took too long to return available providers.",
      },
    );
  });

  it("loads explicit project targets with enough context to disambiguate them", async () => {
    const requested: string[] = [];
    const fetch: HostFetch = async (url) => {
      requested.push(url);
      return response([
        {
          projectId: "project-jarvis",
          title: "Jarvis",
          workspaceRoot: "/work/Jarvis",
          repositoryNames: ["jarvis"],
          aliases: ["jervis"],
          aliasDetails: [{ alias: "jervis", kind: "confirmed-pronunciation" }],
        },
      ]);
    };

    assert.deepEqual(
      await getCompanionProjectCatalog({ fetch, host: "http://jarvis-host:3773/" }),
      {
        kind: "ready",
        projects: [
          {
            id: "project-jarvis",
            title: "Jarvis",
            workspaceRoot: "/work/Jarvis",
            repositoryNames: ["jarvis"],
            aliases: ["jervis"],
            aliasDetails: [{ alias: "jervis", kind: "confirmed-pronunciation" }],
          },
        ],
      },
    );
    assert.deepEqual(requested, ["http://jarvis-host:3773/api/orchestration/jarvis/vocabulary"]);
  });

  it("keeps project routing available while an older Host is still updating", async () => {
    const requested: string[] = [];
    const fetch: HostFetch = async (url) => {
      requested.push(url);
      return requested.length === 1
        ? response({}, 404)
        : response({
            projects: [{ id: "project-legacy", title: "Legacy", workspaceRoot: "/work/legacy" }],
          });
    };
    assert.deepEqual(
      await getCompanionProjectCatalog({ fetch, host: "http://jarvis-host:3773/" }),
      {
        kind: "ready",
        projects: [
          {
            id: "project-legacy",
            title: "Legacy",
            workspaceRoot: "/work/legacy",
            repositoryNames: [],
            aliases: [],
            aliasDetails: [],
          },
        ],
      },
    );
    assert.deepEqual(requested, [
      "http://jarvis-host:3773/api/orchestration/jarvis/vocabulary",
      "http://jarvis-host:3773/api/orchestration/snapshot",
    ]);
  });

  it("exchanges a hash pairing token through the host auth endpoint", async () => {
    const requests: Array<{ readonly url: string; readonly body: string }> = [];
    const fetch: HostFetch = async (url, init) => {
      requests.push({ url, body: init.body ?? "" });
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

  it("accepts the official T3 pairing wrapper without sending its token to app.t3.codes", async () => {
    const requests: Array<{ readonly url: string; readonly body: string }> = [];
    const fetch: HostFetch = async (url, init) => {
      requests.push({ url, body: init.body ?? "" });
      return response({});
    };

    assert.deepEqual(
      await pairCompanionHost({
        fetch,
        pairingUrl:
          "https://app.t3.codes/pair?host=https%3A%2F%2Fjarvis-host.tailnet.ts.net%2F#token=one-time-token",
      }),
      { ok: true, host: "https://jarvis-host.tailnet.ts.net/" },
    );
    assert.deepEqual(requests, [
      {
        url: "https://jarvis-host.tailnet.ts.net/api/auth/browser-session",
        body: JSON.stringify({ credential: "one-time-token" }),
      },
    ]);
  });

  it("sends a transcript directly to the authenticated Jarvis endpoint", async () => {
    const requests: Array<{ readonly url: string; readonly body: string }> = [];
    const fetch: HostFetch = async (url, init) => {
      requests.push({ url, body: init.body ?? "" });
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

  it("returns typed Director acknowledgements and sends the exact task reference", async () => {
    const requests: Array<{ readonly body: string }> = [];
    const fetch: HostFetch = async (_url, init) => {
      requests.push({ body: init.body ?? "" });
      return response({
        projectId: "project-1",
        result: {
          status: "acknowledged",
          action: "queued",
          threadId: "thread-1",
          message: "I'll do that next: update the docs",
        },
      });
    };

    assert.deepEqual(
      await submitCompanionTask({
        fetch,
        host: "http://jarvis-host:3773/",
        utterance: "after that update the docs",
        projectId: "project-1",
        referenceThreadId: "thread-1",
      }),
      {
        kind: "acknowledged",
        projectId: "project-1",
        threadId: "thread-1",
        action: "queued",
        message: "I'll do that next: update the docs",
      },
    );
    assert.deepEqual(JSON.parse(requests[0]!.body), {
      utterance: "after that update the docs",
      projectId: "project-1",
      referenceThreadId: "thread-1",
    });
  });

  it("accepts a project-list acknowledgement without inventing a focused task", async () => {
    const fetch: HostFetch = async () =>
      response({
        projectId: "project-1",
        result: {
          status: "acknowledged",
          action: "projects-listed",
          message: "You have 2 projects: Alertify and Rivvl.",
        },
      });

    assert.deepEqual(
      await submitCompanionTask({
        fetch,
        host: "http://jarvis-host:3773/",
        utterance: "What projects are there?",
      }),
      {
        kind: "acknowledged",
        action: "projects-listed",
        message: "You have 2 projects: Alertify and Rivvl.",
      },
    );
  });

  it("sends the saved provider, model, and effort with a plain spoken task", async () => {
    const requests: Array<{ readonly url: string; readonly body?: string }> = [];
    const fetch: HostFetch = async (url, init) => {
      requests.push({ url, body: init.body ?? "" });
      return response({
        projectId: "project-1",
        result: {
          status: "started",
          threadId: "thread-1",
          objective: "Review the current implementation",
        },
      });
    };

    await submitCompanionTask({
      fetch,
      host: "https://jarvis-host.tailnet.ts.net/",
      utterance: "Review the current implementation",
      modelSelection: {
        instanceId: "codex",
        model: "gpt-5.6-sol",
        options: [{ id: "reasoningEffort", value: "high" }],
      },
    });

    assert.deepEqual(requests, [
      {
        url: "https://jarvis-host.tailnet.ts.net/api/orchestration/jarvis",
        body: JSON.stringify({
          utterance: "Review the current implementation",
          modelSelection: {
            instanceId: "codex",
            model: "gpt-5.6-sol",
            options: [{ id: "reasoningEffort", value: "high" }],
          },
        }),
      },
    ]);
  });

  it("loads the host's ready-provider catalog using the paired browser session", async () => {
    const requests: Array<{ readonly url: string; readonly method: string }> = [];
    const fetch: HostFetch = async (url, init) => {
      requests.push({ url, method: init.method });
      return response([
        {
          instanceId: "codex",
          displayName: "Codex",
          enabled: true,
          installed: true,
          status: "ready",
          auth: { status: "authenticated" },
          models: [{ slug: "gpt-5.6-sol", name: "Sol" }],
        },
      ]);
    };

    assert.deepEqual(
      await getCompanionProviderCatalog({ fetch, host: "http://jarvis-host:3773/" }),
      {
        kind: "ready",
        providers: [
          {
            instanceId: "codex",
            displayName: "Codex",
            enabled: true,
            installed: true,
            status: "ready",
            auth: { status: "authenticated" },
            models: [{ slug: "gpt-5.6-sol", name: "Sol" }],
          },
        ],
      },
    );
    assert.deepEqual(requests, [
      { url: "http://jarvis-host:3773/api/orchestration/jarvis/providers", method: "GET" },
    ]);
  });

  it("treats a catalog scope failure as recoverable re-pairing", async () => {
    const fetch: HostFetch = async () => response({ code: "scope_required" }, 403);

    assert.deepEqual(
      await getCompanionProviderCatalog({ fetch, host: "http://jarvis-host:3773/" }),
      {
        kind: "error",
        needsPairing: true,
        message:
          "This pairing is missing permission to read available providers. Create a new pairing link on Jarvis Host.",
      },
    );
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

  it("keeps a stale saved selection actionable for the defaults screen", async () => {
    const fetch: HostFetch = async () =>
      response({
        projectId: "project-1",
        result: {
          status: "needs-input",
          reason: "selection-unavailable",
          prompt: "Choose the current effort setting again in Jarvis Companion.",
        },
      });

    assert.deepEqual(
      await submitCompanionTask({
        fetch,
        host: "http://jarvis-host:3773/",
        utterance: "Review the current implementation",
        modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
      }),
      {
        kind: "needs-input",
        projectId: "project-1",
        reason: "selection-unavailable",
        prompt: "Choose the current effort setting again in Jarvis Companion.",
      },
    );
  });

  it("carries a spoken follow-up back to the exact reported thread", async () => {
    const requests: Array<{ readonly body: string }> = [];
    const fetch: HostFetch = async (_url, init) => {
      requests.push({ body: init.body ?? "" });
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
      continueContext: true,
    });

    assert.deepEqual(requests, [
      {
        body: JSON.stringify({
          utterance: "Continue",
          projectId: "project-1",
          contextThreadId: "thread-1",
          continueContext: true,
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
        reason: "project_not_found",
        message:
          "No active project exists on Jarvis Host yet. Open or create a project on the laptop, then try again.",
      },
    );
  });
});
