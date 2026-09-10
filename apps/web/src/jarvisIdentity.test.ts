import { afterEach, describe, expect, it, vi } from "vite-plus/test";

afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
});

describe("jarvisReporterIdentity", () => {
  it("returns one stable identity per renderer session", async () => {
    const { jarvisReporterIdentity } = await import("./jarvisIdentity");

    const first = jarvisReporterIdentity();
    expect(typeof first).toBe("string");
    expect(first.length).toBeGreaterThan(0);
    expect(jarvisReporterIdentity()).toBe(first);
  });

  it("gives independent renderer sessions distinct identities", async () => {
    const firstModule = await import("./jarvisIdentity");
    const first = firstModule.jarvisReporterIdentity();
    vi.resetModules();
    const secondModule = await import("./jarvisIdentity");

    expect(secondModule.jarvisReporterIdentity()).not.toBe(first);
  });
});
