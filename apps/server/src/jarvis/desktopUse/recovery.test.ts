import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { type DesktopUseAction } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { PNG } from "pngjs";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Config from "../../config.ts";
import * as Driver from "./DesktopDriver.ts";
import * as Use from "./DesktopUse.ts";
import { DesktopCommands } from "./DesktopCommands.ts";

const base = Config.layerTest(process.cwd(), { prefix: "pr17-recovery-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);
const catalog = "Monitors: 2\n0: +*DP-1 100/100x80/80+0+0 DP-1\n1: +DP-2 100/100x80/80+100+0 DP-2";
const harness = (
  options: {
    noDisplay?: boolean;
    headless?: boolean;
    failMove?: boolean;
    failRelease?: boolean;
    holdMove?: boolean;
    holdKey?: boolean;
  } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const calls: Array<ReadonlyArray<string>> = [];
    const injectionStarted = yield* Deferred.make<void>();
    const png = new PNG({ width: 200, height: 80 });
    for (let y = 0; y < 80; y++)
      for (let x = 0; x < 200; x++) {
        const n = (y * 200 + x) * 4;
        png.data[n] = x < 100 ? 255 : 0;
        png.data[n + 1] = x >= 100 ? 255 : 0;
        png.data[n + 3] = 255;
      }
    const commands: DesktopCommands["Service"] = {
      run: (spec) =>
        Effect.gen(function* () {
          if (spec.command === "sh")
            return { code: 0, stdout: "xdotool\nxrandr\nimport", stderr: "" };
          if (spec.command === "xrandr")
            return { code: 0, stdout: options.noDisplay ? "" : catalog, stderr: "" };
          calls.push([spec.command, ...spec.args]);
          if (spec.command === "import") {
            yield* fs.writeFile(spec.args.at(-1)!, PNG.sync.write(png)).pipe(Effect.orDie);
            return { code: 0, stdout: "", stderr: "" };
          }
          if (spec.args[0] === "getmouselocation")
            return { code: 0, stdout: "X=110\nY=10", stderr: "" };
          if (spec.args[0] === "mousemove" && calls.some((c) => c.includes("mousedown"))) {
            yield* Deferred.succeed(injectionStarted, undefined);
            if (options.holdMove) return yield* Effect.never;
            if (options.failMove) return { code: 1, stdout: "", stderr: "injected move failure" };
          }
          if (spec.args[0] === "type" && options.holdKey) {
            yield* Deferred.succeed(injectionStarted, undefined);
            return yield* Effect.never;
          }
          if (spec.args[0] === "mouseup" && options.failRelease)
            return { code: 1, stdout: "", stderr: "release unavailable" };
          return { code: 0, stdout: "", stderr: "" };
        }),
    };
    const config = yield* Config.ServerConfig;
    const driver = yield* Driver.make().pipe(
      Effect.provideService(Config.ServerConfig, {
        ...config,
        ...(options.headless ? { jarvisNodePreset: "headless" as const } : {}),
      }),
      Effect.provideService(DesktopCommands, commands),
      Effect.provideService(HostProcessEnvironment, options.noDisplay ? {} : { DISPLAY: ":1" }),
      Effect.provideService(HostProcessPlatform, "linux"),
    );
    return { driver, calls, injectionStarted };
  });
const drag: DesktopUseAction = {
  type: "pointer.drag",
  from: { x: 1, y: 1 },
  to: { x: 9, y: 9 },
  durationMs: 0,
};

it.effect("failed X11 drag releases its button", () =>
  Effect.gen(function* () {
    const { driver, calls } = yield* harness({ failMove: true });
    const result = yield* driver.input({ action: drag }).pipe(Effect.result);
    expect(result._tag).toBe("Failure");
    expect(calls.some((c) => c.includes("mousedown"))).toBe(true);
    expect(calls.at(-1)).toEqual(["xdotool", "mouseup", "1"]);
  }).pipe(Effect.provide(base)),
);

it.effect("cancelled drag releases before interruption completes", () =>
  Effect.gen(function* () {
    const { driver, calls, injectionStarted } = yield* harness({ holdMove: true });
    const fiber = yield* driver.input({ action: drag }).pipe(Effect.forkChild);
    yield* Deferred.await(injectionStarted);
    yield* Fiber.interrupt(fiber);
    expect(calls.at(-1)).toEqual(["xdotool", "mouseup", "1"]);
  }).pipe(Effect.provide(base)),
);

it.effect("failed release prevents subsequent injection and recovers when release works", () =>
  Effect.gen(function* () {
    const options = { failMove: true, failRelease: true };
    const { driver, calls } = yield* harness(options);
    yield* driver.input({ action: drag }).pipe(Effect.result);
    const before = calls.length;
    const blocked = yield* driver
      .input({ action: { type: "keyboard.type", text: "must not type" } })
      .pipe(Effect.result);
    expect(blocked._tag).toBe("Failure");
    expect(calls.slice(before)).toEqual([["xdotool", "mouseup", "1"]]);
    options.failRelease = false;
    yield* driver.input({ action: { type: "keyboard.type", text: "recovered" } });
    expect(calls.some((c) => c.includes("recovered"))).toBe(true);
  }).pipe(Effect.provide(base)),
);

it.effect("unknown display is rejected before capture or input", () =>
  Effect.gen(function* () {
    const { driver, calls } = yield* harness();
    const capture = yield* driver.capture({ displayId: "disconnected" }).pipe(Effect.flip);
    const input = yield* driver
      .input({ displayId: "disconnected", action: { type: "pointer.click", x: 1, y: 1 } })
      .pipe(Effect.flip);
    expect(capture._tag).toBe("DesktopUseDisplayNotFoundError");
    expect(input._tag).toBe("DesktopUseDisplayNotFoundError");
    expect(calls).toEqual([]);
  }).pipe(Effect.provide(base)),
);

it.effect("selected display is cropped and local input gets its native origin", () =>
  Effect.gen(function* () {
    const { driver, calls } = yield* harness();
    const frame = yield* driver.capture({ displayId: "DP-2" });
    const png = PNG.sync.read(Buffer.from(frame.png));
    expect([png.width, png.height]).toEqual([100, 80]);
    expect([...png.data.subarray(0, 4)]).toEqual([0, 255, 0, 255]);
    expect(frame.display.id).toBe("DP-2");
    expect(frame.cursor).toEqual({ x: 10, y: 10 });
    yield* driver.input({ displayId: "DP-2", action: { type: "pointer.click", x: 5, y: 6 } });
    expect(calls).toContainEqual(["xdotool", "mousemove", "105", "6"]);
  }).pipe(Effect.provide(base)),
);

it.effect("no graphical session reports unavailable even if tools are installed", () =>
  Effect.gen(function* () {
    const { driver } = yield* harness({ noDisplay: true });
    expect((yield* driver.getStatus()).available).toBe(false);
  }).pipe(Effect.provide(base)),
);

it.effect("accepted actions never overlap and a cancelled waiter never injects", () =>
  Effect.gen(function* () {
    const { driver } = yield* harness();
    const started = yield* Deferred.make<void>();
    let active = 0,
      peak = 0;
    const texts: Array<string> = [];
    const use = yield* Use.make().pipe(
      Effect.provideService(Driver.DesktopDriver, {
        ...driver,
        input: (request) =>
          Effect.gen(function* () {
            active++;
            peak = Math.max(peak, active);
            if (request.action.type === "keyboard.type") texts.push(request.action.text);
            yield* Deferred.succeed(started, undefined);
            yield* Effect.sleep("100 millis");
            active--;
            return undefined;
          }),
      }),
    );
    yield* TestClock.adjust("1 second");
    const first = yield* use
      .input({ action: { type: "keyboard.type", text: "first" } })
      .pipe(Effect.forkChild);
    yield* Deferred.await(started);
    yield* TestClock.adjust("10 millis");
    const cancelled = yield* use
      .input({ action: { type: "keyboard.type", text: "cancelled" } })
      .pipe(Effect.forkChild);
    yield* Fiber.interrupt(cancelled);
    const second = yield* use
      .input({ action: { type: "keyboard.type", text: "second" } })
      .pipe(Effect.forkChild);
    yield* TestClock.adjust("1 second");
    yield* Fiber.join(first);
    yield* Fiber.join(second);
    expect(peak).toBe(1);
    expect(texts).toEqual(["first", "second"]);
  }).pipe(Effect.provide(base)),
);

it.effect("cancelled typing releases its injected characters before the next caller", () =>
  Effect.gen(function* () {
    const { driver, calls, injectionStarted } = yield* harness({ holdKey: true });
    const fiber = yield* driver
      .input({ action: { type: "keyboard.type", text: "Ab" } })
      .pipe(Effect.forkChild);
    yield* Deferred.await(injectionStarted);
    yield* Fiber.interrupt(fiber);
    expect(calls.at(-1)).toEqual(["xdotool", "keyup", "--delay", "0", "U41", "U62", "Shift_L"]);
  }).pipe(Effect.provide(base)),
);
it.effect("refuses coordinates outside the selected frame before injecting", () =>
  Effect.gen(function* () {
    const { driver, calls } = yield* harness();
    const failure = yield* driver
      .input({ displayId: "DP-1", action: { type: "pointer.click", x: 100, y: 1 } })
      .pipe(Effect.flip);
    expect(failure._tag).toBe("DesktopUsePolicyError");
    expect(calls).toEqual([]);
  }).pipe(Effect.provide(base)),
);

it.effect("Headless refuses every desktop path without spawning a helper", () =>
  Effect.gen(function* () {
    const { driver, calls } = yield* harness({ headless: true });
    expect((yield* driver.getStatus()).available).toBe(false);
    for (const operation of [
      driver.capture({}).pipe(Effect.asVoid),
      driver.input({ action: { type: "pointer.click", x: 1, y: 1 } }).pipe(Effect.asVoid),
      driver.listWindows().pipe(Effect.asVoid),
    ]) {
      const result = yield* operation.pipe(Effect.result);
      expect(result._tag).toBe("Failure");
    }
    expect(calls).toEqual([]);
  }).pipe(Effect.provide(base)),
);

it.effect("an explicit display cannot redirect a positionless click to another monitor", () =>
  Effect.gen(function* () {
    const { driver, calls } = yield* harness();
    const failure = yield* driver
      .input({ displayId: "DP-1", action: { type: "pointer.click" } })
      .pipe(Effect.flip);
    expect(failure._tag).toBe("DesktopUsePolicyError");
    expect(calls.some((c) => c.includes("click"))).toBe(false);
  }).pipe(Effect.provide(base)),
);
