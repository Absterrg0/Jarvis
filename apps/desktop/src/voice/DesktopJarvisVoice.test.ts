import { describe, expect, it, vi } from "vite-plus/test";

import { createDesktopJarvisVoice } from "./DesktopJarvisVoice.ts";

interface SentCommand {
  readonly type: string;
  readonly requestId: string;
}

function makeFakeSpawn() {
  const sent: Array<SentCommand> = [];
  const stdoutHandlers = new Map<string, Array<(chunk: Buffer) => void>>();
  const child = {
    stdin: {
      destroyed: false,
      write: (data: string, callback?: (cause?: Error | null) => void): boolean => {
        for (const line of data.split("\n")) {
          if (line.trim().length === 0) continue;
          const command = JSON.parse(line) as SentCommand;
          sent.push(command);
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
    for (const handler of stdoutHandlers.get("data") ?? []) {
      handler(Buffer.from(`${line}\n`));
    }
  };
  const spawn = vi.fn(() => child);
  return { spawn, sent, emitLine };
}

function makeVoice() {
  const fake = makeFakeSpawn();
  const errors: Array<string> = [];
  const voice = createDesktopJarvisVoice({
    platform: "linux",
    architecture: "x64",
    workerPath: "/worker.cjs",
    resourceRoot: "/resources",
    executablePath: "/exe",
    spawn: fake.spawn as never,
    emit: (message) => {
      if (message.type === "error") errors.push(message.message);
    },
  });
  return { ...fake, errors, voice };
}

describe("desktop Jarvis voice admission", () => {
  it("starts capture during a report by preempting speech instead of rejecting", async () => {
    const { voice, sent, emitLine, errors, spawn } = makeVoice();

    const speakPromise = voice.speak("Task one finished.", "report", "delivery-1");
    // The worker must report ready before any send goes out.
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
    emitLine(`{"type":"ready"}`);
    await vi.waitFor(() => expect(sent.map((command) => command.type)).toEqual(["speak"]));

    const capturePromise = voice.startCapture();
    await vi.waitFor(() =>
      expect(sent.map((command) => command.type)).toEqual(["speak", "interrupt"]),
    );
    const interruptId = sent[1]!.requestId;
    emitLine(`{"type":"result","requestId":"${interruptId}","ok":true}`);
    await vi.waitFor(() =>
      expect(sent.map((command) => command.type)).toEqual(["speak", "interrupt", "capture-start"]),
    );
    const captureId = sent[2]!.requestId;
    emitLine(`{"type":"result","requestId":"${captureId}","ok":true}`);

    await expect(capturePromise).resolves.toEqual({ accepted: true });

    // The worker reports the preempted speech as failed; admission owns the
    // barge-in, so the superseded send stays silent instead of toasting.
    const speakId = sent[0]!.requestId;
    emitLine(`{"type":"result","requestId":"${speakId}","ok":false,"message":"interrupted"}`);
    await expect(speakPromise).resolves.toEqual({ status: "deferred", reason: "interrupted" });
    expect(errors).toEqual([]);
    voice.stop();
  });

  it("still rejects a second capture while one is active", async () => {
    const { voice, sent, emitLine, spawn } = makeVoice();

    const first = voice.startCapture();
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
    emitLine(`{"type":"ready"}`);
    await vi.waitFor(() => expect(sent.map((command) => command.type)).toEqual(["capture-start"]));
    emitLine(`{"type":"result","requestId":"${sent[0]!.requestId}","ok":true}`);
    await expect(first).resolves.toEqual({ accepted: true });

    await expect(voice.startCapture()).resolves.toEqual({ accepted: false });
    expect(sent.map((command) => command.type)).toEqual(["capture-start"]);
    voice.stop();
  });
});
