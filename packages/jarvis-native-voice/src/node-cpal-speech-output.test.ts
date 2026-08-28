import { describe, expect, it } from "@effect/vitest";

import {
  createNodeCpalSpeechOutput,
  type NodeCpalSpeechOutputRuntime,
} from "./node-cpal-speech-output.ts";

describe("node-cpal speech output", () => {
  it("converts sidecar int16 PCM to one continuous f32 device stream", async () => {
    const written: Float32Array[] = [];
    const closed: string[] = [];
    const runtime: NodeCpalSpeechOutputRuntime = {
      getDefaultOutputDevice: () => ({ deviceId: "speaker" }),
      createStream: (_deviceId, _isInput, config) => {
        expect(config).toEqual({ sampleRate: 24_000, channels: 1, sampleFormat: "f32" });
        return "stream-1";
      },
      writeToStream: (_stream, samples) => written.push(samples),
      closeStream: (stream) => closed.push(stream),
    };
    const output = createNodeCpalSpeechOutput({
      sampleRate: 24_000,
      runtime,
      wait: async () => undefined,
    });
    await output.write(new Uint8Array([0, 0, 0xff, 0x7f, 0, 0x80]));
    await output.finish();

    expect(written[0]).toEqual(new Float32Array([0, 1, -1]));
    expect(written.length).toBe(5);
    expect(written.slice(1).reduce((total, frame) => total + frame.length, 0)).toBe(
      Math.round((24_000 * 140) / 1_000),
    );
    expect(closed).toEqual(["stream-1"]);
  });

  it("holds the write promise until each 1,024-sample frame duration is consumed", async () => {
    const waits: Array<() => void> = [];
    let writes = 0;
    const runtime: NodeCpalSpeechOutputRuntime = {
      getDefaultOutputDevice: () => ({ deviceId: "speaker" }),
      createStream: () => "stream-1",
      writeToStream: () => {
        writes += 1;
      },
      closeStream: () => undefined,
    };
    const output = createNodeCpalSpeechOutput({
      sampleRate: 24_000,
      runtime,
      wait: async () =>
        await new Promise<void>((resolve) => {
          waits.push(resolve);
        }),
    });
    let settled = false;
    const writing = output.write(new Uint8Array(2 * 2_048)).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(writes).toBe(1);
    expect(settled).toBe(false);
    waits.shift()?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(writes).toBe(2);
    expect(settled).toBe(false);
    waits.shift()?.();
    await writing;
    expect(settled).toBe(true);
    output.abort();
  });

  it("aborts immediately and does not reopen or write after interruption", () => {
    let writes = 0;
    let closes = 0;
    const runtime: NodeCpalSpeechOutputRuntime = {
      getDefaultOutputDevice: () => ({ deviceId: "speaker" }),
      createStream: () => "stream-1",
      writeToStream: () => {
        writes += 1;
      },
      closeStream: () => {
        closes += 1;
      },
    };
    const output = createNodeCpalSpeechOutput({ sampleRate: 24_000, runtime });
    void output.write(new Uint8Array([0, 0]));
    output.abort();
    void output.write(new Uint8Array([0, 0]));
    output.abort();

    expect(writes).toBe(1);
    expect(closes).toBe(1);
  });
});
