import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Commands from "./DesktopCommands.ts";

const testLayer = Commands.layer.pipe(Layer.provideMerge(NodeServices.layer));
const run = (source: string, timeoutMs = 5000, args: ReadonlyArray<string> = []) =>
  Effect.gen(function* () {
    const commands = yield* Commands.DesktopCommands;
    return yield* commands
      .run(
        { command: process.execPath, args: ["-e", source, ...args] },
        "linux-x11",
        "test helper",
        timeoutMs,
      )
      .pipe(Effect.result);
  });
it.live("kills and reaps a hung helper before reporting its timeout", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "aris-helper-" });
      const pidPath = `${dir}/pid`;
      const result = yield* run(
        "require('node:fs').writeFileSync(process.argv[1],String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);",
        1000,
        [pidPath],
      );
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") expect(result.failure._tag).toBe("DesktopUseTimeoutError");
      const pid = Number(yield* fs.readFileString(pidPath));
      expect(() => process.kill(pid, 0)).toThrow();
    }),
  ).pipe(Effect.provide(testLayer)),
);
it.live("drains stdout and stderr and preserves a nonzero exit", () =>
  Effect.gen(function* () {
    const result = yield* run(
      "process.stdout.write('out');process.stderr.write('err');process.exitCode=7",
    );
    expect(result).toMatchObject({
      _tag: "Success",
      success: { code: 7, stdout: "out", stderr: "err" },
    });
  }).pipe(Effect.provide(testLayer)),
);
it.live("bounds helper output and terminates an overflowing producer", () =>
  Effect.gen(function* () {
    const result = yield* run("process.stdout.write('a'.repeat(1100000));setInterval(()=>{},1000)");
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.failure._tag).toBe("DesktopUseBackendError");
  }).pipe(Effect.provide(testLayer)),
);
