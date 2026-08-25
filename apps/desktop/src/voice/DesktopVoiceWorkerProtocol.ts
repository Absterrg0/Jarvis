/**
 * The desktop voice worker speaks a deliberately small JSON-lines protocol.
 * Keeping this contract independent from Electron IPC makes the worker easy
 * to smoke-test with the same Electron executable used by the packaged app.
 */
export type DesktopVoiceWorkerCommand =
  | { readonly type: "prepare"; readonly requestId: string }
  | { readonly type: "capture-start"; readonly requestId: string }
  | { readonly type: "capture-release"; readonly requestId: string }
  | { readonly type: "capture-cancel"; readonly requestId: string }
  | { readonly type: "speak"; readonly requestId: string; readonly text: string }
  | { readonly type: "interrupt"; readonly requestId: string }
  | { readonly type: "shutdown"; readonly requestId: string };

export type DesktopVoiceWorkerMessage =
  | { readonly type: "ready" }
  | { readonly type: "state"; readonly state: DesktopVoiceWorkerState }
  | { readonly type: "capture-ready" }
  | { readonly type: "transcript"; readonly text: string }
  | { readonly type: "capture-result"; readonly ok: true; readonly text: string }
  | { readonly type: "capture-result"; readonly ok: false; readonly message: string }
  | { readonly type: "error"; readonly message: string; readonly code?: string }
  | { readonly type: "result"; readonly requestId: string; readonly ok: true }
  | {
      readonly type: "result";
      readonly requestId: string;
      readonly ok: false;
      readonly message: string;
      readonly code?: string;
    }
  | { readonly type: "fatal"; readonly message: string; readonly code?: string };

export type DesktopVoiceWorkerState =
  | "starting"
  | "ready"
  | "capturing"
  | "transcribing"
  | "speaking"
  | "error";

export function parseDesktopVoiceWorkerMessage(value: unknown): DesktopVoiceWorkerMessage | null {
  if (typeof value !== "object" || value === null || !("type" in value)) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.type === "ready") return { type: "ready" };
  if (candidate.type === "capture-ready") return { type: "capture-ready" };
  if (candidate.type === "transcript" && typeof candidate.text === "string") {
    return { type: "transcript", text: candidate.text };
  }
  if (candidate.type === "capture-result") {
    if (candidate.ok === true && typeof candidate.text === "string") {
      return { type: "capture-result", ok: true, text: candidate.text };
    }
    if (candidate.ok === false && typeof candidate.message === "string") {
      return { type: "capture-result", ok: false, message: candidate.message };
    }
  }
  if (candidate.type === "error" && typeof candidate.message === "string") {
    return {
      type: "error",
      message: candidate.message,
      ...(typeof candidate.code === "string" ? { code: candidate.code } : {}),
    };
  }
  if (
    candidate.type === "state" &&
    (candidate.state === "starting" ||
      candidate.state === "ready" ||
      candidate.state === "capturing" ||
      candidate.state === "transcribing" ||
      candidate.state === "speaking" ||
      candidate.state === "error")
  ) {
    return { type: "state", state: candidate.state };
  }
  if (candidate.type === "fatal" && typeof candidate.message === "string") {
    return {
      type: "fatal",
      message: candidate.message,
      ...(typeof candidate.code === "string" ? { code: candidate.code } : {}),
    };
  }
  if (candidate.type === "result" && typeof candidate.requestId === "string") {
    if (candidate.ok === true) return { type: "result", requestId: candidate.requestId, ok: true };
    if (candidate.ok === false && typeof candidate.message === "string") {
      return {
        type: "result",
        requestId: candidate.requestId,
        ok: false,
        message: candidate.message,
        ...(typeof candidate.code === "string" ? { code: candidate.code } : {}),
      };
    }
  }
  return null;
}
