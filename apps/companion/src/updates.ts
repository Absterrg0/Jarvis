export type CompanionUpdateState =
  | { readonly status: "disabled" }
  | { readonly status: "idle" }
  | { readonly status: "checking" }
  | { readonly status: "downloading"; readonly version?: string; readonly percent?: number }
  | { readonly status: "ready"; readonly version: string }
  | { readonly status: "error"; readonly message: string };

export type CompanionUpdateEvent =
  | "checking-for-update"
  | "update-available"
  | "update-not-available"
  | "download-progress"
  | "update-downloaded"
  | "error";

export type CompanionUpdater = {
  configure(): void;
  on(event: CompanionUpdateEvent, listener: (...args: ReadonlyArray<unknown>) => void): () => void;
  check(): Promise<void>;
  install(): void;
};

export type CompanionUpdateController = {
  getState(): CompanionUpdateState;
  check(): Promise<void>;
  install(): void;
  dispose(): void;
};

type UpdateInfo = { readonly version?: unknown };
type DownloadProgress = { readonly percent?: unknown };

function updateVersion(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const version = (value as UpdateInfo).version;
  return typeof version === "string" && version.trim().length > 0 ? version.trim() : undefined;
}

function downloadPercent(value: unknown): number | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const percent = (value as DownloadProgress).percent;
  return typeof percent === "number" && Number.isFinite(percent)
    ? Math.max(0, Math.min(100, Math.round(percent)))
    : undefined;
}

function updateErrorMessage(value: unknown): string {
  return value instanceof Error && value.message.trim().length > 0
    ? value.message.trim()
    : "Jarvis could not check for updates.";
}

/**
 * Small updater interface, deep implementation: callers only render state and
 * request check/install. Feed configuration, differential downloads, event
 * ordering, background cadence, and cleanup remain inside this module.
 */
export function configureCompanionUpdates(input: {
  readonly updater: CompanionUpdater;
  readonly packaged: boolean;
  readonly schedule: (delayMs: number, task: () => void, repeat?: boolean) => () => void;
  readonly onState: (state: CompanionUpdateState) => void;
}): CompanionUpdateController {
  let state: CompanionUpdateState = input.packaged ? { status: "idle" } : { status: "disabled" };
  let checkInFlight = false;
  const disposers: Array<() => void> = [];

  const setState = (next: CompanionUpdateState) => {
    state = next;
    input.onState(next);
  };

  const check = async (): Promise<void> => {
    if (!input.packaged || checkInFlight || state.status === "ready") return;
    checkInFlight = true;
    setState({ status: "checking" });
    try {
      await input.updater.check();
    } catch (cause) {
      setState({ status: "error", message: updateErrorMessage(cause) });
    } finally {
      checkInFlight = false;
    }
  };

  const controller: CompanionUpdateController = {
    getState: () => state,
    check,
    install: () => {
      if (state.status === "ready") input.updater.install();
    },
    dispose: () => disposers.splice(0).forEach((dispose) => dispose()),
  };

  setState(state);
  if (!input.packaged) return controller;

  input.updater.configure();
  disposers.push(
    input.updater.on("checking-for-update", () => setState({ status: "checking" })),
    input.updater.on("update-available", (info) => {
      const version = updateVersion(info);
      setState({
        status: "downloading",
        ...(version === undefined ? {} : { version }),
      });
    }),
    input.updater.on("update-not-available", () => setState({ status: "idle" })),
    input.updater.on("download-progress", (progress) => {
      const currentVersion = state.status === "downloading" ? state.version : undefined;
      const percent = downloadPercent(progress);
      setState({
        status: "downloading",
        ...(currentVersion === undefined ? {} : { version: currentVersion }),
        ...(percent === undefined ? {} : { percent }),
      });
    }),
    input.updater.on("update-downloaded", (info) =>
      setState({ status: "ready", version: updateVersion(info) ?? "the latest version" }),
    ),
    input.updater.on("error", (error) =>
      setState({ status: "error", message: updateErrorMessage(error) }),
    ),
    input.schedule(15_000, () => void check()),
    input.schedule(10 * 60_000, () => void check(), true),
  );
  return controller;
}
