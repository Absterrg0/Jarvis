import { assert, describe, it } from "@effect/vitest";

import { relayDocumentDidFinish } from "./relay-state.ts";

describe("Jarvis relay delivery", () => {
  it("delivers a queued transcript when Electron verifies the host document loaded", () => {
    assert.deepEqual(
      relayDocumentDidFinish({
        url: "http://100.78.179.56:3773/",
        pendingTranscript: "Review the current implementation",
      }),
      {
        ready: true,
        transcriptToDeliver: "Review the current implementation",
      },
    );
  });

  it("buffers a task in the pairing document while that document authenticates", () => {
    assert.deepEqual(
      relayDocumentDidFinish({
        url: "http://100.78.179.56:3773/pair#token=one-time",
        pendingTranscript: "Review the current implementation",
      }),
      {
        ready: true,
        transcriptToDeliver: "Review the current implementation",
      },
    );
  });
});
