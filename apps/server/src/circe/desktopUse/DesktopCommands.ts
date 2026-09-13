import {
  DesktopUseBackendError,
  DesktopUseTimeoutError,
  type DesktopUseBackend,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import type { DesktopCommand } from "./platforms.ts";

export class DesktopCommands extends Context.Service<
  DesktopCommands,
  {
    readonly run: (
      command: DesktopCommand,
      backend: DesktopUseBackend,
      operation: string,
      timeoutMs?: number,
    ) => Effect.Effect<
      { readonly stdout: string; readonly stderr: string; readonly code: number },
      DesktopUseBackendError | DesktopUseTimeoutError
    >;
  }
>()("t3/circe/desktopUse/DesktopCommands") {}

const isBackendError = Schema.is(DesktopUseBackendError);

export const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return DesktopCommands.of({
    run: (command, backend, operation, timeoutMs = 5000) =>
      Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* spawner.spawn(
            ChildProcess.make(command.command, [...command.args], {
              stdin: "ignore",
              forceKillAfter: 250,
            }),
          );
          const collect = (stream: typeof handle.stdout) =>
            stream.pipe(
              Stream.decodeText(),
              Stream.runFoldEffect(
                () => "",
                (text, chunk) =>
                  text.length + chunk.length > 1_000_000
                    ? Effect.fail(
                        new DesktopUseBackendError({
                          backend,
                          operation,
                          cause: new Error("Desktop helper output exceeded its limit"),
                        }),
                      )
                    : Effect.succeed(text + chunk),
              ),
            );
          const [code, stdout, stderr] = yield* Effect.all(
            [handle.exitCode, collect(handle.stdout), collect(handle.stderr)],
            { concurrency: "unbounded" },
          );
          return { code: Number(code), stdout: stdout.trim(), stderr: stderr.trim() };
        }),
      ).pipe(
        Effect.mapError((cause) =>
          isBackendError(cause) ? cause : new DesktopUseBackendError({ backend, operation, cause }),
        ),
        Effect.timeoutOrElse({
          duration: timeoutMs,
          orElse: () => Effect.fail(new DesktopUseTimeoutError({ operation, timeoutMs })),
        }),
      ),
  });
});
export const layer = Layer.effect(DesktopCommands, make);
