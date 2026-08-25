import { describe, expect, it } from "@effect/vitest";

import { bindDesktopVoiceCaptureResult } from "./DesktopVoiceCaptureCoordinator.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

describe("DesktopVoiceCaptureCoordinator", () => {
  it("ignores a cancelled capture settling after its replacement starts", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    let active: "first" | "second" | null = "first";
    const settlements: string[] = [];

    bindDesktopVoiceCaptureResult({
      capture: "first" as const,
      result: first.promise,
      isActive: (capture) => active === capture,
      onSettled: (settlement) =>
        settlements.push(settlement.ok ? settlement.text : settlement.message),
    });
    active = null;
    active = "second";
    bindDesktopVoiceCaptureResult({
      capture: "second" as const,
      result: second.promise,
      isActive: (capture) => active === capture,
      onSettled: (settlement) =>
        settlements.push(settlement.ok ? settlement.text : settlement.message),
    });

    first.resolve("stale first result");
    await Promise.resolve();
    expect(settlements).toEqual([]);

    second.resolve("current second result");
    await Promise.resolve();
    expect(settlements).toEqual(["current second result"]);
  });
});
