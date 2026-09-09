import { describe, expect, it, vi } from "vite-plus/test";

import { createDesktopJarvisVoice } from "./DesktopJarvisVoice.ts";

function makeFakeSpawn() {
  const sent: Array<{ readonly type: string; readonly requestId: string }> = [];
  const stdoutHandlers = new Map<string, Array<(chunk: Buffer) => void>>();
  const child = {
    stdin: {
      destroyed: false,
      write: (data: string, callback?: (cause?: Error | null) => void): boolean => {
        for (const line of data.split("\n")) {
          if (line.trim().length === 0) continue;
          sent.push(JSON.parse(line) as { readonly type: string; readonly requestId: string });
        }
        callback?.(null);
        return true;
      },
    },
    stdout: {
      on: (event: string, handler: (chunk: Buffer) => void): void => {
        const handlers = stdoutHandlers.get(event) ?? [];
        handlers.push(handler);
        stdoutHandlers.set(event, handlers);
      },
    },
    stderr: { on: (): void => undefined },
    once: (): void => undefined,
    kill: (): void => undefined,
    killed: false,
    connected: true,
  };
  const emitLine = (line: string): void => {
    for (const handler of stdoutHandlers.get("data") ?? []) handler(Buffer.from(`${line}\n`));
  };
  const spawn = vi.fn(() => child);
  return { spawn, sent, emitLine };
}

describe("desktop voice receipt cue at capture release", () => {
  it("plays the local receipt cue without waiting for worker inference", async () => {
    const fake = makeFakeSpawn();
    const cueCalls: Array<string> = [];
    const voice = createDesktopJarvisVoice({
      platform: "linux",
      architecture: "x64",
      workerPath: "/worker.cjs",
      resourceRoot: "/resources",
      executablePath: "/exe",
      spawn: fake.spawn as never,
      playReceiptCue: async () => {
        cueCalls.push("receipt");
      },
      emit: () => undefined,
    });

    const starting = voice.startCapture({ purpose: "command", captureId: "receipt-1" });
    await vi.waitFor(() => expect(fake.spawn).toHaveBeenCalled());
    fake.emitLine(`{"type":"ready"}`);
    await vi.waitFor(() =>
      expect(fake.sent.map((command) => command.type)).toEqual(["capture-start"]),
    );
    fake.emitLine(`{"type":"result","requestId":"${fake.sent[0]!.requestId}","ok":true}`);
    await expect(starting).resolves.toEqual({ accepted: true });

    const releasing = voice.releaseCapture();
    // The cue fires synchronously with release, before the worker answers
    // and before any transcript/inference arrives.
    await vi.waitFor(() => expect(cueCalls).toEqual(["receipt"]));
    expect(fake.sent.map((command) => command.type)).toContain("capture-release");
    // Local receipt only: release never synthesizes speech or remote audio.
    expect(fake.sent.map((command) => command.type)).not.toContain("speak");
    expect(fake.sent.map((command) => command.type)).not.toContain("remote-synthesize");
    expect(fake.sent.map((command) => command.type)).not.toContain("play-acknowledgement");
    fake.emitLine(`{"type":"result","requestId":"${fake.sent[1]!.requestId}","ok":true}`);
    await expect(releasing).resolves.toEqual({ accepted: true });
    voice.stop();
  });

  it("still releases when the receipt cue player is missing", async () => {
    const fake = makeFakeSpawn();
    const voice = createDesktopJarvisVoice({
      platform: "linux",
      architecture: "x64",
      workerPath: "/worker.cjs",
      resourceRoot: "/resources",
      executablePath: "/exe",
      spawn: fake.spawn as never,
      playReceiptCue: async () => {
        throw new Error("pw-play is not installed.");
      },
      emit: () => undefined,
    });

    const starting = voice.startCapture({ purpose: "command", captureId: "receipt-missing" });
    await vi.waitFor(() => expect(fake.spawn).toHaveBeenCalled());
    fake.emitLine(`{"type":"ready"}`);
    await vi.waitFor(() =>
      expect(fake.sent.map((command) => command.type)).toEqual(["capture-start"]),
    );
    fake.emitLine(`{"type":"result","requestId":"${fake.sent[0]!.requestId}","ok":true}`);
    await expect(starting).resolves.toEqual({ accepted: true });

    const releasing = voice.releaseCapture();
    await vi.waitFor(() =>
      expect(fake.sent.map((command) => command.type)).toEqual([
        "capture-start",
        "capture-release",
      ]),
    );
    fake.emitLine(`{"type":"result","requestId":"${fake.sent[1]!.requestId}","ok":true}`);
    await expect(releasing).resolves.toEqual({ accepted: true });
    voice.stop();
  });
});

describe("desktop voice model release without interrupting remote compute", () => {
  it("refuses to release models while remote compute is active and lets it finish", async () => {
    const fake = makeFakeSpawn();
    const voice = createDesktopJarvisVoice({
      platform: "linux",
      architecture: "x64",
      workerPath: "/worker.cjs",
      resourceRoot: "/resources",
      executablePath: "/exe",
      spawn: fake.spawn as never,
      emit: () => undefined,
    });
    await vi.waitFor(() => expect(fake.spawn).not.toHaveBeenCalled());

    // Start remote transcription through the worker and hold its result.
    const remote = voice.transcribeRemote({
      format: "pcm-s16le",
      audioBase64: "AAAA",
      sampleRate: 16_000,
      channels: 1,
    });
    await vi.waitFor(() => expect(fake.spawn).toHaveBeenCalled());
    fake.emitLine(`{"type":"ready"}`);
    await vi.waitFor(() =>
      expect(fake.sent.map((command) => command.type)).toEqual(["remote-transcribe"]),
    );

    // A disable path must not interrupt the other client's compute.
    await expect(voice.releaseVoiceModels()).resolves.toEqual({ accepted: false });
    expect(fake.sent.map((command) => command.type)).not.toContain("release-models");

    const remoteCommand = fake.sent[0]!;
    fake.emitLine(
      `{"type":"result","requestId":"${remoteCommand.requestId}","ok":true,` +
        `"compute":{"operation":"transcribe","text":"hello"}}`,
    );
    await expect(remote).resolves.toBe("hello");
    voice.stop();
  });

  it("releases idle models through the worker without killing it", async () => {
    const fake = makeFakeSpawn();
    const voice = createDesktopJarvisVoice({
      platform: "linux",
      architecture: "x64",
      workerPath: "/worker.cjs",
      resourceRoot: "/resources",
      executablePath: "/exe",
      spawn: fake.spawn as never,
      emit: () => undefined,
    });

    // Start the worker first: an idle release talks to the live worker, while
    // a never-started worker resolves without spawning a process to release.
    const preparing = voice.prepare();
    await vi.waitFor(() => expect(fake.spawn).toHaveBeenCalledTimes(1));
    fake.emitLine(`{"type":"ready"}`);
    await vi.waitFor(() => expect(fake.sent.map((command) => command.type)).toEqual(["prepare"]));
    fake.emitLine(`{"type":"result","requestId":"${fake.sent[0]!.requestId}","ok":true}`);
    await expect(preparing).resolves.toMatchObject({ status: "ready" });

    const releasing = voice.releaseVoiceModels();
    await vi.waitFor(() =>
      expect(fake.sent.map((command) => command.type)).toEqual(["prepare", "release-models"]),
    );
    fake.emitLine(`{"type":"result","requestId":"${fake.sent[1]!.requestId}","ok":true}`);
    await expect(releasing).resolves.toEqual({ accepted: true });
    // The worker stays alive: a later capture still uses the same process.
    const starting = voice.startCapture({ purpose: "command", captureId: "after-release" });
    await vi.waitFor(() =>
      expect(fake.sent.map((command) => command.type)).toEqual([
        "prepare",
        "release-models",
        "capture-start",
      ]),
    );
    expect(fake.spawn).toHaveBeenCalledTimes(1);
    fake.emitLine(`{"type":"result","requestId":"${fake.sent[2]!.requestId}","ok":true}`);
    await expect(starting).resolves.toEqual({ accepted: true });
    voice.stop();
  });

  it("resolves without spawning when the worker never started", async () => {
    const fake = makeFakeSpawn();
    const voice = createDesktopJarvisVoice({
      platform: "linux",
      architecture: "x64",
      workerPath: "/worker.cjs",
      resourceRoot: "/resources",
      executablePath: "/exe",
      spawn: fake.spawn as never,
      emit: () => undefined,
    });

    await expect(voice.releaseVoiceModels()).resolves.toEqual({ accepted: true });
    expect(fake.spawn).not.toHaveBeenCalled();
    voice.stop();
  });
});
