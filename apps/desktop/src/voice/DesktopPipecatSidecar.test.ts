import * as NodeEvents from "node:events";

import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

import { createDesktopPipecatSidecar } from "./DesktopPipecatSidecar.ts";
import { DESKTOP_PIPECAT_PROTOCOL_VERSION } from "./DesktopPipecatProtocol.ts";

type FakeChild = ReturnType<typeof fakeChild>;

function fakeChild(input: { readonly acknowledge?: boolean } = {}) {
  const stdout = new NodeEvents.EventEmitter();
  const stderr = new NodeEvents.EventEmitter();
  const processEvents = new NodeEvents.EventEmitter();
  const commands: Array<Record<string, unknown>> = [];
  let killed = false;
  const child = {
    stdin: {
      destroyed: false,
      write(line: string, callback?: (cause?: Error | null) => void) {
        const command = JSON.parse(line) as Record<string, unknown>;
        commands.push(command);
        callback?.(null);
        if (input.acknowledge !== false) {
          queueMicrotask(() =>
            stdout.emit(
              "data",
              `${JSON.stringify({ type: "result", requestId: command.requestId, ok: true })}\n`,
            ),
          );
        }
        return true;
      },
      once: vi.fn(),
    },
    stdout,
    stderr,
    get killed() {
      return killed;
    },
    kill: vi.fn(() => {
      killed = true;
      return true;
    }),
    once: processEvents.once.bind(processEvents),
    emitProcess: processEvents.emit.bind(processEvents),
    commands,
  };
  return child;
}

function ready(child: FakeChild): void {
  child.stdout.emit(
    "data",
    `${JSON.stringify({ type: "ready", version: DESKTOP_PIPECAT_PROTOCOL_VERSION })}\n`,
  );
}

function blockCommand(child: FakeChild, blockedType: string): void {
  const originalWrite = child.stdin.write;
  child.stdin.write = (line, callback) => {
    const command = JSON.parse(line) as Record<string, unknown>;
    if (command.type === blockedType) {
      child.commands.push(command);
      callback?.(null);
      return true;
    }
    return originalWrite(line, callback);
  };
}

describe("Desktop Pipecat sidecar", () => {
  it("remembers release while capture startup is awaiting acknowledgement", async () => {
    const child = fakeChild();
    const start = sidecarWithDelayedCaptureStart(child);
    const preparing = start.sidecar.ensureReady();
    ready(child);
    await preparing;
    const starting = start.sidecar.startCapture({
      captureId: "capture-1",
      sampleRate: 16_000,
      channels: 1,
      contextualPhrases: [],
    });
    await vi.waitFor(() =>
      expect(start.commands.map((command) => command.type)).toEqual(["capture-start"]),
    );
    const releasing = start.sidecar.releaseCapture("capture-1");
    await Promise.resolve();

    start.acknowledgeCaptureStart();
    const startedCapture = await starting;
    void startedCapture.result.catch(() => undefined);
    await expect(releasing).resolves.toBe(true);
    expect(start.commands.map((command) => command.type)).toEqual([
      "capture-start",
      "capture-release",
    ]);
    await start.sidecar.shutdown();
  });

  it("remembers cancel while capture startup is awaiting acknowledgement", async () => {
    const child = fakeChild();
    const start = sidecarWithDelayedCaptureStart(child);
    const preparing = start.sidecar.ensureReady();
    ready(child);
    await preparing;
    const starting = start.sidecar.startCapture({
      captureId: "capture-1",
      sampleRate: 16_000,
      channels: 1,
      contextualPhrases: [],
    });
    await vi.waitFor(() =>
      expect(start.commands.map((command) => command.type)).toEqual(["capture-start"]),
    );
    const cancelling = start.sidecar.cancelCapture("capture-1");

    start.acknowledgeCaptureStart();
    const startedCapture = await starting;
    void startedCapture.result.catch(() => undefined);
    await expect(cancelling).resolves.toBe(true);
    expect(start.commands.map((command) => command.type)).toEqual([
      "capture-start",
      "capture-cancel",
    ]);
    await start.sidecar.shutdown();
  });

  it("bounds queued PCM and returns a failure before retaining more audio", async () => {
    const child = fakeChild();
    const sidecar = createDesktopPipecatSidecar({
      executablePath: "runtime",
      modelRoot: "models",
      spawn: vi.fn(() => child) as never,
    });
    const preparing = sidecar.ensureReady();
    ready(child);
    await preparing;
    await sidecar.startCapture({
      captureId: "capture-1",
      sampleRate: 16_000,
      channels: 1,
      contextualPhrases: [],
    });

    await expect(
      sidecar.pushPcm({
        captureId: "capture-1",
        sampleRate: 16_000,
        channels: 1,
        samples: new Float32Array(300_000),
      }),
    ).resolves.toBe(false);
    expect(child.commands.filter((command) => command.type === "pcm")).toHaveLength(0);
    await expect(sidecar.cancelCapture("capture-1")).resolves.toBe(true);
  });

  it("fails the capture instead of rejecting on a malformed PCM frame", async () => {
    const child = fakeChild();
    const sidecar = createDesktopPipecatSidecar({
      executablePath: "runtime",
      modelRoot: "models",
      spawn: vi.fn(() => child) as never,
    });
    const preparing = sidecar.ensureReady();
    ready(child);
    await preparing;
    await sidecar.startCapture({
      captureId: "capture-1",
      sampleRate: 16_000,
      channels: 1,
      contextualPhrases: [],
    });

    // Three samples cannot form complete stereo frames.
    await expect(
      sidecar.pushPcm({
        captureId: "capture-1",
        sampleRate: 16_000,
        channels: 2,
        samples: new Float32Array(3),
      }),
    ).resolves.toBe(false);
    expect(child.commands.filter((command) => command.type === "pcm")).toHaveLength(0);
    // The failure sticks for later pushes, but the boolean contract holds.
    await expect(
      sidecar.pushPcm({
        captureId: "capture-1",
        sampleRate: 16_000,
        channels: 1,
        samples: new Float32Array(4),
      }),
    ).resolves.toBe(false);
    // Release still runs remote cleanup instead of rejecting.
    await expect(sidecar.releaseCapture("capture-1")).resolves.toBe(true);
    await sidecar.cancelCapture("capture-1");
  });

  it("streams the full public 15-second PCM limit through the bounded queue", async () => {
    const child = fakeChild();
    const sidecar = createDesktopPipecatSidecar({
      executablePath: "runtime",
      modelRoot: "models",
      spawn: vi.fn(() => child) as never,
    });
    const preparing = sidecar.ensureReady();
    ready(child);
    await preparing;

    const transcription = sidecar.transcribe({
      audio: new Uint8Array(2_880_000),
      sampleRate: 48_000,
      channels: 2,
    });
    await vi.waitFor(() =>
      expect(child.commands.map((command) => command.type)).toContain("capture-release"),
    );
    const captureId = child.commands.find((command) => command.type === "capture-start")?.captureId;
    expect(child.commands.filter((command) => command.type === "pcm").length).toBeGreaterThan(1);
    child.stdout.emit(
      "data",
      `${JSON.stringify({ type: "capture-result", captureId, ok: true, text: "full utterance" })}\n`,
    );

    await expect(transcription).resolves.toBe("full utterance");
    await sidecar.shutdown();
  });

  it("collects ordered remote synthesis PCM", async () => {
    const child = fakeChild();
    const sidecar = createDesktopPipecatSidecar({
      executablePath: "runtime",
      modelRoot: "models",
      spawn: vi.fn(() => child) as never,
    });
    const preparing = sidecar.ensureReady();
    ready(child);
    await preparing;

    const synthesis = sidecar.synthesize("Ready.");
    await vi.waitFor(() =>
      expect(child.commands.map((command) => command.type)).toContain("synthesis-start"),
    );
    const synthesisId = child.commands.find(
      (command) => command.type === "synthesis-start",
    )?.synthesisId;
    child.stdout.emit(
      "data",
      `${JSON.stringify({
        type: "synthesis-audio",
        synthesisId,
        sequence: 0,
        sampleRate: 24_000,
        channels: 1,
        data: Buffer.from([1, 0, 2, 0]).toString("base64"),
      })}\n`,
    );
    child.stdout.emit(
      "data",
      `${JSON.stringify({
        type: "synthesis-result",
        synthesisId,
        ok: true,
        sampleRate: 24_000,
        channels: 1,
        audioBytes: 4,
        timing: {
          engineId: "kokoro-int8",
          start: "cold",
          warmupMs: 100,
          firstChunkReadyMs: 250,
          synthesisMs: 300,
          totalMs: 400,
          synthesisCpuMs: 280,
          peakRssBytes: 720_000_000,
          currentRssBytes: 700_000_000,
          chunkCount: 1,
        },
      })}\n`,
    );

    await expect(synthesis).resolves.toEqual({
      sampleRate: 24_000,
      channels: 1,
      pcm: Buffer.from([1, 0, 2, 0]),
      timing: {
        engineId: "kokoro-int8",
        start: "cold",
        warmupMs: 100,
        firstChunkReadyMs: 250,
        synthesisMs: 300,
        totalMs: 400,
        synthesisCpuMs: 280,
        peakRssBytes: 720_000_000,
        currentRssBytes: 700_000_000,
        chunkCount: 1,
      },
    });
    await sidecar.shutdown();
  });

  it("cancels immediately without writing PCM that was queued behind an acknowledgement", async () => {
    const child = fakeChild();
    const sidecar = createDesktopPipecatSidecar({
      executablePath: "runtime",
      modelRoot: "models",
      spawn: vi.fn(() => child) as never,
    });
    const preparing = sidecar.ensureReady();
    ready(child);
    await preparing;
    await sidecar.startCapture({
      captureId: "capture-1",
      sampleRate: 16_000,
      channels: 1,
      contextualPhrases: [],
    });
    const originalWrite = child.stdin.write;
    let acknowledgePcm!: () => void;
    child.stdin.write = (line, callback) => {
      const command = JSON.parse(line) as Record<string, unknown>;
      if (command.type === "pcm") {
        child.commands.push(command);
        acknowledgePcm = () => {
          child.stdout.emit(
            "data",
            `${JSON.stringify({ type: "result", requestId: command.requestId, ok: true })}\n`,
          );
        };
        callback?.(null);
        return true;
      }
      return originalWrite(line, callback);
    };

    const firstPcm = sidecar.pushPcm({
      captureId: "capture-1",
      sampleRate: 16_000,
      channels: 1,
      samples: new Float32Array(160),
    });
    const queuedPcm = sidecar.pushPcm({
      captureId: "capture-1",
      sampleRate: 16_000,
      channels: 1,
      samples: new Float32Array(160),
    });
    await vi.waitFor(() =>
      expect(child.commands.map((command) => command.type)).toEqual(["capture-start", "pcm"]),
    );
    await expect(sidecar.cancelCapture("capture-1")).resolves.toBe(true);
    acknowledgePcm();

    await expect(firstPcm).resolves.toBe(true);
    await expect(queuedPcm).resolves.toBe(false);
    expect(child.commands.map((command) => command.type)).toEqual([
      "capture-start",
      "pcm",
      "capture-cancel",
    ]);
  });

  it("correlates raw transcripts, timing, and monotonically sequenced PCM", async () => {
    const child = fakeChild();
    const sidecar = createDesktopPipecatSidecar({
      executablePath: "/runtime/jarvis-pipecat-voice",
      modelRoot: "/models/parakeet",
      spawn: vi.fn(() => child) as never,
    });
    const preparing = sidecar.ensureReady();
    ready(child);
    await preparing;
    const transcripts: string[] = [];
    const timings: unknown[] = [];
    const capture = await sidecar.startCapture({
      captureId: "capture-1",
      sampleRate: 16_000,
      channels: 1,
      contextualPhrases: ["Zivil"],
      onTranscript: (text) => transcripts.push(text),
      onTiming: (timing) => timings.push(timing),
    });
    await sidecar.pushPcm({
      captureId: "capture-1",
      sampleRate: 16_000,
      channels: 1,
      samples: new Float32Array(50_000),
    });
    expect(
      child.commands.filter((command) => command.type === "pcm").map((command) => command.sequence),
    ).toEqual([0, 1, 2]);
    child.stdout.emit(
      "data",
      `${JSON.stringify({ type: "transcript", captureId: "capture-1", text: "check out Zivil" })}\n`,
    );
    child.stdout.emit(
      "data",
      `${JSON.stringify({ type: "capture-result", captureId: "capture-1", ok: true, text: "check out Zivil" })}\n`,
    );
    await expect(capture.result).resolves.toEqual({ ok: true, text: "check out Zivil" });
    expect(transcripts).toEqual(["check out Zivil"]);
    expect(timings).toEqual([]);
  });

  it("settles speech when the Pipecat host reports native playout completed", async () => {
    const child = fakeChild();
    const sidecar = createDesktopPipecatSidecar({
      executablePath: "runtime",
      modelRoot: "models",
      spawn: vi.fn(() => child) as never,
    });
    const preparing = sidecar.ensureReady();
    ready(child);
    await preparing;
    const speech = sidecar.speak({
      speechId: "speech-1",
      text: "Ready.",
    });
    await vi.waitFor(() =>
      expect(child.commands.map((command) => command.type)).toContain("speech-start"),
    );
    child.stdout.emit(
      "data",
      `${JSON.stringify({ type: "speech-result", speechId: "speech-1", status: "completed" })}\n`,
    );
    await expect(speech).resolves.toEqual({ status: "completed" });
    expect(child.commands.map((command) => command.type)).not.toContain("speech-audio-consumed");
    expect(child.commands.map((command) => command.type)).not.toContain("speech-playout-drained");
    await sidecar.shutdown();
  });

  it("returns Pipecat speech failure classification instead of rejecting it", async () => {
    const child = fakeChild();
    const sidecar = createDesktopPipecatSidecar({
      executablePath: "runtime",
      modelRoot: "models",
      spawn: vi.fn(() => child) as never,
    });
    const preparing = sidecar.ensureReady();
    ready(child);
    await preparing;
    const speech = sidecar.speak({
      speechId: "speech-failure",
      text: "This will not play.",
    });
    await vi.waitFor(() =>
      expect(child.commands.map((command) => command.type)).toContain("speech-start"),
    );
    child.stdout.emit(
      "data",
      `${JSON.stringify({
        type: "speech-result",
        speechId: "speech-failure",
        status: "failure",
        message: "PipeWire rejected the audio stream.",
        code: "speech-output-backpressure",
      })}\n`,
    );
    await expect(speech).resolves.toEqual({
      status: "failure",
      message: "PipeWire rejected the audio stream.",
      code: "speech-output-backpressure",
    });
    await sidecar.shutdown();
  });

  it("cancels speech by ID and settles from the interrupted result", async () => {
    const child = fakeChild();
    const sidecar = createDesktopPipecatSidecar({
      executablePath: "runtime",
      modelRoot: "models",
      spawn: vi.fn(() => child) as never,
    });
    const preparing = sidecar.ensureReady();
    ready(child);
    await preparing;
    const speech = sidecar.speak({
      speechId: "speech-2",
      text: "Stop.",
    });
    await vi.waitFor(() =>
      expect(child.commands.map((command) => command.type)).toContain("speech-start"),
    );
    await expect(sidecar.cancelSpeech("speech-2")).resolves.toBe(true);
    child.stdout.emit(
      "data",
      `${JSON.stringify({ type: "speech-result", speechId: "speech-2", status: "interrupted" })}\n`,
    );
    await expect(speech).resolves.toEqual({ status: "interrupted" });
    expect(child.commands.map((command) => command.type)).toContain("speech-cancel");
    await sidecar.shutdown();
  });

  it("fails an active capture on crash and starts a clean replacement process", async () => {
    const first = fakeChild();
    const second = fakeChild();
    const spawn = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const sidecar = createDesktopPipecatSidecar({
      executablePath: "runtime",
      modelRoot: "models",
      spawn,
    });
    const firstReady = sidecar.ensureReady();
    ready(first);
    await firstReady;
    const capture = await sidecar.startCapture({
      captureId: "capture-1",
      sampleRate: 16_000,
      channels: 1,
      contextualPhrases: [],
    });
    first.stderr.emit("data", "native loader failed");
    first.emitProcess("exit", 1);
    await expect(capture.result).rejects.toThrow(/native loader failed/u);
    const replacementReady = sidecar.ensureReady();
    ready(second);
    await replacementReady;
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("times out startup and command acknowledgement without retaining stale state", async () => {
    vi.useFakeTimers();
    try {
      const startupChild = fakeChild();
      const replacementChild = fakeChild();
      const spawn = vi.fn().mockReturnValueOnce(startupChild).mockReturnValueOnce(replacementChild);
      const sidecar = createDesktopPipecatSidecar({
        executablePath: "runtime",
        modelRoot: "models",
        spawn,
        startupTimeoutMs: 10,
        backpressureTimeoutMs: 10,
      });
      const startup = sidecar.ensureReady();
      const startupFailure = expect(startup).rejects.toThrow(/did not become ready/u);
      await vi.advanceTimersByTimeAsync(11);
      await startupFailure;
      const replacement = sidecar.ensureReady();
      ready(replacementChild);
      await replacement;
      startupChild.emitProcess("exit", 1);
      await expect(
        sidecar.startCapture({
          captureId: "capture-1",
          sampleRate: 16_000,
          channels: 1,
          contextualPhrases: [],
        }),
      ).resolves.toBeDefined();

      const commandChild = fakeChild({ acknowledge: false });
      const commandSidecar = createDesktopPipecatSidecar({
        executablePath: "runtime",
        modelRoot: "models",
        spawn: vi.fn(() => commandChild) as never,
        startupTimeoutMs: 10,
        backpressureTimeoutMs: 10,
        modelTransitionTimeoutMs: 10,
      });
      const commandReady = commandSidecar.ensureReady();
      ready(commandChild);
      await commandReady;
      const start = commandSidecar.startCapture({
        captureId: "capture-1",
        sampleRate: 16_000,
        channels: 1,
        contextualPhrases: [],
      });
      const startFailure = expect(start).rejects.toThrow(/could not start/u);
      await vi.advanceTimersByTimeAsync(11);
      await startFailure;
      expect(commandChild.kill).toHaveBeenCalledWith("SIGTERM");
    } finally {
      vi.useRealTimers();
    }
  });

  it("restarts after a timed-out speech start instead of leaving orphaned synthesis", async () => {
    vi.useFakeTimers();
    try {
      const first = fakeChild({ acknowledge: false });
      const replacement = fakeChild();
      const spawn = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(replacement);
      const sidecar = createDesktopPipecatSidecar({
        executablePath: "runtime",
        modelRoot: "models",
        spawn,
        backpressureTimeoutMs: 10,
        modelTransitionTimeoutMs: 10,
      });
      const preparing = sidecar.ensureReady();
      ready(first);
      await preparing;
      const speech = sidecar.speak({
        speechId: "speech-timeout",
        text: "Do not become orphaned.",
      });
      const failure = expect(speech).rejects.toThrow(/could not start/u);

      await vi.advanceTimersByTimeAsync(11);

      await failure;
      expect(first.kill).toHaveBeenCalledWith("SIGTERM");
      const replacementReady = sidecar.ensureReady();
      ready(replacement);
      await replacementReady;
      expect(spawn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears command timers as soon as their correlated result arrives", async () => {
    vi.useFakeTimers();
    try {
      const child = fakeChild();
      const sidecar = createDesktopPipecatSidecar({
        executablePath: "runtime",
        modelRoot: "models",
        spawn: vi.fn(() => child) as never,
      });
      const preparing = sidecar.ensureReady();
      ready(child);
      await preparing;

      await sidecar.startCapture({
        captureId: "capture-timer",
        sampleRate: 16_000,
        channels: 1,
        contextualPhrases: [],
      });

      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["capture-release", "releaseCapture"],
    ["capture-cancel", "cancelCapture"],
  ] as const)("restarts after a timed-out %s command", async (commandType, method) => {
    vi.useFakeTimers();
    try {
      const first = fakeChild();
      const replacement = fakeChild();
      const spawn = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(replacement);
      const sidecar = createDesktopPipecatSidecar({
        executablePath: "runtime",
        modelRoot: "models",
        spawn,
        backpressureTimeoutMs: 10,
      });
      const preparing = sidecar.ensureReady();
      ready(first);
      await preparing;
      await sidecar.startCapture({
        captureId: "capture-timeout",
        sampleRate: 16_000,
        channels: 1,
        contextualPhrases: [],
      });
      blockCommand(first, commandType);

      const result = sidecar[method]("capture-timeout");
      await vi.advanceTimersByTimeAsync(11);

      await expect(result).resolves.toBe(false);
      expect(first.kill).toHaveBeenCalledWith("SIGTERM");
      const replacementReady = sidecar.ensureReady();
      ready(replacement);
      await replacementReady;
      expect(spawn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["speech-prepare", "prepareSpeech"],
    ["listening-prepare", "prepareListening"],
  ] as const)("restarts after a timed-out %s command", async (commandType, method) => {
    vi.useFakeTimers();
    try {
      const first = fakeChild();
      const replacement = fakeChild();
      const spawn = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(replacement);
      const sidecar = createDesktopPipecatSidecar({
        executablePath: "runtime",
        modelRoot: "models",
        spawn,
        backpressureTimeoutMs: 10,
        modelTransitionTimeoutMs: 10,
      });
      const preparing = sidecar.ensureReady();
      ready(first);
      await preparing;
      blockCommand(first, commandType);

      const result = sidecar[method]();
      await vi.advanceTimersByTimeAsync(11);

      await expect(result).resolves.toBe(false);
      expect(first.kill).toHaveBeenCalledWith("SIGTERM");
      const replacementReady = sidecar.ensureReady();
      ready(replacement);
      await replacementReady;
      expect(spawn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("restarts after a timed-out PCM acknowledgement", async () => {
    vi.useFakeTimers();
    try {
      const first = fakeChild();
      const replacement = fakeChild();
      const spawn = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(replacement);
      const sidecar = createDesktopPipecatSidecar({
        executablePath: "runtime",
        modelRoot: "models",
        spawn,
        backpressureTimeoutMs: 10,
      });
      const preparing = sidecar.ensureReady();
      ready(first);
      await preparing;
      await sidecar.startCapture({
        captureId: "capture-pcm-timeout",
        sampleRate: 16_000,
        channels: 1,
        contextualPhrases: [],
      });
      blockCommand(first, "pcm");

      const result = sidecar.pushPcm({
        captureId: "capture-pcm-timeout",
        sampleRate: 16_000,
        channels: 1,
        samples: new Float32Array([0.1, -0.1]),
      });
      await vi.advanceTimersByTimeAsync(11);

      await expect(result).resolves.toBe(false);
      expect(first.kill).toHaveBeenCalledWith("SIGTERM");
      const replacementReady = sidecar.ensureReady();
      ready(replacement);
      await replacementReady;
      expect(spawn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("terminates a sidecar that emits an oversized unterminated record", async () => {
    const child = fakeChild();
    const sidecar = createDesktopPipecatSidecar({
      executablePath: "runtime",
      modelRoot: "models",
      spawn: vi.fn(() => child) as never,
    });
    const preparing = sidecar.ensureReady();
    ready(child);
    await preparing;

    child.stdout.emit("data", "x".repeat(300_000));

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    await expect(sidecar.ensureReady()).rejects.toThrow(/oversized/u);
  });

  it("terminates a sidecar that emits malformed protocol output", async () => {
    const child = fakeChild();
    const sidecar = createDesktopPipecatSidecar({
      executablePath: "runtime",
      modelRoot: "models",
      spawn: vi.fn(() => child) as never,
    });
    const preparing = sidecar.ensureReady();
    ready(child);
    await preparing;

    child.stdout.emit("data", "not-json\n");

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    await expect(sidecar.ensureReady()).rejects.toThrow(/malformed JSON/u);
  });

  it("allows model preparation to exceed the short PCM acknowledgement budget", async () => {
    vi.useFakeTimers();
    try {
      const child = fakeChild();
      const originalWrite = child.stdin.write;
      let acknowledgePreparation!: () => void;
      child.stdin.write = (line, callback) => {
        const command = JSON.parse(line) as Record<string, unknown>;
        if (command.type === "speech-prepare") {
          child.commands.push(command);
          callback?.(null);
          acknowledgePreparation = () => {
            child.stdout.emit(
              "data",
              `${JSON.stringify({ type: "result", requestId: command.requestId, ok: true })}\n`,
            );
          };
          return true;
        }
        return originalWrite(line, callback);
      };
      const sidecar = createDesktopPipecatSidecar({
        executablePath: "runtime",
        modelRoot: "models",
        spawn: vi.fn(() => child) as never,
        backpressureTimeoutMs: 10,
        modelTransitionTimeoutMs: 100,
      });
      const readyPromise = sidecar.ensureReady();
      ready(child);
      await readyPromise;
      const preparation = sidecar.prepareSpeech();
      await vi.advanceTimersByTimeAsync(11);
      expect(child.commands.map((command) => command.type)).toEqual(["speech-prepare"]);
      let settled = false;
      void preparation.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      acknowledgePreparation();
      await expect(preparation).resolves.toBe(true);
      await sidecar.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  it("allows listening preparation to exceed the short backpressure budget", async () => {
    vi.useFakeTimers();
    try {
      const child = fakeChild();
      const originalWrite = child.stdin.write;
      let acknowledgePreparation!: () => void;
      child.stdin.write = (line, callback) => {
        const command = JSON.parse(line) as Record<string, unknown>;
        if (command.type === "listening-prepare") {
          child.commands.push(command);
          callback?.(null);
          acknowledgePreparation = () => {
            child.stdout.emit(
              "data",
              `${JSON.stringify({ type: "result", requestId: command.requestId, ok: true })}\n`,
            );
          };
          return true;
        }
        return originalWrite(line, callback);
      };
      const sidecar = createDesktopPipecatSidecar({
        executablePath: "runtime",
        modelRoot: "models",
        spawn: vi.fn(() => child) as never,
        backpressureTimeoutMs: 2_000,
        modelTransitionTimeoutMs: 10_000,
      });
      const readyPromise = sidecar.ensureReady();
      ready(child);
      await readyPromise;
      const preparation = sidecar.prepareListening();
      await vi.advanceTimersByTimeAsync(2_001);
      expect(child.commands.map((command) => command.type)).toEqual(["listening-prepare"]);
      let settled = false;
      void preparation.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      acknowledgePreparation();
      await expect(preparation).resolves.toBe(true);
      await sidecar.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });
});

function sidecarWithDelayedCaptureStart(child: FakeChild) {
  let acknowledgeCaptureStart!: () => void;
  const sidecar = createDesktopPipecatSidecar({
    executablePath: "runtime",
    modelRoot: "models",
    spawn: vi.fn(() => child) as never,
  });
  const originalWrite = child.stdin.write;
  child.stdin.write = (line, callback) => {
    const command = JSON.parse(line) as Record<string, unknown>;
    if (command.type === "capture-start") {
      child.commands.push(command);
      acknowledgeCaptureStart = () => {
        child.stdout.emit(
          "data",
          `${JSON.stringify({ type: "result", requestId: command.requestId, ok: true })}\n`,
        );
      };
      callback?.(null);
      return true;
    }
    return originalWrite(line, callback);
  };
  return {
    sidecar,
    commands: child.commands,
    acknowledgeCaptureStart: () => acknowledgeCaptureStart(),
  };
}
