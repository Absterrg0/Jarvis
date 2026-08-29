// @effect-diagnostics nodeBuiltinImport:off
import { describe, expect, it } from "@effect/vitest";
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import { vi } from "vite-plus/test";

import {
  isDesktopVoiceWorkerRendererPcmCurrent,
  canDesktopVoiceWorkerSpeak,
  normalizeDesktopVoiceCaptureStart,
  parseDesktopVoiceWorkerCaptureSource,
  parseDesktopVoiceWorkerMessage,
  parseDesktopVoiceWorkerRendererPcmMessage,
  type DesktopVoiceWorkerMessage,
} from "./DesktopVoiceWorkerProtocol.ts";
import {
  broadcastDesktopJarvisVoiceMessage,
  createDesktopJarvisVoice,
  resolveDesktopJarvisVoiceResourceRoot,
} from "./DesktopJarvisVoice.ts";

const workerSource = NodeFS.readFileSync(
  new URL("./desktopVoiceWorker.ts", import.meta.url),
  "utf8",
);

describe("desktop voice worker protocol", () => {
  it("does not rewarm Parakeet from the speech queue idle hook", () => {
    const queue = workerSource.indexOf("function voiceSpeechQueue");
    const queueEnd = workerSource.indexOf("async function speakQueued", queue);
    const queueSource = workerSource.slice(queue, queueEnd);

    expect(queue).toBeGreaterThanOrEqual(0);
    expect(queueEnd).toBeGreaterThan(queue);
    expect(queueSource).not.toContain("prepareListening");
  });

  it("does not let speech completion publish ready over a newer capture", () => {
    expect(
      canDesktopVoiceWorkerSpeak({
        captureActive: false,
        captureStarting: false,
        captureGeneration: 2,
        speechGeneration: 1,
      }),
    ).toBe(false);
    expect(
      canDesktopVoiceWorkerSpeak({
        captureActive: false,
        captureStarting: false,
        captureGeneration: 2,
        speechGeneration: 2,
      }),
    ).toBe(true);
    expect(
      canDesktopVoiceWorkerSpeak({
        captureActive: true,
        captureStarting: false,
        captureGeneration: 2,
        speechGeneration: 2,
      }),
    ).toBe(false);
    expect(
      canDesktopVoiceWorkerSpeak({
        captureActive: false,
        captureStarting: true,
        captureGeneration: 2,
        speechGeneration: 2,
      }),
    ).toBe(false);
  });

  it("resolves Linux Full resources from Desktop resources", () => {
    expect(
      resolveDesktopJarvisVoiceResourceRoot({
        platform: "linux",
        isPackaged: true,
        resourcesPath: "/opt/jarvis/resources",
        executablePath: "/opt/jarvis/jarvis",
        developmentResourceRoot: "/repo/packages/jarvis-native-voice/resources",
        exists: (path) => path === "/opt/jarvis/resources/jarvis-resources",
      }),
    ).toBe("/opt/jarvis/resources/jarvis-resources");
  });

  it("resolves macOS Full resources from Desktop resources", () => {
    expect(
      resolveDesktopJarvisVoiceResourceRoot({
        platform: "darwin",
        isPackaged: true,
        resourcesPath: "/Applications/Jarvis.app/Contents/Resources",
        executablePath: "/Applications/Jarvis.app/Contents/MacOS/Jarvis",
        developmentResourceRoot: "/repo/packages/jarvis-native-voice/resources",
        exists: (path) => path === "/Applications/Jarvis.app/Contents/Resources/jarvis-resources",
      }),
    ).toBe("/Applications/Jarvis.app/Contents/Resources/jarvis-resources");
  });

  it("resolves Windows resources from the packaged Desktop resource directory", () => {
    expect(
      resolveDesktopJarvisVoiceResourceRoot({
        platform: "win32",
        isPackaged: true,
        resourcesPath: "C:\\Jarvis\\desktop\\resources",
        executablePath: "C:\\Jarvis\\desktop\\Jarvis.exe",
        developmentResourceRoot: "C:\\repo\\packages\\jarvis-native-voice\\resources",
        exists: (path) => path === "C:\\Jarvis\\desktop\\resources\\jarvis-resources",
      }),
    ).toBe("C:\\Jarvis\\desktop\\resources\\jarvis-resources");
  });

  it("does not claim microphone capture support on macOS", async () => {
    const spawn = vi.fn();
    const voice = createDesktopJarvisVoice({
      platform: "darwin",
      architecture: "arm64",
      workerPath: "/worker.cjs",
      resourceRoot: "/resources",
      spawn: spawn as never,
    });
    await expect(voice.startCapture()).resolves.toEqual({ accepted: false });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("accepts capture results and transcript events", () => {
    expect(
      parseDesktopVoiceWorkerMessage({ type: "capture-result", ok: true, text: "open rivvl" }),
    ).toEqual({ type: "capture-result", ok: true, text: "open rivvl" });
    expect(parseDesktopVoiceWorkerMessage({ type: "transcript", text: "open rivvl" })).toEqual({
      type: "transcript",
      text: "open rivvl",
    });
    expect(
      parseDesktopVoiceWorkerMessage({
        type: "capture-result",
        ok: false,
        message: "No microphone",
        code: "no-input-device",
      }),
    ).toEqual({
      type: "capture-result",
      ok: false,
      message: "No microphone",
      code: "no-input-device",
    });
    expect(parseDesktopVoiceWorkerMessage({ type: "level", level: 0.42 })).toEqual({
      type: "level",
      level: 0.42,
    });
    expect(parseDesktopVoiceWorkerMessage({ type: "level", level: 1.1 })).toBeNull();
    expect(
      parseDesktopVoiceWorkerMessage({
        type: "speech-timing",
        timing: {
          engineId: "kokoro-int8",
          start: "cold",
          warmupMs: 980,
          firstChunkReadyMs: 1_440,
          firstPlaybackStartMs: 2_421,
          synthesisMs: 8_328,
          totalMs: 10_201,
          synthesisCpuMs: 16_611,
          peakRssBytes: 400_000_000,
          chunkCount: 4,
        },
      }),
    ).toEqual({
      type: "speech-timing",
      timing: expect.objectContaining({ start: "cold", firstPlaybackStartMs: 2_421 }),
    });
    expect(
      parseDesktopVoiceWorkerMessage({
        type: "speech-timing",
        timing: { engineId: "kokoro-int8", start: "warm", synthesisMs: -1 },
      }),
    ).toBeNull();
  });

  it("preserves typed speech outcomes instead of flattening deferral into acceptance", () => {
    expect(
      parseDesktopVoiceWorkerMessage({
        type: "result",
        requestId: "speak-1",
        ok: true,
        outcome: { status: "deferred", reason: "superseded" },
      }),
    ).toEqual({
      type: "result",
      requestId: "speak-1",
      ok: true,
      outcome: { status: "deferred", reason: "superseded" },
    });
  });

  it("keeps diagnostic capture identity on start and transcript events", () => {
    expect(
      normalizeDesktopVoiceCaptureStart(
        { purpose: "diagnostic", captureId: "mic-test" },
        () => "unused",
      ),
    ).toEqual({
      purpose: "diagnostic",
      captureId: "mic-test",
      source: { type: "native" },
      contextualPhrases: [],
    });

    expect(
      normalizeDesktopVoiceCaptureStart(
        {
          purpose: "command",
          contextualPhrases: [" Alertify ", "Alertify", "Codex"],
        },
        () => "capture-context",
      ),
    ).toEqual({
      purpose: "command",
      captureId: "capture-context",
      source: { type: "native" },
      contextualPhrases: ["Alertify", "Codex"],
    });
    expect(
      parseDesktopVoiceWorkerMessage({
        type: "transcript",
        text: "testing one two",
        purpose: "diagnostic",
        captureId: "mic-test",
      }),
    ).toEqual({
      type: "transcript",
      text: "testing one two",
      purpose: "diagnostic",
      captureId: "mic-test",
    });
  });

  it("rejects malformed worker messages", () => {
    expect(parseDesktopVoiceWorkerMessage({ type: "result", requestId: "x", ok: false })).toBe(
      null,
    );
    expect(parseDesktopVoiceWorkerMessage({ type: "state", state: "unknown" })).toBe(null);
  });

  it("forwards Kokoro timing records from the voice child", async () => {
    const stdout = new NodeEvents.EventEmitter();
    const emitted: DesktopVoiceWorkerMessage[] = [];
    const child = Object.assign(new NodeEvents.EventEmitter(), {
      stdin: {
        destroyed: false,
        write(chunk: string) {
          const command = JSON.parse(chunk) as { type: string; requestId: string };
          stdout.emit(
            "data",
            Buffer.from(
              `${JSON.stringify({ type: "result", requestId: command.requestId, ok: true })}\n`,
            ),
          );
          return true;
        },
      },
      stdout,
      stderr: new NodeEvents.EventEmitter(),
      connected: true,
      killed: false,
      kill() {
        return true;
      },
    });
    const voice = createDesktopJarvisVoice({
      platform: "linux",
      architecture: "x64",
      workerPath: "/worker.cjs",
      resourceRoot: "/resources",
      spawn: (() => child) as never,
      emit: (message) => emitted.push(message),
    });
    const preparing = voice.prepare();
    stdout.emit("data", Buffer.from('{"type":"ready"}\n'));
    await preparing;
    stdout.emit(
      "data",
      Buffer.from(
        `${JSON.stringify({
          type: "speech-timing",
          timing: {
            engineId: "kokoro-int8",
            start: "warm",
            warmupMs: 0,
            firstChunkReadyMs: 1_300,
            firstPlaybackStartMs: 1_302,
            synthesisMs: 7_600,
            totalMs: 9_000,
            synthesisCpuMs: 15_000,
            peakRssBytes: 500_000_000,
            chunkCount: 4,
          },
        })}\n`,
      ),
    );
    expect(emitted).toContainEqual(
      expect.objectContaining({
        type: "speech-timing",
        timing: expect.objectContaining({ start: "warm", synthesisMs: 7_600 }),
      }),
    );
    voice.stop();
  });

  it("prewarms Kokoro without preparing microphone capture", async () => {
    const stdout = new NodeEvents.EventEmitter();
    const commands: string[] = [];
    const child = Object.assign(new NodeEvents.EventEmitter(), {
      stdin: {
        destroyed: false,
        write(chunk: string) {
          const command = JSON.parse(chunk) as { type: string; requestId: string };
          commands.push(command.type);
          stdout.emit(
            "data",
            Buffer.from(
              `${JSON.stringify({ type: "result", requestId: command.requestId, ok: true })}\n`,
            ),
          );
          return true;
        },
      },
      stdout,
      stderr: new NodeEvents.EventEmitter(),
      connected: true,
      killed: false,
      kill() {
        return true;
      },
    });
    const voice = createDesktopJarvisVoice({
      platform: "linux",
      architecture: "x64",
      workerPath: "/worker.cjs",
      resourceRoot: "/resources",
      spawn: (() => child) as never,
    });

    const preparing = voice.prepareSpeech();
    stdout.emit("data", Buffer.from('{"type":"ready"}\n'));

    await expect(preparing).resolves.toEqual({ accepted: true });
    expect(commands).toEqual(["prepare-speech"]);
  });

  it("routes acknowledgement audio through the native voice worker", async () => {
    const stdout = new NodeEvents.EventEmitter();
    const commands: string[] = [];
    const child = Object.assign(new NodeEvents.EventEmitter(), {
      stdin: {
        destroyed: false,
        write(chunk: string) {
          const command = JSON.parse(chunk) as { type: string; requestId: string };
          commands.push(command.type);
          stdout.emit(
            "data",
            Buffer.from(
              `${JSON.stringify({ type: "result", requestId: command.requestId, ok: true })}\n`,
            ),
          );
          return true;
        },
      },
      stdout,
      stderr: new NodeEvents.EventEmitter(),
      connected: true,
      killed: false,
      kill() {
        return true;
      },
    });
    const voice = createDesktopJarvisVoice({
      platform: "linux",
      architecture: "x64",
      workerPath: "/worker.cjs",
      resourceRoot: "/resources",
      spawn: (() => child) as never,
    });

    const playing = voice.playAcknowledgement();
    stdout.emit("data", Buffer.from('{"type":"ready"}\n'));

    await expect(playing).resolves.toEqual({ accepted: true });
    expect(commands).toEqual(["play-acknowledgement"]);
  });

  it("surfaces the exact native playback failure without replacing the voice worker", async () => {
    const stdout = new NodeEvents.EventEmitter();
    const emitted: DesktopVoiceWorkerMessage[] = [];
    const child = Object.assign(new NodeEvents.EventEmitter(), {
      stdin: {
        destroyed: false,
        write(chunk: string) {
          const command = JSON.parse(chunk) as { type: string; requestId: string };
          if (command.type === "speak") {
            stdout.emit("data", Buffer.from('{"type":"state","state":"error"}\n'));
          }
          stdout.emit(
            "data",
            Buffer.from(
              `${JSON.stringify({
                type: "result",
                requestId: command.requestId,
                ...(command.type === "speak"
                  ? { ok: true, outcome: { status: "failed", code: "speech-output-failed" } }
                  : { ok: true }),
              })}\n`,
            ),
          );
          return true;
        },
      },
      stdout,
      stderr: new NodeEvents.EventEmitter(),
      connected: true,
      killed: false,
      kill() {
        this.killed = true;
        return true;
      },
    });
    const spawn = vi.fn(() => child);
    const voice = createDesktopJarvisVoice({
      platform: "linux",
      architecture: "x64",
      workerPath: "/worker.cjs",
      resourceRoot: "/resources",
      spawn: spawn as never,
      emit: (message) => emitted.push(message),
    });

    const speaking = voice.speak("Jarvis is ready.");
    stdout.emit("data", Buffer.from('{"type":"ready"}\n'));

    await expect(speaking).resolves.toEqual({ status: "failed", code: "speech-output-failed" });
    expect(emitted).not.toContainEqual(expect.objectContaining({ type: "error" }));
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(child.killed).toBe(false);
    await expect(voice.startCapture()).resolves.toEqual({ accepted: true });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(child.killed).toBe(false);
    voice.stop();
  });

  it("carries report speech with its delivery ID", async () => {
    const stdout = new NodeEvents.EventEmitter();
    const commands: Array<{ type: string; lane?: string; deliveryId?: string }> = [];
    const child = Object.assign(new NodeEvents.EventEmitter(), {
      stdin: {
        destroyed: false,
        write(chunk: string) {
          const command = JSON.parse(chunk) as {
            type: string;
            requestId: string;
            lane?: string;
            deliveryId?: string;
          };
          commands.push(command);
          stdout.emit(
            "data",
            Buffer.from(
              `${JSON.stringify({ type: "result", requestId: command.requestId, ok: true })}\n`,
            ),
          );
          return true;
        },
      },
      stdout,
      stderr: new NodeEvents.EventEmitter(),
      connected: true,
      killed: false,
      kill() {
        return true;
      },
    });
    const voice = createDesktopJarvisVoice({
      platform: "linux",
      architecture: "x64",
      workerPath: "/worker.cjs",
      resourceRoot: "/resources",
      spawn: (() => child) as never,
    });

    const speaking = voice.speak("Task completed.", "report", "delivery-1");
    stdout.emit("data", Buffer.from('{"type":"ready"}\n'));
    await expect(speaking).resolves.toEqual({ status: "played" });
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ type: "speak", lane: "report", deliveryId: "delivery-1" });
    await expect(voice.cancelSpeech("delivery-1")).resolves.toEqual({ accepted: true });
    expect(commands[1]).toMatchObject({ type: "cancel-speech", deliveryId: "delivery-1" });
    voice.stop();
  });

  it("returns accepted false for a report dropped before synthesis without emitting an error", async () => {
    const stdout = new NodeEvents.EventEmitter();
    const emitted: DesktopVoiceWorkerMessage[] = [];
    const child = Object.assign(new NodeEvents.EventEmitter(), {
      stdin: {
        destroyed: false,
        write(chunk: string) {
          const command = JSON.parse(chunk) as { type: string; requestId: string };
          stdout.emit(
            "data",
            Buffer.from(
              `${JSON.stringify({
                type: "result",
                requestId: command.requestId,
                ok: true,
                ...(command.type === "speak"
                  ? { outcome: { status: "deferred", reason: "superseded" } }
                  : {}),
              })}\n`,
            ),
          );
          return true;
        },
      },
      stdout,
      stderr: new NodeEvents.EventEmitter(),
      connected: true,
      killed: false,
      kill() {
        return true;
      },
    });
    const voice = createDesktopJarvisVoice({
      platform: "linux",
      architecture: "x64",
      workerPath: "/worker.cjs",
      resourceRoot: "/resources",
      spawn: (() => child) as never,
      emit: (message) => emitted.push(message),
    });

    const speaking = voice.speak("A superseded report.", "report", "delivery-2");
    stdout.emit("data", Buffer.from('{"type":"ready"}\n'));
    await expect(speaking).resolves.toEqual({ status: "deferred", reason: "superseded" });
    expect(emitted.filter((message) => message.type === "error")).toHaveLength(0);
    voice.stop();
  });

  it("does not let background preparation publish ready over an active capture", async () => {
    const stdout = new NodeEvents.EventEmitter();
    const states: string[] = [];
    let pendingPrepareRequestId: string | undefined;
    const child = Object.assign(new NodeEvents.EventEmitter(), {
      stdin: {
        destroyed: false,
        write(chunk: string) {
          const command = JSON.parse(chunk) as { type: string; requestId: string };
          if (command.type === "prepare") {
            pendingPrepareRequestId = command.requestId;
          }
          if (command.type === "capture-start") {
            stdout.emit("data", Buffer.from('{"type":"state","state":"starting"}\n'));
            stdout.emit("data", Buffer.from('{"type":"state","state":"capturing"}\n'));
            stdout.emit(
              "data",
              Buffer.from(
                `${JSON.stringify({ type: "result", requestId: command.requestId, ok: true })}\n`,
              ),
            );
          }
          return true;
        },
      },
      stdout,
      stderr: new NodeEvents.EventEmitter(),
      connected: true,
      killed: false,
      send() {
        return true;
      },
      kill() {
        return true;
      },
    });
    const voice = createDesktopJarvisVoice({
      platform: "linux",
      architecture: "x64",
      workerPath: "/worker.cjs",
      resourceRoot: "/resources",
      spawn: (() => child) as never,
    });
    voice.onState((state) => states.push(state.status));

    const preparing = voice.prepare();
    stdout.emit("data", Buffer.from('{"type":"ready"}\n'));
    await Promise.resolve();
    await Promise.resolve();
    await expect(voice.startCapture()).resolves.toEqual({ accepted: true });
    expect(states.at(-1)).toBe("capturing");

    if (pendingPrepareRequestId !== undefined) {
      stdout.emit("data", Buffer.from('{"type":"state","state":"ready"}\n'));
      stdout.emit(
        "data",
        Buffer.from(
          `${JSON.stringify({ type: "result", requestId: pendingPrepareRequestId, ok: true })}\n`,
        ),
      );
    }
    await preparing;

    expect(states.at(-1)).toBe("capturing");
    voice.stop();
  });

  it("does not send capture-start while a concurrent worker startup is still pending", async () => {
    const stdout = new NodeEvents.EventEmitter();
    const commands: Array<{
      readonly type: string;
      readonly requestId: string;
      readonly contextualPhrases?: ReadonlyArray<string>;
    }> = [];
    const child = Object.assign(new NodeEvents.EventEmitter(), {
      stdin: {
        destroyed: false,
        write(chunk: string) {
          const command = JSON.parse(chunk) as { type: string; requestId: string };
          commands.push(command);
          if (command.type === "prepare") {
            stdout.emit(
              "data",
              Buffer.from(
                `${JSON.stringify({ type: "result", requestId: command.requestId, ok: true })}\n`,
              ),
            );
          }
          if (command.type === "capture-start") {
            stdout.emit(
              "data",
              Buffer.from(
                `${JSON.stringify({ type: "result", requestId: command.requestId, ok: true })}\n`,
              ),
            );
          }
          return true;
        },
      },
      stdout,
      stderr: new NodeEvents.EventEmitter(),
      connected: true,
      killed: false,
      send() {
        return true;
      },
      kill() {
        return true;
      },
    });
    const voice = createDesktopJarvisVoice({
      platform: "linux",
      architecture: "x64",
      workerPath: "/worker.cjs",
      resourceRoot: "/resources",
      spawn: (() => child) as never,
    });

    const preparing = voice.prepare();
    const starting = voice.startCapture({ contextualPhrases: ["Alertify", "Codex"] });
    await Promise.resolve();
    await Promise.resolve();
    expect(commands.map((command) => command.type)).toEqual([]);

    stdout.emit("data", Buffer.from('{"type":"ready"}\n'));
    // A concurrent capture already owns the lifecycle, so worker startup must
    // not publish a false terminal "ready" state between press and capture.
    await expect(preparing).resolves.toEqual({ status: "starting", native: true });
    await expect(starting).resolves.toEqual({ accepted: true });
    expect(commands.map((command) => command.type)).toEqual(["prepare", "capture-start"]);
    expect(commands.at(-1)?.contextualPhrases).toEqual(["Alertify", "Codex"]);
    voice.stop();
  });

  it("times out an unacknowledged capture command, kills its worker, and retries cleanly", async () => {
    vi.useFakeTimers();
    try {
      const children: Array<{
        readonly stdout: NodeEvents.EventEmitter;
        readonly child: NodeEvents.EventEmitter & { killed: boolean; kill: () => boolean };
      }> = [];
      const spawn = vi.fn(() => {
        const stdout = new NodeEvents.EventEmitter();
        const child = Object.assign(new NodeEvents.EventEmitter(), {
          stdin: {
            destroyed: false,
            write(chunk: string) {
              const command = JSON.parse(chunk) as { type: string; requestId: string };
              if (command.type === "capture-start" && children.length > 1) {
                stdout.emit(
                  "data",
                  Buffer.from(
                    `${JSON.stringify({ type: "result", requestId: command.requestId, ok: true })}\n`,
                  ),
                );
              }
              return true;
            },
          },
          stdout,
          stderr: new NodeEvents.EventEmitter(),
          connected: true,
          killed: false,
          kill() {
            this.killed = true;
            return true;
          },
        });
        children.push({ stdout, child });
        queueMicrotask(() => stdout.emit("data", Buffer.from('{"type":"ready"}\n')));
        return child;
      });
      const voice = createDesktopJarvisVoice({
        platform: "linux",
        architecture: "x64",
        workerPath: "/worker.cjs",
        resourceRoot: "/resources",
        spawn: spawn as never,
        commandTimeoutMs: 20,
      });

      const firstStart = voice.startCapture();
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(20);
      await expect(firstStart).resolves.toEqual({ accepted: false });
      expect(children).toHaveLength(1);
      expect(children[0]?.child.killed).toBe(true);
      expect(voice.getState().status).toBe("error");

      const secondStart = voice.startCapture();
      await expect(secondStart).resolves.toEqual({ accepted: true });
      expect(spawn).toHaveBeenCalledTimes(2);
      expect(children[1]?.child).not.toBe(children[0]?.child);
      voice.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases a quick push-to-talk hold before capture-start is acknowledged", async () => {
    const stdout = new NodeEvents.EventEmitter();
    const commands: Array<{ readonly type: string; readonly requestId: string }> = [];
    const child = Object.assign(new NodeEvents.EventEmitter(), {
      stdin: {
        destroyed: false,
        write(chunk: string) {
          const command = JSON.parse(chunk) as { type: string; requestId: string };
          commands.push(command);
          if (command.type === "prepare") {
            stdout.emit(
              "data",
              Buffer.from(
                `${JSON.stringify({ type: "result", requestId: command.requestId, ok: true })}\n`,
              ),
            );
          }
          return true;
        },
      },
      stdout,
      stderr: new NodeEvents.EventEmitter(),
      connected: true,
      killed: false,
      send() {
        return true;
      },
      kill() {
        return true;
      },
    });
    const voice = createDesktopJarvisVoice({
      platform: "linux",
      architecture: "x64",
      workerPath: "/worker.cjs",
      resourceRoot: "/resources",
      spawn: (() => child) as never,
    });

    const preparing = voice.prepare();
    stdout.emit("data", Buffer.from('{"type":"ready"}\n'));
    await preparing;

    const starting = voice.startCapture();
    const releasing = voice.releaseCapture();
    await Promise.resolve();
    await Promise.resolve();

    const captureCommands = commands.filter((command) => command.type.startsWith("capture-"));
    expect(captureCommands.map((command) => command.type)).toEqual([
      "capture-start",
      "capture-release",
    ]);

    for (const command of captureCommands) {
      stdout.emit(
        "data",
        Buffer.from(
          `${JSON.stringify({ type: "result", requestId: command.requestId, ok: true })}\n`,
        ),
      );
    }
    await expect(starting).resolves.toEqual({ accepted: true });
    await expect(releasing).resolves.toEqual({ accepted: true });
    voice.stop();
  });

  it("requires capture-ready session metadata as a positive all-or-nothing pair", () => {
    expect(parseDesktopVoiceWorkerMessage({ type: "capture-ready" })).toEqual({
      type: "capture-ready",
    });
    expect(
      parseDesktopVoiceWorkerMessage({ type: "capture-ready", sessionId: "session-1" }),
    ).toBeNull();
    expect(parseDesktopVoiceWorkerMessage({ type: "capture-ready", generation: 1 })).toBeNull();
    expect(
      parseDesktopVoiceWorkerMessage({ type: "capture-ready", sessionId: "", generation: 1 }),
    ).toBeNull();
    expect(
      parseDesktopVoiceWorkerMessage({
        type: "capture-ready",
        sessionId: "session-1",
        generation: 0,
      }),
    ).toBeNull();
    expect(
      parseDesktopVoiceWorkerMessage({
        type: "capture-ready",
        sessionId: "session-1",
        generation: 1.5,
      }),
    ).toBeNull();
    expect(
      parseDesktopVoiceWorkerMessage({
        type: "capture-ready",
        sessionId: "session-1",
        generation: 1,
      }),
    ).toEqual({ type: "capture-ready", sessionId: "session-1", generation: 1 });
  });

  it("validates renderer PCM metadata and preserves Float32Array payloads", () => {
    expect(
      parseDesktopVoiceWorkerCaptureSource({
        type: "renderer-pcm",
        sessionId: "session-1",
        generation: 2,
        sampleRate: 48_000,
        channels: 2,
      }),
    ).toEqual({
      type: "renderer-pcm",
      sessionId: "session-1",
      generation: 2,
      sampleRate: 48_000,
      channels: 2,
    });
    const samples = Float32Array.from([0.25, -0.25]);
    const parsed = parseDesktopVoiceWorkerRendererPcmMessage({
      type: "renderer-pcm",
      sessionId: "session-1",
      generation: 2,
      samples,
    });
    expect(parsed?.samples).toBe(samples);
    expect(isDesktopVoiceWorkerRendererPcmCurrent(parsed!, "session-1", 2)).toBe(true);
    expect(isDesktopVoiceWorkerRendererPcmCurrent(parsed!, "session-1", 1)).toBe(false);
    expect(
      parseDesktopVoiceWorkerRendererPcmMessage({
        type: "renderer-pcm",
        sessionId: "session-1",
        generation: 1,
        samples: [0.25, -0.25],
      }),
    ).toBeNull();
  });

  it("waits for child.send callback before releasing renderer PCM", async () => {
    const stdout = new NodeEvents.EventEmitter();
    const writes: string[] = [];
    let flushPcm: ((error: Error | null) => void) | undefined;
    const child = Object.assign(new NodeEvents.EventEmitter(), {
      stdin: {
        destroyed: false,
        write(chunk: string) {
          writes.push(chunk);
          const command = JSON.parse(chunk) as { requestId: string };
          stdout.emit(
            "data",
            Buffer.from(
              JSON.stringify({ type: "result", requestId: command.requestId, ok: true }) + "\n",
            ),
          );
          return true;
        },
      },
      stdout,
      stderr: new NodeEvents.EventEmitter(),
      connected: true,
      killed: false,
      send(_message: unknown, callback: (error: Error | null) => void) {
        flushPcm = callback;
        return true;
      },
      kill() {
        return true;
      },
    });
    const spawn = vi.fn(() => child);
    const voice = createDesktopJarvisVoice({
      platform: "darwin",
      architecture: "arm64",
      workerPath: "/worker.cjs",
      resourceRoot: "/resources",
      spawn: spawn as never,
    });
    const preparing = voice.prepare();
    stdout.emit("data", Buffer.from('{"type":"ready"}\n'));
    await preparing;
    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      ["/worker.cjs"],
      expect.objectContaining({
        serialization: "advanced",
        stdio: ["pipe", "pipe", "pipe", "ipc"],
      }),
    );
    await expect(
      voice.startCapture({
        type: "renderer-pcm",
        sessionId: "session-1",
        generation: 1,
        sampleRate: 48_000,
        channels: 1,
      }),
    ).resolves.toEqual({ accepted: true });
    const pushing = voice.pushPcmFrame({
      sessionId: "session-1",
      generation: 1,
      samples: Float32Array.from([0.5]),
    });
    const releasing = voice.releaseCapture();
    await Promise.resolve();
    expect(writes.some((write) => write.includes('"capture-release"'))).toBe(false);
    flushPcm?.(null);
    await expect(pushing).resolves.toEqual({ accepted: true });
    await expect(releasing).resolves.toEqual({ accepted: true });
    expect(writes.some((write) => write.includes('"capture-release"'))).toBe(true);
    await expect(
      voice.pushPcmFrame({
        sessionId: "session-1",
        generation: 1,
        samples: Float32Array.from([0.25]),
      }),
    ).resolves.toEqual({ accepted: false });
  });

  it("bounds a renderer PCM delivery when child.send never acknowledges", async () => {
    vi.useFakeTimers();
    try {
      const stdout = new NodeEvents.EventEmitter();
      const stdin = {
        destroyed: false,
        write(chunk: string) {
          const command = JSON.parse(chunk) as { requestId: string };
          stdout.emit(
            "data",
            Buffer.from(
              JSON.stringify({ type: "result", requestId: command.requestId, ok: true }) + "\n",
            ),
          );
          return true;
        },
      };
      const child = Object.assign(new NodeEvents.EventEmitter(), {
        stdin,
        stdout,
        stderr: new NodeEvents.EventEmitter(),
        connected: true,
        killed: false,
        send() {
          return true;
        },
        kill() {
          return true;
        },
      });
      const voice = createDesktopJarvisVoice({
        platform: "darwin",
        architecture: "arm64",
        workerPath: "/worker.cjs",
        resourceRoot: "/resources",
        spawn: (() => child) as never,
      });
      const preparing = voice.prepare();
      stdout.emit("data", Buffer.from('{"type":"ready"}\n'));
      await preparing;
      await expect(
        voice.startCapture({
          type: "renderer-pcm",
          sessionId: "session-timeout",
          generation: 1,
          sampleRate: 48_000,
          channels: 1,
        }),
      ).resolves.toEqual({ accepted: true });

      const pushing = voice.pushPcmFrame({
        sessionId: "session-timeout",
        generation: 1,
        samples: Float32Array.from([0.5]),
      });
      let released = false;
      const releasing = voice.releaseCapture().then((result) => {
        released = true;
        return result;
      });
      await Promise.resolve();
      expect(released).toBe(false);
      vi.advanceTimersByTime(2_000);
      await expect(pushing).resolves.toEqual({ accepted: false });
      await expect(releasing).resolves.toEqual({ accepted: true });
      expect(released).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("invalidates renderer PCM deliveries when the worker exits", async () => {
    const stdout = new NodeEvents.EventEmitter();
    const stdin = {
      destroyed: false,
      write(chunk: string) {
        const command = JSON.parse(chunk) as { requestId: string };
        stdout.emit(
          "data",
          Buffer.from(
            JSON.stringify({ type: "result", requestId: command.requestId, ok: true }) + "\n",
          ),
        );
        return true;
      },
    };
    const child = Object.assign(new NodeEvents.EventEmitter(), {
      stdin,
      stdout,
      stderr: new NodeEvents.EventEmitter(),
      connected: true,
      killed: false,
      send() {
        return true;
      },
      kill() {
        return true;
      },
    });
    const voice = createDesktopJarvisVoice({
      platform: "darwin",
      architecture: "arm64",
      workerPath: "/worker.cjs",
      resourceRoot: "/resources",
      spawn: (() => child) as never,
    });
    const preparing = voice.prepare();
    stdout.emit("data", Buffer.from('{"type":"ready"}\n'));
    await preparing;
    await expect(
      voice.startCapture({
        type: "renderer-pcm",
        sessionId: "session-exit",
        generation: 1,
        sampleRate: 48_000,
        channels: 1,
      }),
    ).resolves.toEqual({ accepted: true });
    const pushing = voice.pushPcmFrame({
      sessionId: "session-exit",
      generation: 1,
      samples: Float32Array.from([0.5]),
    });
    child.emit("exit", 1);
    await expect(pushing).resolves.toEqual({ accepted: false });
    await expect(
      voice.pushPcmFrame({
        sessionId: "session-exit",
        generation: 1,
        samples: Float32Array.from([0.25]),
      }),
    ).resolves.toEqual({ accepted: false });
    await expect(voice.releaseCapture()).resolves.toEqual({ accepted: false });
  });

  it("surfaces a worker crash during a native hold as a user-visible error", async () => {
    const stdout = new NodeEvents.EventEmitter();
    const messages: DesktopVoiceWorkerMessage[] = [];
    const stdin = {
      destroyed: false,
      write(chunk: string) {
        const command = JSON.parse(chunk) as { requestId: string };
        stdout.emit(
          "data",
          Buffer.from(
            JSON.stringify({ type: "result", requestId: command.requestId, ok: true }) + "\n",
          ),
        );
        return true;
      },
    };
    const child = Object.assign(new NodeEvents.EventEmitter(), {
      stdin,
      stdout,
      stderr: new NodeEvents.EventEmitter(),
      connected: true,
      killed: false,
      kill() {
        return true;
      },
    });
    const voice = createDesktopJarvisVoice({
      platform: "linux",
      architecture: "x64",
      workerPath: "/worker.cjs",
      resourceRoot: "/resources",
      spawn: (() => child) as never,
      emit: (message) => messages.push(message),
    });
    const preparing = voice.prepare();
    stdout.emit("data", Buffer.from('{"type":"ready"}\n'));
    await preparing;
    await expect(voice.startCapture({ purpose: "command", captureId: "hold-1" })).resolves.toEqual({
      accepted: true,
    });
    child.emit("exit", 1);
    expect(voice.getState()).toEqual({ status: "error", native: true, errorCode: "WORKER_EXITED" });
    expect(messages).toContainEqual({
      type: "error",
      message: "Voice capture stopped unexpectedly. Try talking again.",
    });
  });

  it("clears renderer capture state when release or cancel fails", async () => {
    const stdout = new NodeEvents.EventEmitter();
    let failCommands = false;
    const stdin = {
      destroyed: false,
      write(chunk: string, callback?: (cause?: Error | null) => void) {
        const command = JSON.parse(chunk) as { requestId: string };
        if (failCommands) {
          callback?.(new Error("worker command failed"));
          return true;
        }
        stdout.emit(
          "data",
          Buffer.from(
            JSON.stringify({ type: "result", requestId: command.requestId, ok: true }) + "\n",
          ),
        );
        return true;
      },
    };
    const child = Object.assign(new NodeEvents.EventEmitter(), {
      stdin,
      stdout,
      stderr: new NodeEvents.EventEmitter(),
      connected: true,
      killed: false,
      send() {
        return true;
      },
      kill() {
        return true;
      },
    });
    const voice = createDesktopJarvisVoice({
      platform: "darwin",
      architecture: "arm64",
      workerPath: "/worker.cjs",
      resourceRoot: "/resources",
      spawn: (() => child) as never,
    });
    const preparing = voice.prepare();
    stdout.emit("data", Buffer.from('{"type":"ready"}\n'));
    await preparing;
    const source = {
      type: "renderer-pcm" as const,
      sessionId: "session-failure",
      generation: 1,
      sampleRate: 48_000,
      channels: 1,
    };
    await expect(voice.startCapture(source)).resolves.toEqual({ accepted: true });
    failCommands = true;
    await expect(voice.releaseCapture()).resolves.toEqual({ accepted: false });
    await expect(
      voice.pushPcmFrame({
        sessionId: source.sessionId,
        generation: source.generation,
        samples: Float32Array.from([0.5]),
      }),
    ).resolves.toEqual({ accepted: false });

    failCommands = false;
    await expect(voice.startCapture(source)).resolves.toEqual({ accepted: true });
    failCommands = true;
    await expect(voice.cancelCapture()).resolves.toEqual({ accepted: false });
    await expect(
      voice.pushPcmFrame({
        sessionId: source.sessionId,
        generation: source.generation,
        samples: Float32Array.from([0.25]),
      }),
    ).resolves.toEqual({ accepted: false });
  });

  it("does not let an older release completion clear a newer capture", async () => {
    const stdout = new NodeEvents.EventEmitter();
    const messages: DesktopVoiceWorkerMessage[] = [];
    let releaseRequestId: string | undefined;
    let releaseCount = 0;
    const stdin = {
      destroyed: false,
      write(chunk: string) {
        const command = JSON.parse(chunk) as { type: string; requestId: string };
        if (command.type === "capture-release") {
          releaseCount += 1;
          releaseRequestId = command.requestId;
          if (releaseCount > 1) {
            stdout.emit(
              "data",
              Buffer.from(
                `${JSON.stringify({ type: "result", requestId: command.requestId, ok: true })}\n`,
              ),
            );
          }
          return true;
        }
        stdout.emit(
          "data",
          Buffer.from(
            `${JSON.stringify({ type: "result", requestId: command.requestId, ok: true })}\n`,
          ),
        );
        return true;
      },
    };
    const child = Object.assign(new NodeEvents.EventEmitter(), {
      stdin,
      stdout,
      stderr: new NodeEvents.EventEmitter(),
      connected: true,
      killed: false,
      kill() {
        return true;
      },
    });
    const voice = createDesktopJarvisVoice({
      platform: "linux",
      workerPath: "/worker.cjs",
      resourceRoot: "/resources",
      spawn: (() => child) as never,
      emit: (message) => messages.push(message),
    });
    const preparing = voice.prepare();
    stdout.emit("data", Buffer.from('{"type":"ready"}\n'));
    await preparing;

    await expect(
      voice.startCapture({ purpose: "command", captureId: "capture-a" }),
    ).resolves.toEqual({
      accepted: true,
    });
    const releasing = voice.releaseCapture();
    stdout.emit(
      "data",
      Buffer.from(
        '{"type":"transcript","text":"capture a","purpose":"command","captureId":"capture-a"}\n',
      ),
    );
    stdout.emit(
      "data",
      Buffer.from(
        '{"type":"capture-result","ok":true,"text":"capture a","captureId":"capture-a"}\n',
      ),
    );
    await expect(
      voice.startCapture({ purpose: "command", captureId: "capture-b" }),
    ).resolves.toEqual({
      accepted: true,
    });
    expect(releaseRequestId).toBeDefined();
    stdout.emit(
      "data",
      Buffer.from(`${JSON.stringify({ type: "result", requestId: releaseRequestId, ok: true })}\n`),
    );
    await expect(releasing).resolves.toEqual({ accepted: true });
    expect(messages).toContainEqual({
      type: "transcript",
      text: "capture a",
      purpose: "command",
      captureId: "capture-a",
    });

    await expect(voice.releaseCapture()).resolves.toEqual({ accepted: true });
    voice.stop();
  });

  it("keeps a released capture identity until its deferred result arrives", async () => {
    const stdout = new NodeEvents.EventEmitter();
    const messages: DesktopVoiceWorkerMessage[] = [];
    const commands: string[] = [];
    const stdin = {
      destroyed: false,
      write(chunk: string) {
        const command = JSON.parse(chunk) as { type: string; requestId: string };
        commands.push(command.type);
        stdout.emit(
          "data",
          Buffer.from(
            `${JSON.stringify({ type: "result", requestId: command.requestId, ok: true })}\n`,
          ),
        );
        return true;
      },
    };
    const child = Object.assign(new NodeEvents.EventEmitter(), {
      stdin,
      stdout,
      stderr: new NodeEvents.EventEmitter(),
      connected: true,
      killed: false,
      kill() {
        return true;
      },
    });
    const voice = createDesktopJarvisVoice({
      platform: "linux",
      workerPath: "/worker.cjs",
      resourceRoot: "/resources",
      spawn: (() => child) as never,
      emit: (message) => messages.push(message),
    });
    const preparing = voice.prepare();
    stdout.emit("data", Buffer.from('{"type":"ready"}\n'));
    await preparing;

    await expect(
      voice.startCapture({ purpose: "command", captureId: "capture-a" }),
    ).resolves.toEqual({ accepted: true });
    await expect(voice.releaseCapture()).resolves.toEqual({ accepted: true });
    await expect(
      voice.startCapture({ purpose: "command", captureId: "capture-b" }),
    ).resolves.toEqual({ accepted: false });

    stdout.emit(
      "data",
      Buffer.from(
        '{"type":"transcript","text":"capture a","purpose":"command","captureId":"capture-a"}\n',
      ),
    );
    stdout.emit(
      "data",
      Buffer.from(
        '{"type":"capture-result","ok":true,"text":"capture a","captureId":"capture-a"}\n',
      ),
    );
    expect(messages).toContainEqual({
      type: "transcript",
      text: "capture a",
      purpose: "command",
      captureId: "capture-a",
    });
    expect(commands.filter((type) => type === "capture-start")).toHaveLength(1);
    voice.stop();
  });

  it("moves from worker startup to capture and back to ready", async () => {
    const stdout = new NodeEvents.EventEmitter();
    const stdin = {
      destroyed: false,
      write(chunk: string) {
        const command = JSON.parse(chunk) as { requestId: string };
        stdout.emit(
          "data",
          Buffer.from(
            JSON.stringify({ type: "result", requestId: command.requestId, ok: true }) + "\n",
          ),
        );
        return true;
      },
    };
    const child = Object.assign(new NodeEvents.EventEmitter(), {
      stdin,
      stdout,
      stderr: new NodeEvents.EventEmitter(),
      killed: false,
      kill() {
        return true;
      },
    });
    const messages: Array<unknown> = [];
    const levels: number[] = [];
    const voice = createDesktopJarvisVoice({
      platform: "linux",
      workerPath: "/worker.cjs",
      resourceRoot: "/resources",
      spawn: (() => child) as never,
      emit: (message) => messages.push(message),
    });
    voice.onLevel((level) => levels.push(level));
    const preparing = voice.prepare();
    stdout.emit("data", Buffer.from('{"type":"ready"}\n'));
    await preparing;
    expect(voice.getState().status).toBe("ready");
    const starting = voice.startCapture();
    stdout.emit("data", Buffer.from('{"type":"state","state":"starting"}\n'));
    expect(voice.getState().status).toBe("starting");
    stdout.emit("data", Buffer.from('{"type":"state","state":"capturing"}\n'));
    await starting;
    expect(voice.getState().status).toBe("capturing");
    stdout.emit("data", Buffer.from('{"type":"level","level":0.7}\n'));
    expect(levels).toEqual([0.7]);
    stdout.emit(
      "data",
      Buffer.from('{"type":"capture-result","ok":false,"message":"No microphone"}\n'),
    );
    expect(messages).toContainEqual({ type: "error", message: "No microphone" });
    const releasing = voice.releaseCapture();
    stdout.emit("data", Buffer.from('{"type":"state","state":"ready"}\n'));
    await releasing;
    expect(voice.getState().status).toBe("ready");
  });

  it("keeps a command pending when stdin reports a synchronous null callback before its result", async () => {
    const stdout = new NodeEvents.EventEmitter();
    const stdin = {
      destroyed: false,
      write(chunk: string, callback?: (cause?: Error | null) => void) {
        const command = JSON.parse(chunk) as { requestId: string };
        callback?.(null);
        stdout.emit(
          "data",
          Buffer.from(
            JSON.stringify({ type: "result", requestId: command.requestId, ok: true }) + "\n",
          ),
        );
        return true;
      },
    };
    const child = Object.assign(new NodeEvents.EventEmitter(), {
      stdin,
      stdout,
      stderr: new NodeEvents.EventEmitter(),
      killed: false,
      kill() {
        return true;
      },
    });
    const voice = createDesktopJarvisVoice({
      platform: "linux",
      workerPath: "/worker.cjs",
      resourceRoot: "/resources",
      spawn: (() => child) as never,
    });

    const preparing = voice.prepare();
    stdout.emit("data", Buffer.from('{"type":"ready"}\n'));
    await expect(preparing).resolves.toEqual({ status: "ready", native: true });
  });

  it("rejects a command when stdin reports a real write error", async () => {
    const stdout = new NodeEvents.EventEmitter();
    const stdin = {
      destroyed: false,
      write(_chunk: string, callback?: (cause?: Error | null) => void) {
        callback?.(new Error("stdin write failed"));
        return true;
      },
    };
    const child = Object.assign(new NodeEvents.EventEmitter(), {
      stdin,
      stdout,
      stderr: new NodeEvents.EventEmitter(),
      killed: false,
      kill() {
        return true;
      },
    });
    const voice = createDesktopJarvisVoice({
      platform: "linux",
      workerPath: "/worker.cjs",
      resourceRoot: "/resources",
      spawn: (() => child) as never,
    });

    const preparing = voice.prepare();
    stdout.emit("data", Buffer.from('{"type":"ready"}\n'));
    await expect(preparing).rejects.toThrow("stdin write failed");
  });

  it("keeps native capture unavailable when the worker or resources are missing", async () => {
    const voice = createDesktopJarvisVoice({
      platform: "linux",
      workerPath: null,
      resourceRoot: null,
    });

    expect(voice.getState()).toEqual({ status: "unavailable", native: true });
    expect(await voice.startCapture()).toEqual({ accepted: false });
    expect(voice.getState()).toEqual({ status: "unavailable", native: true });

    const windowsVoice = createDesktopJarvisVoice({
      platform: "win32",
      workerPath: "/worker.cjs",
      resourceRoot: null,
    });
    expect(windowsVoice.getState()).toEqual({ status: "unavailable", native: true });
    expect(await windowsVoice.startCapture()).toEqual({ accepted: false });
  });

  it("ignores late worker events after stop", async () => {
    const stdout = new NodeEvents.EventEmitter();
    const child = Object.assign(new NodeEvents.EventEmitter(), {
      stdin: { destroyed: false, write: () => true },
      stdout,
      stderr: new NodeEvents.EventEmitter(),
      killed: false,
      kill() {
        this.killed = true;
        return true;
      },
    });
    const messages: unknown[] = [];
    const voice = createDesktopJarvisVoice({
      platform: "win32",
      workerPath: "/worker.cjs",
      resourceRoot: "/resources",
      spawn: (() => child) as never,
      emit: (message) => messages.push(message),
    });
    voice.stop();
    stdout.emit("data", Buffer.from('{"type":"state","state":"ready"}\n'));
    expect(messages).toEqual([]);
  });

  it("does not throw while broadcasting to a destroyed renderer", () => {
    const send = vi.fn(() => {
      throw new Error("renderer gone");
    });
    const destroyed = {
      isDestroyed: () => true,
      webContents: { send },
    } as never;
    const live = {
      isDestroyed: () => false,
      webContents: { send },
    } as never;
    expect(() =>
      broadcastDesktopJarvisVoiceMessage({
        message: { type: "transcript", text: "hello", purpose: "diagnostic", captureId: "cap-1" },
        native: true,
        windows: [destroyed, live],
      }),
    ).not.toThrow();
    expect(send).toHaveBeenCalledWith(expect.any(String), {
      text: "hello",
      purpose: "diagnostic",
      captureId: "cap-1",
    });
  });
});
