import { assert, describe, it } from "@effect/vitest";

import { resolveCompanionLaunch } from "./launch.ts";

describe("Jarvis Companion launch", () => {
  it("opens a supplied pairing link and records its stable host", () => {
    assert.deepEqual(
      resolveCompanionLaunch({
        argv: [
          "Jarvis Companion.exe",
          "--pairing-url=http://100.78.179.56:3773/pair?token=temporary-token",
        ],
        savedHost: null,
      }),
      {
        kind: "pairing",
        host: "http://100.78.179.56:3773/",
        url: "http://100.78.179.56:3773/pair?token=temporary-token",
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
});
