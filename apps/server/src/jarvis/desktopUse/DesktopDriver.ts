import {
  DesktopUseBackendError,
  DesktopUseDisplayNotFoundError,
  DesktopUsePolicyError,
  DesktopUseUnavailableError,
  type DesktopUseAction,
  type DesktopUseCursor,
  type DesktopUseDisplay,
  type DesktopUseError,
  type DesktopUsePlatform,
  type DesktopUseStatus,
  type DesktopUseWindow,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as ServerConfig from "../../config.ts";
import * as Commands from "./DesktopCommands.ts";
import {
  buildCaptureCommands,
  buildNativeDragCommand,
  buildCursorCommand,
  buildDisplayGeometryCommand,
  buildFocusWindowCommand,
  buildGnomeDisplayCommand,
  buildKeyboardCommands,
  buildKeyboardReleaseCommands,
  buildListWindowsCommand,
  buildMacReadinessCommand,
  buildPointerCommands,
  DESKTOP_TOOL_NAMES,
  detectDisplayServer,
  hasTool,
  resolveBackend,
  type DesktopCommand,
  type DesktopTooling,
  type DesktopToolName,
} from "./platforms.ts";
import {
  parseCommaCursor,
  parseJsonWindows,
  parseNativeDisplays,
  parseWlrDisplays,
  parseWmctrlWindows,
  parseXdotoolCursor,
  parseXrandrDisplays,
} from "./parsers.ts";
import { normalizeFrame } from "./frames.ts";
import { resolveDisplay } from "./policy.ts";

export interface DesktopCaptureResult {
  readonly png: Uint8Array;
  readonly display: DesktopUseDisplay;
  readonly cursor?: DesktopUseCursor;
}
export interface DesktopDriverShape {
  readonly getStatus: () => Effect.Effect<DesktopUseStatus>;
  readonly capture: (input: {
    readonly displayId?: string;
  }) => Effect.Effect<DesktopCaptureResult, DesktopUseError>;
  readonly input: (input: {
    readonly displayId?: string;
    readonly action: DesktopUseAction;
  }) => Effect.Effect<DesktopUseCursor | undefined, DesktopUseError>;
  readonly listWindows: () => Effect.Effect<ReadonlyArray<DesktopUseWindow>, DesktopUseError>;
}
export class DesktopDriver extends Context.Service<DesktopDriver, DesktopDriverShape>()(
  "t3/jarvis/desktopUse/DesktopDriver",
) {}

const decodePermission = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ capture: Schema.Boolean, input: Schema.Boolean })),
);

export const make = Effect.fn("DesktopDriver.make")(function* () {
  const host = yield* HostProcessPlatform;
  const platform: DesktopUsePlatform =
    host === "darwin" || host === "linux" || host === "win32" ? host : "unsupported";
  const env = yield* HostProcessEnvironment;
  const backend = resolveBackend({ platform: host, displayServer: detectDisplayServer(env) });
  const runner = yield* Commands.DesktopCommands;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  if (config.jarvisNodePreset === "headless") {
    const reason = "The Headless preset does not provide desktop capture or control";
    const unavailable = new DesktopUseUnavailableError({ platform, reason });
    return DesktopDriver.of({
      getStatus: () =>
        Effect.succeed({
          available: false,
          platform,
          backend: "unavailable",
          displays: [],
          reason,
          supports: { capture: false, pointer: false, keyboard: false, windows: false },
        }),
      capture: () => Effect.fail(unavailable),
      input: () => Effect.fail(unavailable),
      listWindows: () => Effect.fail(unavailable),
    });
  }
  const error = (operation: string, cause: unknown) =>
    new DesktopUseBackendError({ backend, operation, cause });
  const unavailable = (reason: string) => new DesktopUseUnavailableError({ platform, reason });
  const run = (spec: DesktopCommand, operation: string, timeout = 5000) =>
    runner
      .run(spec, backend, operation, timeout)
      .pipe(
        Effect.flatMap((result) =>
          result.code === 0
            ? Effect.succeed(result.stdout)
            : Effect.fail(
                error(
                  operation,
                  new Error(
                    `${spec.command} exited ${result.code}: ${result.stderr.slice(0, 500)}`,
                  ),
                ),
              ),
        ),
      );
  const installed = yield* Effect.cached(
    Effect.gen(function* () {
      const tools = new Set<DesktopToolName>();
      if (backend === "macos") {
        tools.add("screencapture");
        tools.add("osascript");
      } else if (backend === "windows") tools.add("powershell");
      else if (backend !== "unavailable") {
        const names = DESKTOP_TOOL_NAMES.filter(
          (name) => !["osascript", "screencapture", "powershell"].includes(name),
        );
        const output = yield* run(
          {
            command: "sh",
            args: [
              "-c",
              `for tool in ${names.join(" ")}; do command -v "$tool" >/dev/null 2>&1 && printf '%s\\n' "$tool"; done; true`,
            ],
          },
          "discover tools",
        );
        for (const name of names) if (output.split("\n").includes(name)) tools.add(name);
      }
      return {
        platform,
        backend,
        tools,
        ...(env.DISPLAY ? { xDisplay: env.DISPLAY } : {}),
      } satisfies DesktopTooling;
    }),
  );
  let pendingRelease: ReadonlyArray<DesktopCommand> = [];
  const release = Effect.gen(function* () {
    if (!pendingRelease.length) return;
    for (const spec of pendingRelease) yield* run(spec, "release injected input");
    pendingRelease = [];
  });
  const protect = <A>(
    body: Effect.Effect<A, DesktopUseError>,
    cleanup: ReadonlyArray<DesktopCommand>,
  ) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        pendingRelease = cleanup;
        const value = yield* restore(body).pipe(
          Effect.ensuring(
            release.pipe(
              Effect.catch((cause) =>
                Effect.logWarning(
                  "Desktop input release failed; further input will retry cleanup",
                  { cause },
                ),
              ),
            ),
          ),
        );
        if (pendingRelease.length)
          return yield* error(
            "release injected input",
            new Error("Cleanup is pending; no new input will be injected until release succeeds"),
          );
        return value;
      }),
    );
  const tooling = Effect.gen(function* () {
    const base = yield* installed;
    if (backend !== "linux-wayland") return base;
    const tools = new Set(base.tools);
    if (tools.has("wtype")) {
      const ready = yield* run(
        { command: "wtype", args: ["-s", "1"] },
        "check Wayland keyboard",
      ).pipe(Effect.result);
      if (ready._tag === "Failure") tools.delete("wtype");
    }
    if (tools.has("ydotool")) {
      const ready = yield* run({ command: "ydotool", args: ["debug"] }, "check input daemon").pipe(
        Effect.result,
      );
      if (ready._tag === "Failure") tools.delete("ydotool");
    }
    return { ...base, tools };
  });
  const catalog = (tools: DesktopTooling) =>
    Effect.gen(function* () {
      if (backend === "unavailable")
        return yield* unavailable("No supported graphical session is available on this node");
      const probe = buildDisplayGeometryCommand(tools);
      let displays: ReadonlyArray<DesktopUseDisplay> = [];
      if (probe) {
        const raw = yield* run(probe, "query displays").pipe(
          Effect.catch(() => Effect.succeed("")),
        );
        displays =
          backend === "linux-x11"
            ? parseXrandrDisplays(raw)
            : backend === "linux-wayland"
              ? parseWlrDisplays(raw)
              : parseNativeDisplays(raw);
      }
      if (!displays.length && backend === "linux-wayland" && hasTool(tools, "gjs"))
        displays = yield* run(buildGnomeDisplayCommand(), "query GNOME displays").pipe(
          Effect.map(parseNativeDisplays),
          Effect.catch(() => Effect.succeed([])),
        );
      if (!displays.length)
        return yield* unavailable(
          backend === "linux-wayland"
            ? "Cannot query compositor displays; install wlr-randr (wlroots) or gjs (GNOME), and run the node in the graphical session"
            : "Cannot query the graphical session's displays",
        );
      return displays;
    });
  const target = (displays: ReadonlyArray<DesktopUseDisplay>, id: string | undefined) => {
    const found = resolveDisplay(displays, id);
    return found
      ? Effect.succeed(found)
      : id
        ? Effect.fail(new DesktopUseDisplayNotFoundError({ displayId: id }))
        : Effect.fail(unavailable("No connected display"));
  };
  const cursor = (tools: DesktopTooling, display: DesktopUseDisplay) =>
    Effect.gen(function* () {
      const spec = buildCursorCommand(tools);
      if (!spec) return undefined;
      const raw = yield* run(spec, "read pointer").pipe(Effect.catch(() => Effect.succeed("")));
      const position = backend === "linux-x11" ? parseXdotoolCursor(raw) : parseCommaCursor(raw);
      return position ? { x: position.x - display.x, y: position.y - display.y } : undefined;
    });
  const captureDisplay = (
    tools: DesktopTooling,
    displays: ReadonlyArray<DesktopUseDisplay>,
    display: DesktopUseDisplay,
  ) =>
    Effect.gen(function* () {
      const candidates = buildCaptureCommands(tools, { outPath: "unused.png", display });
      if (!candidates.length)
        return yield* unavailable(
          "No native screenshot helper is installed for this graphical session",
        );
      let last: DesktopUseError | undefined;
      for (let i = 0; i < candidates.length; i++) {
        const result = yield* Effect.scoped(
          Effect.gen(function* () {
            const directory = yield* fs
              .makeTempDirectoryScoped({ directory: config.stateDir, prefix: ".desktop-use-" })
              .pipe(Effect.mapError((cause) => error("capture", cause)));
            const outPath = path.join(directory, "capture.png");
            const spec = buildCaptureCommands(tools, { outPath, display })[i]!;
            yield* run(spec, "capture", 10000);
            const stat = yield* fs
              .stat(outPath)
              .pipe(Effect.mapError((cause) => error("capture", cause)));
            if (Number(stat.size) > 64_000_000)
              return yield* error("capture", new Error("Screenshot exceeds the size limit"));
            const bytes = yield* fs
              .readFile(outPath)
              .pipe(Effect.mapError((cause) => error("capture", cause)));
            return yield* Effect.tryPromise({
              try: () => normalizeFrame(bytes, display, displays, spec.area),
              catch: (cause) => error("capture", cause),
            });
          }),
        ).pipe(Effect.result);
        if (result._tag === "Success") return result.success;
        last = result.failure;
      }
      return yield* last ?? unavailable("Native screenshot capture failed");
    });
  const capture: DesktopDriverShape["capture"] = Effect.fn(function* (request) {
    const tools = yield* tooling,
      displays = yield* catalog(tools),
      display = yield* target(displays, request.displayId);
    const png = yield* captureDisplay(tools, displays, display);
    const position = yield* cursor(tools, display);
    return { png, display: { ...display, scale: 1 }, ...(position ? { cursor: position } : {}) };
  });
  let cachedStatus: { at: number; status: DesktopUseStatus } | undefined;
  const statusGate = yield* Semaphore.make(1);
  const getStatus = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    if (cachedStatus && now - cachedStatus.at < 3000 && !pendingRelease.length)
      return cachedStatus.status;
    // Serialize uncached probes so concurrent status calls cannot launch
    // parallel helper processes; capture and input share the same desktop.
    return yield* statusGate.withPermits(1)(
      Effect.gen(function* () {
        const at = yield* Clock.currentTimeMillis;
        if (cachedStatus && at - cachedStatus.at < 3000 && !pendingRelease.length)
          return cachedStatus.status;
        const result = yield* Effect.gen(function* () {
          const tools = yield* tooling,
            displays = yield* catalog(tools),
            primary = yield* target(displays, undefined);
          // Readiness is a helper and permission question, not a capture.
          // Taking a screenshot here would block the loop and duplicate work.
          let captureReady =
            buildCaptureCommands(tools, { outPath: "unused.png", display: primary }).length > 0;
          let pointer =
            backend === "macos" ||
            backend === "windows" ||
            hasTool(tools, backend === "linux-wayland" ? "ydotool" : "xdotool");
          let keyboard =
            backend === "macos" ||
            backend === "windows" ||
            (backend === "linux-x11"
              ? hasTool(tools, "xdotool")
              : hasTool(tools, "wtype") || hasTool(tools, "ydotool"));
          if (backend === "macos") {
            const raw = yield* run(buildMacReadinessCommand(), "check macOS permissions");
            const permission = yield* decodePermission(raw).pipe(
              Effect.mapError((cause) => error("check permissions", cause)),
            );
            if (!permission.capture)
              return yield* unavailable(
                "Screen Recording permission is required for the node's screenshot helper",
              );
            captureReady = true;
            pointer = keyboard = permission.input === true;
          }
          if (!captureReady)
            return yield* unavailable(
              "No native screenshot helper is installed for this graphical session",
            );
          const reason = pendingRelease.length
            ? "Input cleanup is pending; the next input request will retry release"
            : !pointer || !keyboard
              ? "Capture is available; one or more input helpers or permissions are unavailable"
              : undefined;
          return {
            available: true,
            platform,
            backend,
            displays,
            supports: {
              capture: true,
              pointer: pointer && !pendingRelease.length,
              keyboard: keyboard && !pendingRelease.length,
              windows: buildListWindowsCommand(tools) !== null,
            },
            ...(reason ? { reason } : {}),
          } satisfies DesktopUseStatus;
        }).pipe(Effect.result);
        const status: DesktopUseStatus =
          result._tag === "Success"
            ? result.success
            : {
                available: false,
                platform,
                backend,
                reason: result.failure.message,
                displays: [],
                supports: { capture: false, pointer: false, keyboard: false, windows: false },
              };
        cachedStatus = { at, status };
        return status;
      }),
    );
  });
  const execute = (specs: ReadonlyArray<DesktopCommand>, operation: string) =>
    Effect.gen(function* () {
      if (!specs.length)
        return yield* unavailable(`The selected backend does not support ${operation}`);
      for (const spec of specs) yield* run(spec, operation);
    });
  const translate = (action: DesktopUseAction, display: DesktopUseDisplay): DesktopUseAction => {
    const point = (p: { x: number; y: number }) => ({
      x: Math.round(display.x + p.x),
      y: Math.round(display.y + p.y),
    });
    if (action.type === "pointer.drag")
      return { ...action, from: point(action.from), to: point(action.to) };
    if ("x" in action && action.x !== undefined && action.y !== undefined)
      return { ...action, ...point({ x: action.x, y: action.y }) };
    return action;
  };
  const input: DesktopDriverShape["input"] = Effect.fn(function* (request) {
    yield* release;
    const tools = yield* tooling,
      displays = yield* catalog(tools),
      display = yield* target(displays, request.displayId);
    const requested = request.action;
    const points =
      requested.type === "pointer.drag"
        ? [requested.from, requested.to]
        : "x" in requested && requested.x !== undefined && requested.y !== undefined
          ? [{ x: requested.x, y: requested.y }]
          : [];
    if (
      points.some(
        (p) =>
          Math.round(p.x) < 0 ||
          Math.round(p.y) < 0 ||
          Math.round(p.x) >= display.width ||
          Math.round(p.y) >= display.height,
      )
    )
      return yield* new DesktopUsePolicyError({
        reason: "Pointer target is outside the selected display; capture it again",
        actionType: requested.type,
      });
    if (
      request.displayId !== undefined &&
      (requested.type === "pointer.click" || requested.type === "pointer.scroll") &&
      requested.x === undefined
    ) {
      const current = yield* cursor(tools, display);
      if (
        !current ||
        current.x < 0 ||
        current.y < 0 ||
        current.x >= display.width ||
        current.y >= display.height
      )
        return yield* new DesktopUsePolicyError({
          reason:
            "Supply coordinates on the selected display; the current pointer is elsewhere or unavailable",
          actionType: requested.type,
        });
    }
    const action = translate(requested, display);
    if (action.type === "pointer.drag") {
      const button = action.button ?? "left",
        duration = action.durationMs ?? 250,
        steps = Math.max(1, Math.min(30, Math.ceil(duration / 25)));
      const cleanup = buildPointerCommands(tools, { type: "pointer.up", button });
      const native = buildNativeDragCommand(tools, action);
      if (native) yield* protect(run(native, "drag pointer", duration + 10000), cleanup);
      else {
        yield* execute(
          buildPointerCommands(tools, { type: "pointer.move", ...action.from }),
          "move to drag start",
        );
        yield* protect(
          Effect.gen(function* () {
            yield* execute(
              buildPointerCommands(tools, { type: "pointer.down", button }),
              "press drag button",
            );
            for (let i = 1; i <= steps; i++) {
              if (duration) yield* Effect.sleep(duration / steps);
              yield* execute(
                buildPointerCommands(
                  tools,
                  {
                    type: "pointer.move",
                    x: action.from.x + ((action.to.x - action.from.x) * i) / steps,
                    y: action.from.y + ((action.to.y - action.from.y) * i) / steps,
                  },
                  button,
                ),
                "drag pointer",
              );
            }
          }),
          cleanup,
        );
      }
    } else if (action.type === "pointer.move" && action.durationMs) {
      const from = yield* cursor(tools, display);
      if (!from)
        return yield* unavailable(
          "Timed movement requires a backend that can read the current pointer position",
        );
      const steps = Math.max(1, Math.min(30, Math.ceil(action.durationMs / 25)));
      for (let i = 1; i <= steps; i++) {
        yield* Effect.sleep(action.durationMs / steps);
        yield* execute(
          buildPointerCommands(tools, {
            type: "pointer.move",
            x: display.x + from.x + ((action.x - display.x - from.x) * i) / steps,
            y: display.y + from.y + ((action.y - display.y - from.y) * i) / steps,
          }),
          "move pointer",
        );
      }
    } else if (action.type === "keyboard.type" || action.type === "keyboard.key") {
      const commands = buildKeyboardCommands(tools, action);
      if (!commands.length)
        return yield* unavailable("The selected keyboard backend does not support this input");
      yield* protect(execute(commands, action.type), buildKeyboardReleaseCommands(tools, action));
    } else if (action.type === "window.focus") {
      const list = buildListWindowsCommand(tools);
      if (!list) return yield* unavailable("Window discovery is unsupported by this compositor");
      const raw = yield* run(list, "list windows");
      const windows = backend === "linux-x11" ? parseWmctrlWindows(raw) : parseJsonWindows(raw);
      if (!windows.some((w) => w.id === action.windowId))
        return yield* new DesktopUsePolicyError({
          reason: "Window is no longer available; list windows again",
          actionType: action.type,
        });
      const spec = buildFocusWindowCommand(tools, action.windowId);
      if (!spec) return yield* unavailable("Window focus is unsupported by this compositor");
      yield* execute([spec], "focus window");
    } else {
      const cleanup =
        action.type === "pointer.click"
          ? buildPointerCommands(tools, { type: "pointer.up", button: action.button })
          : [];
      yield* protect(execute(buildPointerCommands(tools, action), action.type), cleanup);
    }
    cachedStatus = undefined;
    return yield* cursor(tools, display);
  });
  const listWindows: DesktopDriverShape["listWindows"] = () =>
    Effect.gen(function* () {
      const tools = yield* tooling;
      yield* catalog(tools);
      const spec = buildListWindowsCommand(tools);
      if (!spec) return yield* unavailable("Window discovery is unsupported by this compositor");
      const raw = yield* run(spec, "list windows");
      return backend === "linux-x11" ? parseWmctrlWindows(raw) : parseJsonWindows(raw);
    });
  return DesktopDriver.of({ getStatus: () => getStatus, capture, input, listWindows });
});
export const layer = Layer.effect(DesktopDriver, make()).pipe(Layer.provide(Commands.layer));
