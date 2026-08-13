export type HostFetch = (
  input: string,
  init: {
    readonly method: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body?: string;
    readonly credentials: "include";
    readonly signal?: AbortSignal;
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

export type CompanionProjectTarget = {
  readonly id: string;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly repositoryNames?: ReadonlyArray<string>;
  readonly aliases?: ReadonlyArray<string>;
  readonly aliasDetails?: ReadonlyArray<{
    readonly alias: string;
    readonly kind: "confirmed-pronunciation" | "user-defined";
  }>;
};

export type CompanionProjectCatalog =
  | { readonly kind: "ready"; readonly projects: ReadonlyArray<CompanionProjectTarget> }
  | { readonly kind: "error"; readonly message: string; readonly needsPairing: boolean };

export async function manageCompanionProjectAlias(input: {
  readonly fetch: HostFetch;
  readonly host: string;
  readonly projectId: string;
  readonly alias: string;
  readonly action?: "set" | "remove";
}): Promise<boolean> {
  const action = input.action ?? "set";
  const response = await input.fetch(
    endpoint(input.host, "/api/orchestration/jarvis/project-aliases"),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action,
        projectId: input.projectId,
        alias: input.alias,
        ...(action === "set" ? { kind: "confirmed-pronunciation" } : {}),
      }),
      credentials: "include",
    },
  );
  if (!response.ok) return false;
  const body: unknown = await response.json();
  return typeof body === "object" && body !== null && "changed" in body && body.changed === true;
}

export type HostJarvisResult =
  | {
      readonly kind: "started";
      readonly projectId: string;
      readonly threadId: string;
      readonly objective: string;
    }
  | {
      readonly kind: "acknowledged";
      readonly projectId?: string;
      readonly threadId?: string;
      readonly action:
        | "steered"
        | "queued"
        | "interrupted"
        | "status"
        | "focused"
        | "projects-listed";
      readonly message: string;
    }
  | {
      readonly kind: "needs-input";
      readonly projectId: string;
      readonly reason: string;
      readonly prompt: string;
    }
  | {
      readonly kind: "error";
      readonly message: string;
      readonly needsPairing: boolean;
      readonly reason?: string;
    };

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

/**
 * T3's browser client wraps a host pairing link so it can select the target
 * environment before it exchanges the hash token. Companion can safely
 * consume that canonical wrapper directly instead of asking people to
 * reconstruct a host URL by hand.
 */
function pairingTarget(url: URL): { readonly host: string; readonly credential: string } | null {
  const credential = pairingCredential(url);
  if (credential === null) return null;

  if (url.pathname.replace(/\/+$/u, "") === "/pair") {
    if (url.origin === "https://app.t3.codes") {
      const encodedHost = url.searchParams.get("host");
      if (encodedHost === null) return null;
      try {
        const host = new URL(encodedHost);
        if (host.protocol !== "http:" && host.protocol !== "https:") return null;
        return { host: hostForPairingUrl(host), credential };
      } catch {
        return null;
      }
    }
    return { host: hostForPairingUrl(url), credential };
  }
  return null;
}

function endpoint(host: string, pathname: string): string {
  return new URL(pathname, host).toString();
}

function catalogFailureMessage(cause: unknown, subject: string): string {
  if (cause instanceof Error && cause.name === "TimeoutError") {
    return `Jarvis Host took too long to return ${subject}.`;
  }
  return cause instanceof Error ? cause.message : "Jarvis Host could not be reached.";
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
  readonly timeoutMs?: number;
}): Promise<CompanionProviderCatalog> {
  try {
    const response = await input.fetch(
      endpoint(input.host, "/api/orchestration/jarvis/providers"),
      {
        method: "GET",
        headers: {},
        credentials: "include",
        signal: AbortSignal.timeout(input.timeoutMs ?? 8_000),
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
      message: catalogFailureMessage(cause, "available providers"),
    };
  }
}

/** Reads stable project ids and human-readable paths for explicit companion routing. */
export async function getCompanionProjectCatalog(input: {
  readonly fetch: HostFetch;
  readonly host: string;
  readonly timeoutMs?: number;
}): Promise<CompanionProjectCatalog> {
  try {
    let response = await input.fetch(endpoint(input.host, "/api/orchestration/jarvis/vocabulary"), {
      method: "GET",
      headers: {},
      credentials: "include",
      signal: AbortSignal.timeout(input.timeoutMs ?? 8_000),
    });
    if (response.status === 404) {
      // A Companion may update before its remote Host. Keep project routing
      // available during that rolling upgrade; aliases appear once Host updates.
      response = await input.fetch(endpoint(input.host, "/api/orchestration/snapshot"), {
        method: "GET",
        headers: {},
        credentials: "include",
        signal: AbortSignal.timeout(input.timeoutMs ?? 8_000),
      });
    }
    if (!response.ok) {
      return {
        kind: "error",
        needsPairing: response.status === 401 || response.status === 403,
        message:
          response.status === 401 || response.status === 403
            ? "This companion needs a fresh pairing link before it can read projects."
            : (await responseError(response)).message,
      };
    }
    const body: unknown = await response.json();
    const rawProjects = Array.isArray(body)
      ? body
      : typeof body === "object" &&
          body !== null &&
          "projects" in body &&
          Array.isArray(body.projects)
        ? body.projects
        : undefined;
    if (rawProjects === undefined) {
      return {
        kind: "error",
        needsPairing: false,
        message: "Jarvis Host returned an unexpected project catalog.",
      };
    }
    const projects = rawProjects.flatMap((project): ReadonlyArray<CompanionProjectTarget> => {
      if (typeof project !== "object" || project === null) return [];
      const candidate = project as Record<string, unknown>;
      if (
        (typeof candidate.projectId !== "string" && typeof candidate.id !== "string") ||
        typeof candidate.title !== "string" ||
        candidate.title.trim().length === 0 ||
        typeof candidate.workspaceRoot !== "string" ||
        candidate.workspaceRoot.trim().length === 0
      ) {
        return [];
      }
      return [
        {
          id: (typeof candidate.projectId === "string"
            ? candidate.projectId
            : (candidate.id as string)
          ).trim(),
          title: candidate.title.trim(),
          workspaceRoot: candidate.workspaceRoot.trim(),
          repositoryNames: Array.isArray(candidate.repositoryNames)
            ? candidate.repositoryNames.filter(
                (name): name is string => typeof name === "string" && name.trim().length > 0,
              )
            : [],
          aliases: Array.isArray(candidate.aliases)
            ? candidate.aliases.filter(
                (alias): alias is string => typeof alias === "string" && alias.trim().length > 0,
              )
            : [],
          aliasDetails: Array.isArray(candidate.aliasDetails)
            ? candidate.aliasDetails.flatMap((detail) => {
                if (typeof detail !== "object" || detail === null) return [];
                const value = detail as Record<string, unknown>;
                return typeof value.alias === "string" &&
                  (value.kind === "confirmed-pronunciation" || value.kind === "user-defined")
                  ? [{ alias: value.alias, kind: value.kind }]
                  : [];
              })
            : [],
        },
      ];
    });
    if (projects.length !== rawProjects.length) {
      return {
        kind: "error",
        needsPairing: false,
        message: "Jarvis Host returned an unexpected project catalog.",
      };
    }
    return { kind: "ready", projects };
  } catch (cause) {
    return {
      kind: "error",
      needsPairing: false,
      message: catalogFailureMessage(cause, "projects"),
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
  const target = pairingTarget(url);
  if (target === null) {
    return {
      ok: false,
      message: "That pairing link must include a host and one-time token.",
    };
  }
  try {
    const response = await input.fetch(endpoint(target.host, "/api/auth/browser-session"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ credential: target.credential }),
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
    return { ok: true, host: target.host };
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
  readonly referenceThreadId?: string;
  readonly continueContext?: boolean;
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
        ...(input.referenceThreadId === undefined
          ? {}
          : { referenceThreadId: input.referenceThreadId }),
        ...(input.continueContext === undefined ? {} : { continueContext: input.continueContext }),
      }),
      credentials: "include",
    });
    if (!response.ok) {
      const error = await responseError(response);
      return {
        kind: "error",
        needsPairing: response.status === 401,
        ...(error.reason === undefined ? {} : { reason: error.reason }),
        message:
          response.status === 401
            ? "This companion needs a fresh pairing link from Jarvis Host."
            : response.status === 403
              ? "This pairing is missing task-control permission. Create a new pairing link on Jarvis Host."
              : response.status === 404 && error.reason === "project_not_found"
                ? "No active project exists on Jarvis Host yet. Open or create a project on the laptop, then try again."
                : response.status === 404 && error.reason === "project_required"
                  ? "Choose the project for new tasks in Jarvis Companion before trying again."
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
      result.status === "acknowledged" &&
      "action" in result &&
      typeof result.action === "string" &&
      ["steered", "queued", "interrupted", "status", "focused", "projects-listed"].includes(
        result.action,
      ) &&
      "message" in result &&
      typeof result.message === "string"
    ) {
      const threadId =
        "threadId" in result && typeof result.threadId === "string" ? result.threadId : undefined;
      const acknowledgedProjectId =
        "projectId" in result && typeof result.projectId === "string"
          ? result.projectId
          : projectId;
      return {
        kind: "acknowledged",
        action: result.action as
          | "steered"
          | "queued"
          | "interrupted"
          | "status"
          | "focused"
          | "projects-listed",
        message: result.message,
        ...(result.action === "projects-listed" ? {} : { projectId: acknowledgedProjectId }),
        ...(threadId === undefined ? {} : { threadId }),
      };
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
