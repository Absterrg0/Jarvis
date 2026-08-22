import { assert, describe, it } from "@effect/vitest";

import { resolveCompanionLaunch, resolvePairingLink } from "./launch.ts";

describe("Jarvis Companion launch", () => {
  it("accepts the managed helper launch seam without opening standalone setup", () => {
    assert.deepEqual(
      resolveCompanionLaunch({
        argv: ["Jarvis Companion.exe", "--jarvis-managed"],
        savedHost: null,
      }),
      { kind: "managed" },
    );
  });

  it("opens a supplied pairing link and records its stable host", () => {
    assert.deepEqual(
      resolveCompanionLaunch({
        argv: [
          "Jarvis Companion.exe",
          "--pairing-url=http://100.78.179.56:3773/pair#token=temporary-token",
        ],
        savedHost: null,
      }),
      {
        kind: "pairing",
        host: "http://100.78.179.56:3773/",
        url: "http://100.78.179.56:3773/pair#token=temporary-token",
      },
    );
  });

  it("reconnects quietly to the saved host after pairing", () => {
    assert.deepEqual(
      resolveCompanionLaunch({
        argv: ["Jarvis Companion.exe"],
        savedHost: "http://jarvis-host",
      }),
      {
        kind: "remote",
        host: "http://jarvis-host/",
        url: "http://jarvis-host/",
      },
    );
  });

  it("asks for a pairing link when no host has been configured", () => {
    assert.deepEqual(resolveCompanionLaunch({ argv: ["Jarvis Companion.exe"], savedHost: null }), {
      kind: "setup",
    });
  });

  it("does not treat a bare host as a pairing link", () => {
    assert.deepEqual(
      resolveCompanionLaunch({
        argv: ["Jarvis Companion.exe", "--pairing-url=http://jarvis-host"],
        savedHost: null,
      }),
      { kind: "setup" },
    );
  });

  it("requires a non-empty pairing token", () => {
    assert.deepEqual(
      resolveCompanionLaunch({
        argv: ["Jarvis Companion.exe", "--pairing-url=http://jarvis-host/pair?token="],
        savedHost: null,
      }),
      { kind: "setup" },
    );
  });

  it("also accepts the legacy query-string pairing token", () => {
    assert.deepEqual(
      resolveCompanionLaunch({
        argv: [
          "Jarvis Companion.exe",
          "--pairing-url=http://jarvis-host/pair?token=temporary-token",
        ],
        savedHost: null,
      }),
      {
        kind: "pairing",
        host: "http://jarvis-host/",
        url: "http://jarvis-host/pair?token=temporary-token",
      },
    );
  });

  it("accepts a complete pairing URL copied from a rich-text message", () => {
    assert.deepEqual(
      resolvePairingLink(
        "Open this on Jarvis Companion: [Connect this PC](https://jarvis-host.tailnet.ts.net/pair#token=temporary-token)",
      ),
      {
        kind: "pairing",
        host: "https://jarvis-host.tailnet.ts.net/",
        url: "https://jarvis-host.tailnet.ts.net/pair#token=temporary-token",
      },
    );
  });

  it("accepts a full URL with invisible copy-paste characters around it", () => {
    assert.deepEqual(
      resolvePairingLink(
        "\uFEFF https://jarvis-host.tailnet.ts.net/pair#token=temporary-token\u200B ",
      ),
      {
        kind: "pairing",
        host: "https://jarvis-host.tailnet.ts.net/",
        url: "https://jarvis-host.tailnet.ts.net/pair#token=temporary-token",
      },
    );
  });

  it("accepts the official T3 browser pairing wrapper", () => {
    assert.deepEqual(
      resolvePairingLink(
        "https://app.t3.codes/pair?host=https%3A%2F%2Fjarvis-host.tailnet.ts.net%2F#token=temporary-token",
      ),
      {
        kind: "pairing",
        host: "https://jarvis-host.tailnet.ts.net/",
        url: "https://jarvis-host.tailnet.ts.net/pair#token=temporary-token",
      },
    );
  });
});
