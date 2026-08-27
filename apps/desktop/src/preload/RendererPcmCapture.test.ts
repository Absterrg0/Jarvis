import { describe, expect, it, vi } from "vite-plus/test";

import * as IpcChannels from "../ipc/channels.ts";
import {
  createRendererPcmCaptureController,
  type RendererPcmCaptureDependencies,
} from "./RendererPcmCapture.ts";

type FakePort = {
  onmessage: ((event: MessageEvent) => void) | null;
  onmessageerror: (() => void) | null;
  postMessage: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};

class FakeWorklet {
  static current: FakeWorklet | undefined;
  readonly port: FakePort = {
    onmessage: null,
    onmessageerror: null,
    postMessage: vi.fn(),
    close: vi.fn(),
  };
  readonly connect = vi.fn();
  readonly disconnect = vi.fn();

  constructor() {
    FakeWorklet.current = this;
  }
}

class FakeContext {
  static current: FakeContext | undefined;
  readonly sampleRate = 48_000;
  readonly destination = {};
  readonly audioWorklet = { addModule: vi.fn(async () => undefined) };
  readonly resume = vi.fn(async () => undefined);
  readonly close = vi.fn(async () => undefined);
  readonly createMediaStreamSource = vi.fn(() => ({
    connect: vi.fn(),
    disconnect: vi.fn(),
  }));
  readonly createGain = vi.fn(() => ({
    gain: { value: 1 },
    connect: vi.fn(),
    disconnect: vi.fn(),
  }));

  constructor() {
    FakeContext.current = this;
  }
}

function makeHarness(overrides: Partial<RendererPcmCaptureDependencies> = {}) {
  const track = { stop: vi.fn() };
  const calls: Array<{ channel: string; payload: unknown }> = [];
  const onError = vi.fn();
  const invoke = vi.fn(async (channel: string, payload: unknown) => {
    calls.push({ channel, payload });
    if (channel === IpcChannels.JARVIS_VOICE_CAPTURE_PERMISSION_CHANNEL) return { accepted: true };
    if (channel === IpcChannels.JARVIS_VOICE_CAPTURE_START_CHANNEL) return { accepted: true };
    if (channel === IpcChannels.JARVIS_VOICE_CAPTURE_PUSH_PCM_FRAME_CHANNEL)
      return { accepted: true };
    if (
      channel === IpcChannels.JARVIS_VOICE_CAPTURE_RELEASE_CHANNEL ||
      channel === IpcChannels.JARVIS_VOICE_CAPTURE_CANCEL_CHANNEL
    )
      return { accepted: true };
    return { accepted: false };
  });
  const dependencies: RendererPcmCaptureDependencies = {
    requestPermission: () => invoke(IpcChannels.JARVIS_VOICE_CAPTURE_PERMISSION_CHANNEL, undefined),
    getUserMedia: vi.fn(async () => ({ getTracks: () => [track] }) as unknown as MediaStream),
    AudioContext: FakeContext as unknown as RendererPcmCaptureDependencies["AudioContext"],
    AudioWorkletNode: FakeWorklet as unknown as RendererPcmCaptureDependencies["AudioWorkletNode"],
    Blob: class FakeBlob {} as unknown as typeof Blob,
    createObjectURL: vi.fn(() => "blob:test"),
    revokeObjectURL: vi.fn(),
    invoke,
    send: vi.fn(),
    randomUUID: vi.fn(() => "session-1"),
    onError,
    ...overrides,
  };
  return {
    controller: createRendererPcmCaptureController(dependencies),
    dependencies,
    calls,
    track,
    onError,
  };
}

function emitSamples(samples: Float32Array, sampleRate = 48_000): void {
  FakeWorklet.current?.port.onmessage?.({
    data: { type: "samples", sampleRate, samples },
  } as MessageEvent);
}

describe("renderer PCM capture", () => {
  it("preflights permission before opening the device and reports denial", async () => {
    const getUserMedia = vi.fn();
    const onError = vi.fn();
    const harness = makeHarness({
      getUserMedia,
      requestPermission: vi.fn(async () => ({ accepted: false })),
      onError,
    });

    await expect(harness.controller.start()).resolves.toEqual({ accepted: false });
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith("Microphone permission was denied.");
  });

  it("does not let dispose revive a start that is waiting on permission", async () => {
    let allow!: (value: { accepted: boolean }) => void;
    const harness = makeHarness({
      requestPermission: () =>
        new Promise((resolve) => {
          allow = resolve;
        }),
    });
    const start = harness.controller.start();
    await harness.controller.dispose();
    allow({ accepted: true });
    await expect(start).resolves.toEqual({ accepted: false });
    expect(harness.dependencies.getUserMedia).not.toHaveBeenCalled();
    expect(
      harness.calls.some(
        ({ channel }) => channel === IpcChannels.JARVIS_VOICE_CAPTURE_START_CHANNEL,
      ),
    ).toBe(false);
  });

  it("reports a missing device and tears down the renderer resources", async () => {
    const onError = vi.fn();
    const cause = Object.assign(new Error("no device"), { name: "NotFoundError" });
    const harness = makeHarness({
      getUserMedia: vi.fn(async () => Promise.reject(cause)),
      onError,
    });

    await expect(harness.controller.start()).resolves.toEqual({ accepted: false });
    expect(onError).toHaveBeenCalledWith("No microphone device was found.");
    expect(harness.dependencies.send).toHaveBeenLastCalledWith(
      IpcChannels.JARVIS_VOICE_CAPTURE_RENDERER_THROTTLING_CHANNEL,
      false,
    );
  });

  it("sends raw mono context-rate batches and flushes the final partial frame", async () => {
    const harness = makeHarness();
    await expect(harness.controller.start()).resolves.toEqual({ accepted: true });
    expect(harness.dependencies.send).toHaveBeenCalledWith(
      IpcChannels.JARVIS_VOICE_CAPTURE_RENDERER_THROTTLING_CHANNEL,
      true,
    );
    emitSamples(new Float32Array(961));

    await expect(harness.controller.release()).resolves.toEqual({ accepted: true });
    const frames = harness.calls
      .filter(({ channel }) => channel === IpcChannels.JARVIS_VOICE_CAPTURE_PUSH_PCM_FRAME_CHANNEL)
      .map(({ payload }) => payload as { samples: Float32Array });
    expect(frames.map(({ samples }) => samples.length)).toEqual([960, 1]);
    expect(
      harness.calls.find(
        ({ channel }) => channel === IpcChannels.JARVIS_VOICE_CAPTURE_START_CHANNEL,
      )?.payload,
    ).toMatchObject({
      purpose: "command",
      source: { sampleRate: 48_000, channels: 1, type: "renderer-pcm" },
    });
  });

  it("cancels and reports an AudioWorklet processing error", async () => {
    const harness = makeHarness();
    await harness.controller.start();
    FakeWorklet.current?.port.onmessageerror?.();
    await Promise.resolve();
    expect(harness.onError).toHaveBeenCalledWith("Microphone audio processing failed.");
    expect(
      harness.calls.some(
        ({ channel }) => channel === IpcChannels.JARVIS_VOICE_CAPTURE_CANCEL_CHANNEL,
      ),
    ).toBe(true);
  });

  it("waits for pending frame acknowledgements before worker release", async () => {
    let acknowledge!: (value: { accepted: boolean }) => void;
    const harness = makeHarness({
      invoke: vi.fn((channel: string, payload: unknown) => {
        harness.calls.push({ channel, payload });
        if (channel === IpcChannels.JARVIS_VOICE_CAPTURE_PUSH_PCM_FRAME_CHANNEL)
          return new Promise<{ accepted: boolean }>((resolve) => {
            acknowledge = resolve;
          });
        return Promise.resolve({ accepted: true });
      }),
    });
    await harness.controller.start();
    emitSamples(new Float32Array(960));
    const release = harness.controller.release();
    await Promise.resolve();
    expect(
      harness.calls.some(
        ({ channel }) => channel === IpcChannels.JARVIS_VOICE_CAPTURE_RELEASE_CHANNEL,
      ),
    ).toBe(false);
    acknowledge({ accepted: true });
    await release;
    expect(harness.calls.at(-1)?.channel).toBe(IpcChannels.JARVIS_VOICE_CAPTURE_RELEASE_CHANNEL);
  });

  it("cancels on rejected frame delivery and ignores stale worklet messages after dispose", async () => {
    const harness = makeHarness({
      invoke: vi.fn(async (channel: string, payload: unknown) => {
        harness.calls.push({ channel, payload });
        return channel === IpcChannels.JARVIS_VOICE_CAPTURE_PUSH_PCM_FRAME_CHANNEL
          ? { accepted: false }
          : { accepted: true };
      }),
    });
    await harness.controller.start();
    emitSamples(new Float32Array(960));
    await Promise.resolve();
    await Promise.resolve();
    expect(
      harness.calls.some(
        ({ channel }) => channel === IpcChannels.JARVIS_VOICE_CAPTURE_CANCEL_CHANNEL,
      ),
    ).toBe(true);
    const frameCount = harness.calls.filter(
      ({ channel }) => channel === IpcChannels.JARVIS_VOICE_CAPTURE_PUSH_PCM_FRAME_CHANNEL,
    ).length;
    await harness.controller.dispose();
    emitSamples(new Float32Array(960));
    expect(
      harness.calls.filter(
        ({ channel }) => channel === IpcChannels.JARVIS_VOICE_CAPTURE_PUSH_PCM_FRAME_CHANNEL,
      ),
    ).toHaveLength(frameCount);
    expect(harness.track.stop).toHaveBeenCalled();
    expect(harness.dependencies.revokeObjectURL).toHaveBeenCalledWith("blob:test");
    expect(FakeWorklet.current?.port.postMessage).toHaveBeenCalledWith({ type: "stop" });
  });

  it("tears down even when release or cancel IPC rejects", async () => {
    for (const terminalChannel of [
      IpcChannels.JARVIS_VOICE_CAPTURE_RELEASE_CHANNEL,
      IpcChannels.JARVIS_VOICE_CAPTURE_CANCEL_CHANNEL,
    ]) {
      const harness = makeHarness({
        invoke: vi.fn(async (channel: string, payload: unknown) => {
          harness.calls.push({ channel, payload });
          if (channel === terminalChannel) throw new Error("main closed");
          return { accepted: true };
        }),
      });
      await harness.controller.start();
      if (terminalChannel === IpcChannels.JARVIS_VOICE_CAPTURE_RELEASE_CHANNEL) {
        emitSamples(new Float32Array(960));
        await expect(harness.controller.release()).resolves.toEqual({ accepted: false });
      } else {
        await expect(harness.controller.cancel()).resolves.toEqual({ accepted: false });
      }
      expect(harness.track.stop).toHaveBeenCalled();
      expect(FakeContext.current?.close).toHaveBeenCalled();
      expect(harness.dependencies.send).toHaveBeenLastCalledWith(
        IpcChannels.JARVIS_VOICE_CAPTURE_RENDERER_THROTTLING_CHANNEL,
        false,
      );
    }
  });
});
