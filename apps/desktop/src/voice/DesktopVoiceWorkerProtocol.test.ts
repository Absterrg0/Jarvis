import { describe, expect, it } from "@effect/vitest";
import * as NodeEvents from "node:events";

import { parseDesktopVoiceWorkerMessage } from "./DesktopVoiceWorkerProtocol.ts";
import {
  createDesktopJarvisVoice,
  resolveDesktopJarvisVoiceResourceRoot,
} from "./DesktopJarvisVoice.ts";

describe("desktop voice worker protocol", () => {
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
      }),
    ).toEqual({ type: "capture-result", ok: false, message: "No microphone" });
  });

  it("rejects malformed worker messages", () => {
    expect(parseDesktopVoiceWorkerMessage({ type: "result", requestId: "x", ok: false })).toBe(
      null,
    );
    expect(parseDesktopVoiceWorkerMessage({ type: "state", state: "unknown" })).toBe(null);
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
    expect(voice.getState().status).toBe("ready");
    const starting = voice.startCapture();
    stdout.emit("data", Buffer.from('{"type":"state","state":"capturing"}\n'));
    await starting;
    expect(voice.getState().status).toBe("capturing");
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

  it("runs the same native worker contract on macOS", async () => {
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
    const voice = createDesktopJarvisVoice({
      platform: "darwin",
      workerPath: "/worker.cjs",
      resourceRoot: "/resources",
      spawn: (() => child) as never,
    });
    const preparing = voice.prepare();
    stdout.emit("data", Buffer.from('{"type":"ready"}\n'));
    await preparing;
    expect(voice.getState().status).toBe("ready");
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
});
