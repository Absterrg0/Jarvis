import { afterEach, describe, expect, it, vi } from "vite-plus/test";

function storageWithExistingIdentity(reads: { value: number }): Storage {
  return {
    getItem: () => {
      reads.value += 1;
      return "browser-device";
    },
    setItem: () => undefined,
    removeItem: () => undefined,
    clear: () => undefined,
    key: () => null,
    length: 1,
  };
}

afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
});

describe("jarvisReporterIdentity", () => {
  it("reads the persisted browser identity once per module instance", async () => {
    const reads = { value: 0 };
    const localStorage = storageWithExistingIdentity(reads);
    vi.stubGlobal("window", { localStorage });

    const { jarvisReporterIdentity } = await import("./jarvisIdentity");

    expect(jarvisReporterIdentity()).toBe("browser-device");
    expect(jarvisReporterIdentity()).toBe("browser-device");
    expect(reads.value).toBe(1);
  });
});
