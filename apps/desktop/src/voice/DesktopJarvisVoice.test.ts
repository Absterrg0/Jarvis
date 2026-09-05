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
  const emitChunk = (chunk: Buffer): void => {
    for (const handler of stdoutHandlers.get("data") ?? []) {
      handler(chunk);
    }
  };
  const spawn = vi.fn(() => child);
  return { spawn, sent, emitLine, emitChunk };
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

describe("desktop Jarvis voice worker output", () => {
  it("keeps split multi-byte characters intact at every byte boundary", async () => {
    const fake = makeFakeSpawn();
    const transcripts: Array<string> = [];
    const voice = createDesktopJarvisVoice({
      platform: "linux",
      architecture: "x64",
      workerPath: "/worker.cjs",
      resourceRoot: "/resources",
      executablePath: "/exe",
      spawn: fake.spawn as never,
      emit: (message) => {
        if (message.type === "transcript") transcripts.push(message.text);
      },
    });

    const started = voice.speak("hello", "report", "delivery-0");
    await vi.waitFor(() => expect(fake.spawn).toHaveBeenCalled());
    fake.emitLine(`{"type":"ready"}`);
    await vi.waitFor(() => expect(fake.sent.map((command) => command.type)).toEqual(["speak"]));
    fake.emitLine(`{"type":"result","requestId":"${fake.sent[0]!.requestId}","ok":true}`);
    await expect(started).resolves.toEqual({ status: "played" });

    // Accented Latin, CJK-adjacent diacritics, and an astral-plane snowman:
    // every byte boundary below splits at least one multi-byte character.
    const text = "Start Rivvl café naïve façade ☃ now";
    const bytes = Buffer.from(`${JSON.stringify({ type: "transcript", text })}\n`, "utf8");
    for (let split = 1; split < bytes.length; split += 1) {
      const before = transcripts.length;
      fake.emitChunk(bytes.subarray(0, split));
      fake.emitChunk(bytes.subarray(split));
      expect(transcripts.length).toBe(before + 1);
      expect(transcripts[transcripts.length - 1]).toBe(text);
    }
    voice.stop();
  });
});

describe("desktop Jarvis voice restart", () => {
  interface RestartableChild {
    readonly killCalls: Array<string>;
    exit: (code: number | null) => void;
  }

  function makeRestartableSpawn() {
    const children: Array<{
      stdoutHandlers: Array<(chunk: Buffer) => void>;
      exitHandlers: Map<string, Array<(...args: Array<unknown>) => void>>;
      killCalls: Array<string>;
      exitCode: number | null;
    }> = [];
    const order: Array<string> = [];
    const sent: Array<{ readonly type: string; readonly requestId: string }> = [];
    const spawn = vi.fn(() => {
      const record = {
        stdoutHandlers: [] as Array<(chunk: Buffer) => void>,
        exitHandlers: new Map<string, Array<(...args: Array<unknown>) => void>>(),
        killCalls: [] as Array<string>,
        exitCode: null as number | null,
      };
      children.push(record);
      const index = children.length - 1;
      return {
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
            if (event === "data") record.stdoutHandlers.push(handler);
          },
        },
        stderr: { on: (): void => undefined },
        once: (event: string, handler: (...args: Array<unknown>) => void): void => {
          const handlers = record.exitHandlers.get(event) ?? [];
          handlers.push(handler);
          record.exitHandlers.set(event, handlers);
        },
        kill: (signal?: string): boolean => {
          record.killCalls.push(signal ?? "SIGTERM");
          order.push(`kill-${index}-${signal ?? "SIGTERM"}`);
          return true;
        },
        killed: false,
        connected: true,
        get exitCode() {
          return record.exitCode;
        },
      };
    });
    const emitLine = (index: number, line: string): void => {
      for (const handler of children[index]?.stdoutHandlers ?? []) {
        handler(Buffer.from(`${line}\n`));
      }
    };
    const exitChild = (index: number, code: number | null = null): void => {
      const record = children[index];
      if (record === undefined) return;
      record.exitCode = code;
      order.push(`exit-${index}`);
      for (const handler of record.exitHandlers.get("exit") ?? []) handler(code);
      for (const handler of record.exitHandlers.get("close") ?? []) handler(code);
    };
    return { spawn, emitLine, exitChild, children, order, sent };
  }

  it("waits for the old worker to exit before spawning its replacement", async () => {
    const fake = makeRestartableSpawn();
    const voice = createDesktopJarvisVoice({
      platform: "linux",
      architecture: "x64",
      workerPath: "/worker.cjs",
      resourceRoot: "/resources",
      executablePath: "/exe",
      spawn: fake.spawn as never,
      shutdownTimeoutMs: 1_000,
      emit: () => undefined,
    });

    const first = voice.prepare();
    await vi.waitFor(() => expect(fake.spawn).toHaveBeenCalledTimes(1));
    fake.emitLine(0, `{"type":"ready"}`);
    await vi.waitFor(() => expect(fake.sent).toHaveLength(1));
    fake.emitLine(0, `{"type":"result","requestId":"${fake.sent[0]!.requestId}","ok":true}`);
    await expect(first).resolves.toMatchObject({ status: "ready" });

    fake.emitLine(0, `{"type":"fatal","message":"worker failed"}`);
    const second = voice.prepare();
    // The retry must SIGTERM the stale worker but not layer a second worker
    // over it while its shutdown is still unobserved.
    await vi.waitFor(() => expect(fake.children[0]?.killCalls).toEqual(["SIGTERM"]));
    // Shutdown is still unobserved here, so no replacement may exist yet:
    // stopOwnedChild only resolves on the exit event (or its deadline).
    expect(fake.spawn).toHaveBeenCalledTimes(1);

    fake.exitChild(0, null);
    await vi.waitFor(() => expect(fake.spawn).toHaveBeenCalledTimes(2));
    fake.emitLine(1, `{"type":"ready"}`);
    await vi.waitFor(() => expect(fake.sent).toHaveLength(2));
    fake.emitLine(1, `{"type":"result","requestId":"${fake.sent[1]!.requestId}","ok":true}`);
    await expect(second).resolves.toMatchObject({ status: "ready" });

    // A late message from the superseded generation cannot move current state.
    fake.emitLine(0, `{"type":"state","state":"error"}`);
    expect(voice.getState().status).toBe("ready");
    expect(fake.order.indexOf("kill-0-SIGTERM")).toBeLessThan(fake.order.indexOf("exit-0"));
    voice.stop();
  });
});
