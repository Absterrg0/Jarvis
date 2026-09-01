import { describe, expect, it } from "vite-plus/test";

import { createMobileSpeechPrefetch, segmentMobileSpeech } from "./mobileSpeechQueue";

describe("mobile Jarvis speech segmentation", () => {
  it("starts with a short complete segment and preserves the presentation text", () => {
    const segments = segmentMobileSpeech(
      "Finished updating the tests. Two failures remain in the authentication suite.",
    );

    expect(segments).toEqual([
      "Finished updating the tests.",
      "Two failures remain in the authentication suite.",
    ]);
    expect(segments.join(" ")).toBe(
      "Finished updating the tests. Two failures remain in the authentication suite.",
    );
  });

  it("bounds long sentences and ignores empty speech", () => {
    const segments = segmentMobileSpeech(`Result ${"word ".repeat(100)}`);
    expect(segments.every((segment) => segment.length <= 240)).toBe(true);
    expect(segmentMobileSpeech("   ")).toEqual([]);
  });

  it("bounds an individual token longer than one speech segment", () => {
    const token = "x".repeat(600);
    const segments = segmentMobileSpeech(token);

    expect(segments.every((segment) => segment.length <= 240)).toBe(true);
    expect(segments.join("")).toBe(token);
  });
});

type SpeechItem = { readonly text: string };
type Audio = { readonly id: string };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

describe("mobile Jarvis speech lookahead", () => {
  it("starts one next-segment synthesis while the current segment plays", async () => {
    const pending = new Map<string, ReturnType<typeof deferred<Audio>>>();
    const started: string[] = [];
    const prefetch = createMobileSpeechPrefetch<SpeechItem, Audio>({
      synthesize: (item) => {
        const request = deferred<Audio>();
        started.push(item.text);
        pending.set(item.text, request);
        return request.promise;
      },
    });
    prefetch.enqueue([{ text: "A" }, { text: "B" }, { text: "C" }]);

    const first = prefetch.takeNext();
    expect(started).toEqual(["A"]);
    pending.get("A")?.resolve({ id: "A" });
    await expect(first).resolves.toEqual({ item: { text: "A" }, audio: { id: "A" } });

    prefetch.playbackStarted();
    prefetch.playbackStarted();
    expect(started).toEqual(["A", "B"]);
    prefetch.playbackFinished();
    expect(started).not.toContain("C");

    const second = prefetch.takeNext();
    pending.get("B")?.resolve({ id: "B" });
    await expect(second).resolves.toEqual({ item: { text: "B" }, audio: { id: "B" } });
    prefetch.playbackStarted();
    expect(started).toEqual(["A", "B", "C"]);
  });

  it("cancels an in-flight lookahead without starting later segments", async () => {
    const pending = new Map<string, ReturnType<typeof deferred<Audio>>>();
    const started: string[] = [];
    const aborted: string[] = [];
    const prefetch = createMobileSpeechPrefetch<SpeechItem, Audio>({
      synthesize: (item, signal) => {
        const request = deferred<Audio>();
        started.push(item.text);
        pending.set(item.text, request);
        signal.addEventListener("abort", () => {
          aborted.push(item.text);
          request.reject(new Error("cancelled"));
        });
        return request.promise;
      },
    });
    prefetch.enqueue([{ text: "A" }, { text: "B" }, { text: "C" }]);

    const first = prefetch.takeNext();
    pending.get("A")?.resolve({ id: "A" });
    await first;
    prefetch.playbackStarted();
    expect(started).toEqual(["A", "B"]);

    prefetch.cancel();
    expect(aborted).toEqual(["B"]);
    expect(started).not.toContain("C");
    await expect(prefetch.takeNext()).resolves.toBeUndefined();
  });
});
