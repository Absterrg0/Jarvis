export type HostFetch = (
  input: string,
  init: {
    readonly method: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body?: string;
    readonly credentials: "include";
  },
) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  readonly json: () => Promise<unknown>;
}>;

/** The compact selection stored locally by a paired companion. */
export type CompanionModelSelection = {
  readonly instanceId: string;
  readonly model: string;
  readonly options?: ReadonlyArray<{ readonly id: string; readonly value: string | boolean }>;
};

export type CompanionProviderCatalog =
  | { readonly kind: "ready"; readonly providers: ReadonlyArray<unknown> }
  | { readonly kind: "error"; readonly message: string; readonly needsPairing: boolean };

export type HostJarvisResult =
  | {
      readonly kind: "started";
      readonly projectId: string;
      readonly threadId: string;
      readonly objective: string;
    }
  | {
      readonly kind: "needs-input";
      readonly projectId: string;
      readonly reason: string;
      readonly prompt: string;
    }
  | { readonly kind: "error"; readonly message: string; readonly needsPairing: boolean };

function pairingCredential(url: URL): string | null {
  const value =
    url.searchParams.get("token") ?? new URLSearchParams(url.hash.slice(1)).get("token");
  return value?.trim() || null;
}

function hostForPairingUrl(url: URL): string {
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function endpoint(host: string, pathname: string): string {
  return new URL(pathname, host).toString();
}

async function responseError(response: {
  readonly json: () => Promise<unknown>;
}): Promise<{ readonly message: string; readonly reason?: string }> {
  try {
    const body: unknown = await response.json();
    const reason =
      typeof body === "object" &&
      body !== null &&
      "reason" in body &&
      typeof body.reason === "string"
        ? body.reason
        : undefined;
    if (
      typeof body === "object" &&
      body !== null &&
      "message" in body &&
      typeof body.message === "string" &&
      body.message.trim().length > 0
    ) {
      return { message: body.message.trim(), ...(reason === undefined ? {} : { reason }) };
    }
    return {
      message: "Jarvis Host could not complete that request.",
      ...(reason === undefined ? {} : { reason }),
    };
  } catch {
    // The environment may return an empty response through a transient proxy.
  }
  return { message: "Jarvis Host could not complete that request." };
}

/** Reads the live provider snapshot available to this paired companion. */
export async function getCompanionProviderCatalog(input: {
  readonly fetch: HostFetch;
  readonly host: string;
}): Promise<CompanionProviderCatalog> {
  try {
    const response = await input.fetch(
      endpoint(input.host, "/api/orchestration/jarvis/providers"),
      {
        method: "GET",
        headers: {},
        credentials: "include",
      },
    );
    if (!response.ok) {
      return {
        kind: "error",
        needsPairing: response.status === 401 || response.status === 403,
        message:
          response.status === 401
            ? "This companion needs a fresh pairing link from Jarvis Host."
            : response.status === 403
              ? "This pairing is missing permission to read available providers. Create a new pairing link on Jarvis Host."
              : (await responseError(response)).message,
      };
    }
    const body: unknown = await response.json();
    if (!Array.isArray(body)) {
      return {
        kind: "error",
        needsPairing: false,
        message: "Jarvis Host returned an unexpected provider catalog.",
      };
    }
    return { kind: "ready", providers: body };
  } catch (cause) {
    return {
      kind: "error",
      needsPairing: false,
      message: cause instanceof Error ? cause.message : "Jarvis Host could not be reached.",
    };
  }
}

/** Exchanges a one-time pairing credential for the persistent session cookie. */
export async function pairCompanionHost(input: {
  readonly fetch: HostFetch;
  readonly pairingUrl: string;
}): Promise<
  { readonly ok: true; readonly host: string } | { readonly ok: false; readonly message: string }
> {
  let url: URL;
  try {
    url = new URL(input.pairingUrl);
  } catch {
    return { ok: false, message: "That is not a valid Jarvis pairing link." };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, message: "That pairing link must use HTTP or HTTPS." };
  }
  const credential = pairingCredential(url);
  if (credential === null) return { ok: false, message: "That pairing link has no pairing token." };

  const host = hostForPairingUrl(url);
  try {
    const response = await input.fetch(endpoint(host, "/api/auth/browser-session"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ credential }),
      credentials: "include",
    });
    if (!response.ok) {
      return {
        ok: false,
        message:
          response.status === 401
            ? "That pairing link has expired or was already used. Create a new one on Jarvis Host."
            : (await responseError(response)).message,
      };
    }
    return { ok: true, host };
  } catch (cause) {
    return {
      ok: false,
      message: cause instanceof Error ? cause.message : "Jarvis Host could not be reached.",
    };
  }
}

/** Sends a recorded task straight to Jarvis Host, without routing through its UI. */
export async function submitCompanionTask(input: {
  readonly fetch: HostFetch;
  readonly host: string;
  readonly utterance: string;
  readonly projectId?: string;
  readonly contextThreadId?: string;
  readonly modelSelection?: CompanionModelSelection;
}): Promise<HostJarvisResult> {
  try {
    const response = await input.fetch(endpoint(input.host, "/api/orchestration/jarvis"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        utterance: input.utterance,
        ...(input.modelSelection === undefined ? {} : { modelSelection: input.modelSelection }),
        ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
        ...(input.contextThreadId === undefined ? {} : { contextThreadId: input.contextThreadId }),
      }),
      credentials: "include",
    });
    if (!response.ok) {
      const error = await responseError(response);
      return {
        kind: "error",
        needsPairing: response.status === 401,
        message:
          response.status === 401
            ? "This companion needs a fresh pairing link from Jarvis Host."
            : response.status === 403
              ? "This pairing is missing task-control permission. Create a new pairing link on Jarvis Host."
              : response.status === 404 && error.reason === "project_not_found"
                ? "No active project exists on Jarvis Host yet. Open or create a project on the laptop, then try again."
                : response.status === 404
                  ? "Jarvis Host needs the matching direct-task update before it can start voice tasks."
                  : error.message,
      };
    }
    const body: unknown = await response.json();
    if (
      typeof body !== "object" ||
      body === null ||
      !("projectId" in body) ||
      !("result" in body)
    ) {
      return {
        kind: "error",
        needsPairing: false,
        message: "Jarvis Host returned an unexpected task response.",
      };
    }
    const projectId = body.projectId;
    const result = body.result;
    if (typeof projectId !== "string" || typeof result !== "object" || result === null) {
      return {
        kind: "error",
        needsPairing: false,
        message: "Jarvis Host returned an unexpected task response.",
      };
    }
    if (
      "status" in result &&
      result.status === "started" &&
      "threadId" in result &&
      "objective" in result &&
      typeof result.threadId === "string" &&
      typeof result.objective === "string"
    ) {
      return { kind: "started", projectId, threadId: result.threadId, objective: result.objective };
    }
    if (
      "status" in result &&
      result.status === "needs-input" &&
      "reason" in result &&
      typeof result.reason === "string" &&
      "prompt" in result &&
      typeof result.prompt === "string"
    ) {
      return { kind: "needs-input", projectId, reason: result.reason, prompt: result.prompt };
    }
    return {
      kind: "error",
      needsPairing: false,
      message: "Jarvis Host returned an unexpected task response.",
    };
  } catch (cause) {
    return {
      kind: "error",
      needsPairing: false,
      message: cause instanceof Error ? cause.message : "Jarvis Host could not be reached.",
    };
  }
}
