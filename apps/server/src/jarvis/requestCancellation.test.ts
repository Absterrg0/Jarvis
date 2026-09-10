import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import {
  beginCommit,
  cancelPreAccept,
  closeCommit,
  finishCommit,
  makeJarvisRequestCancellationState,
  trackPreAccept,
  type JarvisPreAcceptLease,
} from "./requestCancellation.ts";

const identity = {
  threadId: "thread-1" as never,
  projectId: "project-1" as never,
};

const leaseOf = (outcome: { readonly status: string; readonly lease?: JarvisPreAcceptLease }) => {
  if (outcome.status !== "tracked" || outcome.lease === undefined) {
    throw new Error(`expected tracked owner lease, got ${outcome.status}`);
  }
  return outcome.lease;
};

describe("Jarvis pre-accept request cancellation", () => {
  it.effect("reports unknown for a key that was never tracked", () =>
    Effect.gen(function* () {
      const state = yield* makeJarvisRequestCancellationState();
      // Unknown stays unknown, never cancelled: the first pre-register
      // cancel leaves a tombstone but does not claim work.
      expect(
        yield* cancelPreAccept(state, "jarvis:request:node:origin:interaction:missing"),
      ).toEqual({ status: "unknown" });
    }),
  );

  it.effect("passes effects through untracked without a request identity", () =>
    Effect.gen(function* () {
      const state = yield* makeJarvisRequestCancellationState();
      const outcome = yield* trackPreAccept(state, undefined, Effect.succeed("value"));
      expect(outcome).toEqual({ status: "untracked", value: "value" });
      expect(yield* cancelPreAccept(state, "any")).toEqual({ status: "unknown" });
    }),
  );

  it.effect("aborts the in-flight interpretation and never lets it commit", () =>
    Effect.gen(function* () {
      const state = yield* makeJarvisRequestCancellationState();
      const key = "jarvis:request:node:origin:interaction:cancel-me";
      let interpreted = false;
      let interrupted = false;
      const gate = yield* Deferred.make<void>();
      const fiber = yield* Effect.forkChild(
        trackPreAccept(
          state,
          key,
          Deferred.await(gate).pipe(
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                interrupted = true;
              }),
            ),
            Effect.andThen(
              Effect.sync(() => {
                interpreted = true;
              }),
            ),
          ),
        ),
      );
      yield* Effect.yieldNow;
      const decision = yield* cancelPreAccept(state, key);
      expect(decision).toEqual({ status: "cancelled" });
      const outcome = yield* Fiber.join(fiber);
      expect(outcome).toEqual({ status: "cancelled" });
      expect(interrupted).toBe(true);
      expect(interpreted).toBe(false);
      // The aborted request can never commit afterwards: no lease survives.
      expect(yield* beginCommit(state, undefined)).toEqual({ proceed: true });
      // A repeated cancel answers the identical stored outcome, not unknown.
      expect(yield* cancelPreAccept(state, key)).toEqual({ status: "cancelled" });
    }),
  );

  it.effect("shares one inference with a concurrent duplicate, no second run", () =>
    Effect.gen(function* () {
      const state = yield* makeJarvisRequestCancellationState();
      const key = "jarvis:request:node:origin:interaction:double";
      const gate = yield* Deferred.make<void>();
      let runs = 0;
      const effect = Deferred.await(gate).pipe(
        Effect.andThen(
          Effect.sync(() => {
            runs += 1;
            return "shared-value";
          }),
        ),
      );
      const first = yield* Effect.forkChild(trackPreAccept(state, key, effect));
      yield* Effect.yieldNow;
      const second = yield* Effect.forkChild(
        trackPreAccept(state, key, Effect.succeed("second-run")),
      );
      yield* Effect.yieldNow;
      // Release the single inference: both await the owner's result.
      yield* Deferred.succeed(gate, undefined);
      const firstOutcome = yield* Fiber.join(first);
      const secondOutcome = yield* Fiber.join(second);
      expect(firstOutcome.status).toBe("tracked");
      expect(secondOutcome).toEqual({ status: "shared", key, value: "shared-value" });
      expect(runs).toBe(1);
      // Only the owner lease proceeds; the shared duplicate holds no lease.
      const ownerLease = leaseOf(firstOutcome);
      expect(yield* beginCommit(state, ownerLease)).toEqual({ proceed: true });
      yield* finishCommit(state, ownerLease, identity);
      expect(yield* cancelPreAccept(state, key)).toEqual({
        status: "already-accepted",
        identity,
      });
    }),
  );

  it.effect("refused duplicate close never removes the original commit", () =>
    Effect.gen(function* () {
      const state = yield* makeJarvisRequestCancellationState();
      const key = "jarvis:request:node:origin:interaction:repro-race";
      const first = yield* trackPreAccept(state, key, Effect.succeed("first"));
      expect(first.status).toBe("tracked");
      const second = yield* trackPreAccept(state, key, Effect.succeed("second"));
      // Single inference: the late duplicate shares instead of tracking.
      expect(second).toEqual({ status: "shared", key, value: "first" });
      const ownerLease = leaseOf(first);
      expect(yield* beginCommit(state, ownerLease)).toEqual({ proceed: true });
      // A refused duplicate holds no lease: its close is a no-op and must
      // not touch the owner's committing slot.
      yield* closeCommit(state, undefined);
      yield* finishCommit(state, ownerLease, identity);
      expect(yield* cancelPreAccept(state, key)).toEqual({
        status: "already-accepted",
        identity,
      });
    }),
  );

  it.effect("owner interruption leaves no record and lets a retry run", () =>
    Effect.gen(function* () {
      const state = yield* makeJarvisRequestCancellationState();
      const key = "jarvis:request:node:origin:interaction:owner-interrupt";
      // Disconnect cause as an effect-level interruption: the interpretation
      // fails with an interrupt exit, cleans owner-only with no record, and
      // shares the interruption instead of running a second inference.
      const fiber = yield* Effect.forkChild(
        trackPreAccept(state, key, Effect.interrupt.pipe(Effect.as("never"))),
      );
      const exit = yield* Fiber.await(fiber);
      expect(exit._tag).toBe("Failure");
      // No acceptance record: late cancel is unknown, not cancelled.
      expect(yield* cancelPreAccept(state, key)).toEqual({ status: "unknown" });
      // Retry after a disconnect runs fresh with its own lease.
      const retry = yield* trackPreAccept(state, key, Effect.succeed("retry-value"));
      expect(retry.status).toBe("tracked");
      const retryLease = leaseOf(retry);
      expect(yield* beginCommit(state, retryLease)).toEqual({ proceed: true });
      yield* finishCommit(state, retryLease, identity);
      expect(yield* cancelPreAccept(state, key)).toEqual({
        status: "already-accepted",
        identity,
      });
    }),
  );

  it.effect("duplicate close during owner interruption stays unknown for late cancel", () =>
    Effect.gen(function* () {
      const state = yield* makeJarvisRequestCancellationState();
      const key = "jarvis:request:node:origin:interaction:dup-interrupt";
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const owner = yield* Effect.forkChild(
        trackPreAccept(
          state,
          key,
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(Effect.interrupt),
            Effect.as("owner-value"),
          ),
        ),
      );
      yield* Deferred.await(entered);
      const duplicate = yield* Effect.forkChild(trackPreAccept(state, key, Effect.succeed("dup")));
      yield* Effect.yieldNow;
      // Duplicate holds no lease: closing it is always a no-op.
      yield* closeCommit(state, undefined);
      yield* Deferred.succeed(release, undefined);
      // Duplicate awaited the owner's interruption and replays it.
      const dupExit = yield* Fiber.await(duplicate);
      expect(dupExit._tag).toBe("Failure");
      const ownerExit = yield* Fiber.await(owner);
      expect(ownerExit._tag).toBe("Failure");
      expect(yield* cancelPreAccept(state, key)).toEqual({ status: "unknown" });
    }),
  );

  it.effect("pre-start cancel tombstones without running the later track", () =>
    Effect.gen(function* () {
      const state = yield* makeJarvisRequestCancellationState();
      const key = "jarvis:request:node:origin:interaction:pre-start";
      // Cancel before register: unknown, not cancelled, but tombstoned.
      expect(yield* cancelPreAccept(state, key)).toEqual({ status: "unknown" });
      let ran = false;
      const tracked = yield* trackPreAccept(
        state,
        key,
        Effect.sync(() => {
          ran = true;
          return "late-value";
        }),
      );
      expect(tracked).toEqual({ status: "cancelled" });
      expect(ran).toBe(false);
      // The tombstone became a recorded cancel: repeats stay cancelled.
      expect(yield* cancelPreAccept(state, key)).toEqual({ status: "cancelled" });
    }),
  );

  it.effect("never runs a retry after a cancelled request", () =>
    Effect.gen(function* () {
      const state = yield* makeJarvisRequestCancellationState();
      const key = "jarvis:request:node:origin:interaction:retry-cancelled";
      const gate = yield* Deferred.make<void>();
      const fiber = yield* Effect.forkChild(trackPreAccept(state, key, Deferred.await(gate)));
      yield* Effect.yieldNow;
      expect(yield* cancelPreAccept(state, key)).toEqual({ status: "cancelled" });
      expect(yield* Fiber.join(fiber)).toEqual({ status: "cancelled" });
      let ran = false;
      const retry = yield* trackPreAccept(
        state,
        key,
        Effect.sync(() => {
          ran = true;
          return "retry-value";
        }),
      );
      expect(retry).toEqual({ status: "cancelled" });
      expect(ran).toBe(false);
    }),
  );

  it.effect("cancels an interpretation that finished but never reached dispatch", () =>
    Effect.gen(function* () {
      const state = yield* makeJarvisRequestCancellationState();
      const key = "jarvis:request:node:origin:interaction:pre-dispatch";
      const outcome = yield* trackPreAccept(state, key, Effect.succeed("interpreted"));
      expect(outcome.status).toBe("tracked");
      const ownerLease = leaseOf(outcome);
      // Interpretation is done but no command was invoked: cancel wins.
      expect(yield* cancelPreAccept(state, key)).toEqual({ status: "cancelled" });
      expect(yield* beginCommit(state, ownerLease)).toEqual({ proceed: false });
    }),
  );

  it.effect("makes a commit cancellation await the exact typed receipt", () =>
    Effect.gen(function* () {
      const state = yield* makeJarvisRequestCancellationState();
      const key = "jarvis:request:node:origin:interaction:committing";
      const outcome = yield* trackPreAccept(state, key, Effect.succeed("interpreted"));
      expect(outcome.status).toBe("tracked");
      const ownerLease = leaseOf(outcome);
      expect(yield* beginCommit(state, ownerLease)).toEqual({ proceed: true });
      const cancelFiber = yield* Effect.forkChild(cancelPreAccept(state, key));
      yield* Effect.yieldNow;
      // The commit is still in progress: no answer yet, and nothing claimed.
      yield* Effect.yieldNow;
      yield* finishCommit(state, ownerLease, identity);
      expect(yield* Fiber.join(cancelFiber)).toEqual({
        status: "already-accepted",
        identity,
      });
    }),
  );

  it.effect("answers unknown when the commit fails instead of claiming acceptance", () =>
    Effect.gen(function* () {
      const state = yield* makeJarvisRequestCancellationState();
      const key = "jarvis:request:node:origin:interaction:failed-commit";
      const outcome = yield* trackPreAccept(state, key, Effect.succeed("interpreted"));
      expect(outcome.status).toBe("tracked");
      const ownerLease = leaseOf(outcome);
      expect(yield* beginCommit(state, ownerLease)).toEqual({ proceed: true });
      const cancelFiber = yield* Effect.forkChild(cancelPreAccept(state, key));
      yield* Effect.yieldNow;
      // The dispatch failed: close the commit the way the execute wrapper
      // does on failure, then the waiter must hear unknown, never accepted.
      yield* closeCommit(state, ownerLease);
      expect(yield* Fiber.join(cancelFiber)).toEqual({ status: "unknown" });
      expect(yield* cancelPreAccept(state, key)).toEqual({ status: "unknown" });
    }),
  );

  it.effect("late cancel after failure stays unknown and retry runs fresh", () =>
    Effect.gen(function* () {
      const state = yield* makeJarvisRequestCancellationState();
      const key = "jarvis:request:node:origin:interaction:late-unknown";
      const outcome = yield* trackPreAccept(state, key, Effect.succeed("interpreted"));
      const ownerLease = leaseOf(outcome);
      expect(yield* beginCommit(state, ownerLease)).toEqual({ proceed: true });
      yield* closeCommit(state, ownerLease);
      expect(yield* cancelPreAccept(state, key)).toEqual({ status: "unknown" });
      const retry = yield* trackPreAccept(state, key, Effect.succeed("retry-value"));
      expect(retry.status).toBe("tracked");
    }),
  );

  it.effect("forgets requests that settle without dispatching work", () =>
    Effect.gen(function* () {
      const state = yield* makeJarvisRequestCancellationState();
      const key = "jarvis:request:node:origin:interaction:clarify";
      const outcome = yield* trackPreAccept(state, key, Effect.succeed("needs-input"));
      expect(outcome.status).toBe("tracked");
      yield* closeCommit(state, leaseOf(outcome));
      expect(yield* cancelPreAccept(state, key)).toEqual({ status: "unknown" });
    }),
  );

  it.effect("lets exactly one owner commit while shared duplicates stay cancelled", () =>
    Effect.gen(function* () {
      const state = yield* makeJarvisRequestCancellationState();
      const key = "jarvis:request:node:origin:interaction:race";
      const first = yield* trackPreAccept(state, key, Effect.succeed("first"));
      const second = yield* trackPreAccept(state, key, Effect.succeed("second"));
      expect(first.status).toBe("tracked");
      // Single inference: the second shares the first value, no second run.
      expect(second).toEqual({ status: "shared", key, value: "first" });
      const ownerLease = leaseOf(first);
      expect(yield* beginCommit(state, ownerLease)).toEqual({ proceed: true });
      yield* finishCommit(state, ownerLease, identity);
      expect(yield* cancelPreAccept(state, key)).toEqual({
        status: "already-accepted",
        identity,
      });
    }),
  );

  it.effect("shares interpretation failure instead of running a second inference", () =>
    Effect.gen(function* () {
      const state = yield* makeJarvisRequestCancellationState();
      const key = "jarvis:request:node:origin:interaction:shared-failure";
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let runs = 0;
      const effect = Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
        Effect.andThen(
          Effect.sync(() => {
            runs += 1;
            return "ok";
          }),
        ),
        Effect.andThen(Effect.fail("interpretation-failed" as const)),
      );
      const first = yield* Effect.forkChild(trackPreAccept(state, key, effect));
      yield* Deferred.await(entered);
      const second = yield* Effect.forkChild(trackPreAccept(state, key, Effect.succeed("dup")));
      yield* Effect.yieldNow;
      yield* Deferred.succeed(release, undefined);
      const firstExit = yield* Fiber.await(first);
      const secondExit = yield* Fiber.await(second);
      expect(firstExit._tag).toBe("Failure");
      expect(secondExit._tag).toBe("Failure");
      expect(runs).toBe(1);
      // Failure leaves no record: late cancel is unknown, retry runs fresh.
      expect(yield* cancelPreAccept(state, key)).toEqual({ status: "unknown" });
    }),
  );

  it.effect("runs an identical retry after acceptance untracked for downstream reconcile", () =>
    Effect.gen(function* () {
      const state = yield* makeJarvisRequestCancellationState();
      const key = "jarvis:request:node:origin:interaction:retry-accepted";
      const first = yield* trackPreAccept(state, key, Effect.succeed("first"));
      expect(first.status).toBe("tracked");
      const ownerLease = leaseOf(first);
      expect(yield* beginCommit(state, ownerLease)).toEqual({ proceed: true });
      yield* finishCommit(state, ownerLease, identity);
      let ran = false;
      const retry = yield* trackPreAccept(
        state,
        key,
        Effect.sync(() => {
          ran = true;
          return "retry-value";
        }),
      );
      expect(retry).toEqual({ status: "untracked", value: "retry-value" });
      expect(ran).toBe(true);
    }),
  );

  it.effect("bounds the settled outcome memory", () =>
    Effect.gen(function* () {
      const state = yield* makeJarvisRequestCancellationState(2);
      for (const suffix of ["one", "two", "three"]) {
        const key = `jarvis:request:node:origin:interaction:${suffix}`;
        const gate = yield* Deferred.make<void>();
        const fiber = yield* Effect.forkChild(trackPreAccept(state, key, Deferred.await(gate)));
        yield* Effect.yieldNow;
        expect(yield* cancelPreAccept(state, key)).toEqual({ status: "cancelled" });
        expect(yield* Fiber.join(fiber)).toEqual({ status: "cancelled" });
      }
      expect(yield* cancelPreAccept(state, "jarvis:request:node:origin:interaction:one")).toEqual({
        status: "unknown",
      });
      expect(yield* cancelPreAccept(state, "jarvis:request:node:origin:interaction:three")).toEqual(
        { status: "cancelled" },
      );
    }),
  );

  it.effect("bounds the pre-register tombstone memory", () =>
    Effect.gen(function* () {
      const state = yield* makeJarvisRequestCancellationState(2);
      const one = "jarvis:request:node:origin:interaction:pre-one";
      const two = "jarvis:request:node:origin:interaction:pre-two";
      const three = "jarvis:request:node:origin:interaction:pre-three";
      expect(yield* cancelPreAccept(state, one)).toEqual({ status: "unknown" });
      expect(yield* cancelPreAccept(state, two)).toEqual({ status: "unknown" });
      expect(yield* cancelPreAccept(state, three)).toEqual({ status: "unknown" });
      // The oldest tombstone evicted: its track runs instead of cancelling.
      const first = yield* trackPreAccept(state, one, Effect.succeed("runs"));
      expect(first.status).toBe("tracked");
      yield* closeCommit(state, leaseOf(first));
      // The retained tombstone still cancels without running.
      let ran = false;
      const last = yield* trackPreAccept(
        state,
        three,
        Effect.sync(() => {
          ran = true;
          return "never";
        }),
      );
      expect(last).toEqual({ status: "cancelled" });
      expect(ran).toBe(false);
    }),
  );
});
