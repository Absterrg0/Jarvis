import { afterEach, describe, expect, it, vi } from "vite-plus/test";

afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
});

describe("circeReporterIdentity", () => {
  it("returns one stable identity per renderer session", async () => {
    const { circeReporterIdentity } = await import("./circeIdentity");

    const first = circeReporterIdentity();
    expect(typeof first).toBe("string");
    expect(first.length).toBeGreaterThan(0);
    expect(circeReporterIdentity()).toBe(first);
  });

  it("gives independent renderer sessions distinct identities", async () => {
    const firstModule = await import("./circeIdentity");
    const first = firstModule.circeReporterIdentity();
    vi.resetModules();
    const secondModule = await import("./circeIdentity");

    expect(secondModule.circeReporterIdentity()).not.toBe(first);
  });
});
