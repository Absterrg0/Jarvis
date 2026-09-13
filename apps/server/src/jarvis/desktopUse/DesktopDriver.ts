import type {
  DesktopUseAction,
  DesktopUseBackend,
  DesktopUseCursor,
  DesktopUseDisplay,
  DesktopUsePlatform,
  DesktopUseStatus,
  DesktopUseWindow,
} from "@t3tools/contracts";
import { DesktopUseBackendError, DesktopUseUnavailableError } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";

import * as ServerConfig from "../../config.ts";
import {
  buildCaptureCommand,
  buildCaptureCommands,
  buildCursorCommand,
  buildDisplayGeometryCommand,
  buildFocusWindowCommand,
  buildKeyboardCommands,
  buildListWindowsCommand,
  buildPointerCommands,
  detectDisplayServer,
  type DesktopCommand,
  type DesktopToolName,
  type DesktopTooling,
  hasTool,
  resolveBackend,
} from "./platforms.ts";
import {
  parseCommaCursor,
  parseJsonWindows,
  parseMacDisplay,
  parseWindowsDisplays,
  parseWmctrlWindows,
  parseXdotoolCursor,
  parseXrandrDisplays,
  readPngSize,
} from "./parsers.ts";

export interface DesktopCaptureResult {
  readonly png: Uint8Array;
  readonly display: DesktopUseDisplay;
  readonly cursor?: DesktopUseCursor;
}

export interface DesktopDriverShape {
  readonly getStatus: () => Effect.Effect<DesktopUseStatus>;
  readonly capture: (input: {
    readonly displayId?: string;
  }) => Effect.Effect<DesktopCaptureResult, DesktopUseUnavailableError | DesktopUseBackendError>;
  readonly input: (input: {
    readonly displayId?: string;
    readonly action: DesktopUseAction;
  }) => Effect.Effect<
    DesktopUseCursor | undefined,
    DesktopUseUnavailableError | DesktopUseBackendError
  >;
  readonly listWindows: () => Effect.Effect<
    ReadonlyArray<DesktopUseWindow>,
    DesktopUseUnavailableError | DesktopUseBackendError
  >;
}

export class DesktopDriver extends Context.Service<DesktopDriver, DesktopDriverShape>()(
  "t3/jarvis/desktopUse/DesktopDriver",
) {}

const STATUS_CACHE_MS = 3_000;

const POSIX_TOOL_PROBE = [
  "xdotool",
  "ydotool",
  "wtype",
  "grim",
  "gnome-screenshot",
  "spectacle",
  "import",
  "magick",
  "scrot",
  "ffmpeg",
  "cliclick",
  "wmctrl",
  "xrandr",
] as const satisfies ReadonlyArray<DesktopToolName>;

const numericExit = (code: unknown) => Number(code);

const BACKEND_POINTER_TOOLS: Readonly<Record<DesktopUseBackend, DesktopToolName | null>> = {
  macos: "cliclick",
  "linux-x11": "xdotool",
  "linux-wayland": "ydotool",
  windows: "powershell",
  unavailable: null,
};

const BACKEND_KEYBOARD_TOOLS: Readonly<Record<DesktopUseBackend, ReadonlyArray<DesktopToolName>>> =
  {
    macos: ["cliclick", "osascript"],
    "linux-x11": ["xdotool"],
    "linux-wayland": ["wtype", "ydotool"],
    windows: ["powershell"],
    unavailable: [],
  };

export const make = Effect.fn("DesktopDriver.make")(function* () {
  const platform = (yield* HostProcessPlatform) as DesktopUsePlatform;
  const env = yield* HostProcessEnvironment;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;

  const displayServer = detectDisplayServer(env);
  const backend = resolveBackend({ platform, displayServer });

  const command = (spec: DesktopCommand) =>
    ChildProcess.make(spec.command, [...spec.args], { stdin: "ignore" });

  const runExit = (spec: DesktopCommand) =>
    spawner.exitCode(command(spec)).pipe(Effect.map(numericExit));

  const runString = (spec: DesktopCommand) =>
    spawner.string(command(spec)).pipe(Effect.map((output) => output.trim()));

  const detectPosixTools = Effect.gen(function* () {
    const found = new Set<DesktopToolName>();
    for (const tool of POSIX_TOOL_PROBE) {
      const code = yield* runExit({ command: "sh", args: ["-c", `command -v ${tool}`] }).pipe(
        Effect.catch(() => Effect.succeed(1)),
      );
      if (code === 0) found.add(tool);
    }
    return found;
  });

  const detectMacTools = Effect.gen(function* () {
    const found = new Set<DesktopToolName>();
    const posix = yield* detectPosixTools;
    for (const tool of posix) found.add(tool);
    const exists = (path: string) =>
      runExit({ command: "test", args: ["-x", path] }).pipe(
        Effect.catch(() => Effect.succeed(1)),
        Effect.map((code) => code === 0),
      );
    if (yield* exists("/usr/bin/osascript")) found.add("osascript");
    found.add("screencapture");
    return found;
  });

  const tooling: DesktopTooling =
    backend === "macos"
      ? { platform, backend, tools: yield* detectMacTools }
      : backend === "windows"
        ? { platform, backend, tools: new Set<DesktopToolName>(["powershell"]) }
        : backend === "unavailable"
          ? { platform, backend, tools: new Set<DesktopToolName>() }
          : { platform, backend, tools: yield* detectPosixTools };

  const captureAvailable = (): boolean =>
    buildCaptureCommand(tooling, { outPath: "/dev/null" }) !== null;

  const pointerAvailable = (): boolean => {
    const required = BACKEND_POINTER_TOOLS[backend];
    if (required === null) return false;
    if (required === "powershell") return true;
    return hasTool(tooling, required);
  };

  const keyboardAvailable = (): boolean =>
    BACKEND_KEYBOARD_TOOLS[backend].some((tool) =>
      tool === "powershell" ? true : tool === "osascript" ? true : hasTool(tooling, tool),
    );

  const unavailableReason = (): string | null => {
    if (backend === "unavailable") return `Unsupported platform ${platform}.`;
    if (!captureAvailable()) {
      return backend === "linux-wayland"
        ? "No Wayland capture tool found. Install grim or gnome-screenshot."
        : "No screen capture tool found.";
    }
    return null;
  };

  const probeDisplays = Effect.gen(function* () {
    const spec = buildDisplayGeometryCommand(tooling);
    if (spec === null) return { displays: [], raw: "" } as const;
    const raw = yield* runString(spec).pipe(Effect.catch(() => Effect.succeed("")));
    switch (backend) {
      case "linux-x11":
      case "linux-wayland":
        return { displays: parseXrandrDisplays(raw), raw } as const;
      case "macos":
        return { displays: parseMacDisplay(raw), raw } as const;
      case "windows":
        return { displays: parseWindowsDisplays(raw), raw } as const;
      case "unavailable":
        return { displays: [], raw } as const;
    }
  });

  const buildStatus = Effect.gen(function* () {
    const reason = unavailableReason();
    if (reason !== null) {
      return {
        available: false,
        platform,
        backend,
        reason,
        displays: [],
        supports: { capture: false, pointer: false, keyboard: false, windows: false },
      } satisfies DesktopUseStatus;
    }
    const probed = yield* probeDisplays;
    let displays = probed.displays;
    if (displays.length === 0) {
      // Some Wayland compositors expose no queryable outputs. One capture still
      // tells us the real pixel size, which is all the viewer needs.
      const withCapture = yield* captureOnce(undefined).pipe(
        Effect.map((result) => [result.display]),
        Effect.catch(() => Effect.succeed([] as ReadonlyArray<DesktopUseDisplay>)),
      );
      displays = withCapture;
    }
    return {
      available: true,
      platform,
      backend,
      displays,
      supports: {
        capture: captureAvailable(),
        pointer: pointerAvailable(),
        keyboard: keyboardAvailable(),
        windows: buildListWindowsCommand(tooling) !== null,
      },
    } satisfies DesktopUseStatus;
  });

  const statusCache = yield* Ref.make<
    { readonly at: number; readonly status: DesktopUseStatus } | undefined
  >(undefined);

  const getStatus = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const cached = yield* Ref.get(statusCache);
    if (cached && now - cached.at < STATUS_CACHE_MS) return cached.status;
    const status = yield* buildStatus;
    yield* Ref.set(statusCache, { at: now, status });
    return status;
  });

  const resolveDisplay = (
    displays: ReadonlyArray<DesktopUseDisplay>,
    displayId: string | undefined,
    fallback: { readonly width: number; readonly height: number },
  ): DesktopUseDisplay => {
    if (displayId !== undefined) {
      const match = displays.find((display) => display.id === displayId);
      if (match) return match;
    }
    return (
      displays.find((display) => display.primary) ??
      displays[0] ?? {
        id: displayId ?? "primary",
        x: 0,
        y: 0,
        width: fallback.width,
        height: fallback.height,
        scale: 1,
        primary: true,
      }
    );
  };

  const runCaptureCommand = (
    displayId: string | undefined,
  ): Effect.Effect<Uint8Array, DesktopUseUnavailableError | DesktopUseBackendError> =>
    Effect.gen(function* () {
      const candidateCount = buildCaptureCommands(tooling, {
        outPath: "/dev/null",
        ...(displayId === undefined ? {} : { display: displayId }),
      }).length;
      if (candidateCount === 0) {
        return yield* new DesktopUseUnavailableError({
          platform,
          reason: "No capture backend is available.",
        });
      }
      let lastFailure: DesktopUseBackendError | null = null;
      for (let index = 0; index < candidateCount; index += 1) {
        const outcome = yield* Effect.result(
          Effect.scoped(
            Effect.gen(function* () {
              const directory = yield* fileSystem
                .makeTempDirectoryScoped({
                  directory: config.stateDir,
                  prefix: ".desktop-use-",
                })
                .pipe(
                  Effect.mapError(
                    (cause) => new DesktopUseBackendError({ backend, operation: "capture", cause }),
                  ),
                );
              // Screenshot tools infer the output format from the extension.
              const path = pathService.join(directory, "capture.png");
              const spec = buildCaptureCommands(tooling, {
                outPath: path,
                ...(displayId === undefined ? {} : { display: displayId }),
              })[index]!;
              const code = yield* runExit(spec).pipe(
                Effect.catch((cause) =>
                  Effect.fail(new DesktopUseBackendError({ backend, operation: "capture", cause })),
                ),
              );
              if (code !== 0) {
                return yield* new DesktopUseBackendError({
                  backend,
                  operation: "capture",
                  cause: new Error(`${spec.command} exited with code ${code}.`),
                });
              }
              const bytes = yield* fileSystem
                .readFile(path)
                .pipe(
                  Effect.mapError(
                    (cause) => new DesktopUseBackendError({ backend, operation: "capture", cause }),
                  ),
                );
              if (readPngSize(bytes) === null) {
                return yield* new DesktopUseBackendError({
                  backend,
                  operation: "capture",
                  cause: new Error(`${spec.command} did not produce a readable PNG.`),
                });
              }
              return bytes;
            }),
          ),
        );
        if (outcome._tag === "Success") return outcome.success;
        lastFailure = outcome.failure as DesktopUseBackendError;
      }
      return yield* (
        lastFailure ??
          new DesktopUseBackendError({
            backend,
            operation: "capture",
            cause: new Error("No capture backend succeeded."),
          })
      );
    });

  const captureOnce: (
    displayId: string | undefined,
  ) => Effect.Effect<DesktopCaptureResult, DesktopUseUnavailableError | DesktopUseBackendError> =
    Effect.fn("DesktopDriver.captureOne")(function* (displayId) {
      const reason = unavailableReason();
      if (reason !== null) {
        return yield* new DesktopUseUnavailableError({ platform, reason });
      }
      const png = yield* runCaptureCommand(displayId);
      const size = readPngSize(png);
      if (size === null) {
        return yield* new DesktopUseBackendError({
          backend,
          operation: "capture",
          cause: new Error("Capture did not produce a readable PNG."),
        });
      }
      const status = yield* probeDisplays;
      const display = resolveDisplay(status.displays, displayId, size);
      const cursor = yield* readCursor;
      return {
        png,
        display: { ...display, width: size.width, height: size.height },
        ...(cursor === undefined ? {} : { cursor }),
      };
    });

  const readCursor: Effect.Effect<DesktopUseCursor | undefined> = Effect.gen(function* () {
    const spec = buildCursorCommand(tooling);
    if (spec === null) return undefined;
    const raw = yield* runString(spec).pipe(Effect.catch(() => Effect.succeed("")));
    if (raw.length === 0) return undefined;
    const parsed = backend === "linux-x11" ? parseXdotoolCursor(raw) : parseCommaCursor(raw);
    return parsed ?? undefined;
  });

  const input: DesktopDriverShape["input"] = Effect.fn("DesktopDriver.input")(function* (request) {
    const reason = unavailableReason();
    if (reason !== null) {
      return yield* new DesktopUseUnavailableError({ platform, reason });
    }
    const action = request.action;
    const commands = action.type.startsWith("pointer.")
      ? buildPointerCommands(
          tooling,
          action as Extract<DesktopUseAction, { type: `pointer.${string}` }>,
        )
      : action.type.startsWith("keyboard.")
        ? buildKeyboardCommands(
            tooling,
            action as Extract<DesktopUseAction, { type: "keyboard.type" | "keyboard.key" }>,
          )
        : action.type === "window.focus"
          ? [buildFocusWindowCommand(tooling, action.windowId)].filter(
              (spec): spec is DesktopCommand => spec !== null,
            )
          : [];
    if (commands.length === 0) {
      return yield* new DesktopUseBackendError({
        backend,
        operation: action.type,
        cause: new Error("The selected backend does not support this action."),
      });
    }
    for (const spec of commands) {
      const code = yield* runExit(spec).pipe(
        Effect.catch((cause) =>
          Effect.fail(new DesktopUseBackendError({ backend, operation: action.type, cause })),
        ),
      );
      if (code !== 0) {
        return yield* new DesktopUseBackendError({
          backend,
          operation: action.type,
          cause: new Error(`${spec.command} exited with code ${code}.`),
        });
      }
    }
    return yield* readCursor;
  });

  const listWindows: DesktopDriverShape["listWindows"] = Effect.fn("DesktopDriver.listWindows")(
    function* () {
      const reason = unavailableReason();
      if (reason !== null) {
        return yield* new DesktopUseUnavailableError({ platform, reason });
      }
      const spec = buildListWindowsCommand(tooling);
      if (spec === null) return [];
      const raw = yield* runString(spec).pipe(
        Effect.catch((cause) =>
          Effect.fail(new DesktopUseBackendError({ backend, operation: "windows", cause })),
        ),
      );
      if (backend === "linux-x11") return parseWmctrlWindows(raw);
      return parseJsonWindows(raw);
    },
  );

  return DesktopDriver.of({
    getStatus: () => getStatus,
    capture: (request) => captureOnce(request.displayId),
    input,
    listWindows,
  });
});

export const layer = Layer.effect(DesktopDriver, make());
