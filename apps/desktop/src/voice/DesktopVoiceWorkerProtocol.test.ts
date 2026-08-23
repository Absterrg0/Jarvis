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

  it("resolves the temporary Windows sibling Companion resource layout", () => {
    expect(
      resolveDesktopJarvisVoiceResourceRoot({
        platform: "win32",
        isPackaged: true,
        resourcesPath: "C:\\Jarvis\\desktop\\resources",
        executablePath: "C:\\Jarvis\\desktop\\Jarvis.exe",
        developmentResourceRoot: "C:\\repo\\packages\\jarvis-native-voice\\resources",
        exists: (path) => path === "C:\\Jarvis\\companion\\resources\\jarvis-resources",
      }),
    ).toBe("C:\\Jarvis\\companion\\resources\\jarvis-resources");
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
});
