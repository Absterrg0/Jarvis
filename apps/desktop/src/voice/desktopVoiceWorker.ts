// This entry point is run with the Electron executable in Node mode. It is
// intentionally not an Electron application: the desktop shell remains the
// only process that owns windows, menus, shortcuts, and renderer state.
// @effect-diagnostics nodeBuiltinImport:off globalProcess:off globalTimers:off

import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

import {
  interruptNativeSpeech,
  parakeetModelPaths,
  prepareNativeMicrophone,
  prepareNativeSpeech,
  prepareParakeetRecognition,
  speakNativeSpeech,
  startParakeetCapture,
  disposeNativeSpeech,
} from "@t3tools/jarvis-native-voice";

import {
  type DesktopVoiceWorkerCommand,
  type DesktopVoiceWorkerMessage,
  type DesktopVoiceWorkerState,
} from "./DesktopVoiceWorkerProtocol.ts";

const write = (message: DesktopVoiceWorkerMessage): void => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

const resourceRoot = (): string => {
  const configured = process.env.JARVIS_VOICE_ROOT?.trim();
  if (configured) return configured;
  const electronResources = process.resourcesPath;
  if (typeof electronResources === "string") {
    return NodePath.join(electronResources, "jarvis-resources");
  }
  return NodePath.resolve(import.meta.dirname, "../../../packages/jarvis-native-voice/resources");
};

function configureVoiceResources(root: string): void {
  if (process.env.JARVIS_KOKORO_ROOT?.trim()) return;
  process.env.JARVIS_KOKORO_ROOT = NodePath.join(root, "kokoro");
}

let capture: ReturnType<typeof startParakeetCapture> | null = null;

const setState = (next: DesktopVoiceWorkerState): void => {
  write({ type: "state", state: next });
};

const result = (requestId: string, cause?: unknown): void => {
  if (cause === undefined) {
    write({ type: "result", requestId, ok: true });
    return;
  }
  const message = cause instanceof Error ? cause.message : String(cause);
  write({ type: "result", requestId, ok: false, message });
};

const handle = async (command: DesktopVoiceWorkerCommand): Promise<boolean> => {
  const root = resourceRoot();
  configureVoiceResources(root);
  const paths = parakeetModelPaths(NodePath.join(root, "parakeet"));
  try {
    switch (command.type) {
      case "prepare":
        prepareNativeMicrophone();
        await Promise.all([prepareParakeetRecognition(paths), prepareNativeSpeech()]);
        setState("ready");
        result(command.requestId);
        return false;
      case "capture-start":
        if (capture !== null) {
          result(command.requestId, new Error("Voice capture is already active."));
          return false;
        }
        // Push-to-talk is a barge-in action: stop Jarvis speaking before the
        // microphone opens, otherwise the recognizer can capture its own TTS.
        interruptNativeSpeech();
        setState("capturing");
        capture = startParakeetCapture({
          paths,
          onReady: () => write({ type: "capture-ready" }),
          onTranscript: (text) => write({ type: "transcript", text }),
        });
        void capture.result.then(
          (text) => {
            write({ type: "capture-result", ok: true, text });
            capture = null;
            setState("ready");
          },
          (cause) => {
            write({
              type: "capture-result",
              ok: false,
              message: cause instanceof Error ? cause.message : String(cause),
            });
            capture = null;
            setState("ready");
          },
        );
        result(command.requestId);
        return false;
      case "capture-release":
        setState("transcribing");
        capture?.release();
        result(command.requestId);
        return false;
      case "capture-cancel":
        capture?.cancel();
        capture = null;
        setState("ready");
        result(command.requestId);
        return false;
      case "speak":
        setState("speaking");
        await speakNativeSpeech(command.text);
        setState("ready");
        result(command.requestId);
        return false;
      case "interrupt":
        interruptNativeSpeech();
        if (capture !== null) {
          capture.cancel();
          capture = null;
        }
        setState("ready");
        result(command.requestId);
        return false;
      case "shutdown":
        capture?.cancel();
        capture = null;
        await disposeNativeSpeech();
        result(command.requestId);
        return true;
    }
  } catch (cause) {
    setState("error");
    result(command.requestId, cause);
    return false;
  }
};

const parseCommand = (line: string): DesktopVoiceWorkerCommand | null => {
  try {
    const value: unknown = JSON.parse(line);
    if (typeof value !== "object" || value === null || !("type" in value)) return null;
    const candidate = value as Record<string, unknown>;
    if (typeof candidate.requestId !== "string") return null;
    if (
      candidate.type === "prepare" ||
      candidate.type === "capture-start" ||
      candidate.type === "capture-release" ||
      candidate.type === "capture-cancel" ||
      candidate.type === "interrupt" ||
      candidate.type === "shutdown"
    ) {
      return { type: candidate.type, requestId: candidate.requestId } as DesktopVoiceWorkerCommand;
    }
    if (candidate.type === "speak" && typeof candidate.text === "string") {
      return { type: "speak", requestId: candidate.requestId, text: candidate.text };
    }
  } catch {
    // Malformed input is ignored; a broken renderer must not take down the
    // desktop process or turn the worker into an arbitrary command shell.
  }
  return null;
};

setState("starting");
void (async () => {
  try {
    prepareNativeMicrophone();
    setState("ready");
    write({ type: "ready" });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    write({ type: "fatal", message, code: "VOICE_UNAVAILABLE" });
    process.exitCode = 1;
  }
})();

const lines = NodeReadline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  const command = parseCommand(line);
  if (command === null) return;
  void handle(command).then((shouldExit) => {
    if (shouldExit) {
      lines.close();
      process.exitCode = 0;
    }
  });
});
