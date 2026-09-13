import type {
  DesktopUseCaptureInput,
  DesktopUseFrame,
  DesktopUseInputRequest,
  DesktopUseInputResult,
  DesktopUseStatus,
  DesktopUseSubscribeFramesInput,
  DesktopUseWindow,
} from "@t3tools/contracts";
import { DesktopUsePolicyError } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as Semaphore from "effect/Semaphore";
import * as Option from "effect/Option";

import * as DesktopDriverModule from "./DesktopDriver.ts";
import {
  checkRateLimit,
  validateDesktopUseAction,
  type DesktopUseRateLimitState,
} from "./policy.ts";

export interface DesktopUseShape {
  readonly getStatus: () => Effect.Effect<DesktopUseStatus>;
  readonly capture: (
    input: DesktopUseCaptureInput,
  ) => Effect.Effect<
    DesktopUseFrame,
    DesktopUsePolicyError | import("@t3tools/contracts").DesktopUseError
  >;
  readonly input: (
    request: DesktopUseInputRequest,
  ) => Effect.Effect<
    DesktopUseInputResult,
    DesktopUsePolicyError | import("@t3tools/contracts").DesktopUseError
  >;
  readonly listWindows: () => Effect.Effect<
    ReadonlyArray<DesktopUseWindow>,
    import("@t3tools/contracts").DesktopUseError
  >;
  readonly subscribeFrames: (
    input: DesktopUseSubscribeFramesInput,
  ) => Stream.Stream<
    DesktopUseFrame,
    DesktopUsePolicyError | import("@t3tools/contracts").DesktopUseError
  >;
}

/** Product-facing desktop use: driver plus the safety policy every caller shares. */
export class DesktopUse extends Context.Service<DesktopUse, DesktopUseShape>()(
  "t3/jarvis/desktopUse/DesktopUse",
) {}

export const make = Effect.fn("DesktopUse.make")(function* () {
  const driver = yield* DesktopDriverModule.DesktopDriver;
  const rateLimit = yield* Ref.make<DesktopUseRateLimitState>({ lastActionAt: 0 });
  const admission = yield* Semaphore.make(16);
  const desktop = yield* Semaphore.make(1);
  const serialized = <A, E, R>(operation: Effect.Effect<A, E, R>) =>
    admission
      .withPermitsIfAvailable(1)(desktop.withPermits(1)(operation))
      .pipe(
        Effect.flatMap(
          Option.match({
            onSome: Effect.succeed,
            onNone: () =>
              Effect.fail(
                new DesktopUsePolicyError({
                  reason:
                    "The desktop input queue is full; retry after the current action finishes",
                }),
              ),
          }),
        ),
      );

  const getStatus: DesktopUseShape["getStatus"] = () => driver.getStatus();

  const capture: DesktopUseShape["capture"] = Effect.fn("DesktopUse.capture")(function* (input) {
    const result = yield* driver.capture(
      input.displayId === undefined ? {} : { displayId: input.displayId },
    );
    const capturedAt = yield* Clock.currentTimeMillis;
    const frame: DesktopUseFrame = {
      displayId: result.display.id,
      width: result.display.width,
      height: result.display.height,
      scale: result.display.scale,
      mimeType: "image/png",
      data: Buffer.from(result.png).toString("base64"),
      capturedAt,
    };
    return result.cursor === undefined ? frame : { ...frame, cursor: result.cursor };
  });

  const input: DesktopUseShape["input"] = Effect.fn("DesktopUse.input")(function* (request) {
    const reason = validateDesktopUseAction(request.action);
    if (reason !== null) {
      return yield* new DesktopUsePolicyError({ reason, actionType: request.action.type });
    }
    const now = yield* Clock.currentTimeMillis;
    const limit = yield* Ref.modify(rateLimit, (state) => {
      const checked = checkRateLimit(state, now);
      return [checked, checked.next] as const;
    });
    if (limit.reason !== null) {
      return yield* new DesktopUsePolicyError({
        reason: limit.reason,
        actionType: request.action.type,
      });
    }
    const action = request.action;
    const target =
      request.displayId === undefined ? { action } : { displayId: request.displayId, action };
    const cursor = yield* driver.input(target);
    return cursor === undefined ? {} : { cursor };
  });

  const listWindows: DesktopUseShape["listWindows"] = () => driver.listWindows();

  /**
   * Streams frames at a bounded cadence while a controller is watching. The
   * stream stops capturing the instant the subscription ends, so an idle
   * viewer never keeps the capture backend busy.
   */
  const subscribeFrames: DesktopUseShape["subscribeFrames"] = (input) => {
    const intervalMs = input.intervalMs ?? 500;
    const frame = serialized(
      capture(input.displayId === undefined ? {} : { displayId: input.displayId }),
    );
    return Stream.tick(intervalMs).pipe(Stream.mapEffect(() => frame));
  };

  return DesktopUse.of({
    getStatus,
    capture: (request) => serialized(capture(request)),
    input: (request) => serialized(input(request)),
    listWindows,
    subscribeFrames,
  });
});

export const layer = Layer.effect(DesktopUse, make()).pipe(
  Layer.provide(DesktopDriverModule.layer),
);
