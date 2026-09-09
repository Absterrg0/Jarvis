import type { JarvisTaskRef, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Ref from "effect/Ref";

/**
 * The pre-accept cancellation registry for Jarvis execute calls. One
 * in-flight request per acceptance key; cancellation aborts the
 * interpretation fiber through ordinary Effect interruption, without
 * touching provider internals.
 *
 * Ownership is a per-call lease: the first track for a key owns the slot
 * and alone may begin, finish, or close it. Concurrent duplicates share
 * the owner's single interpretation result and hold no lease, so a refused
 * duplicate can never clean up the owner's commit. A cancel that lands
 * first aborts interpretation and reports cancelled with no dispatch, ever.
 *
 * The acceptance boundary is the actual dispatch attempt, never the end of
 * interpretation:
 *
 * - `trackPreAccept` runs one interpretation per key. A cancel that lands
 *   first aborts it and reports cancelled with no dispatch, ever. A cancel
 *   that arrives before any track leaves a bounded pre-register tombstone
 *   and answers unknown; the later track consumes it and reports cancelled
 *   without running. Duplicates await the owner's single result instead of
 *   running a second inference: success shares the value (the controller
 *   still cancels the loser so only the owner dispatches), failure replays
 *   the owner's cause truthfully, never cancelled.
 * - `beginCommit` is the single atomic gate before any command is invoked.
 *   Only the owner lease proceeds, exactly once per key; every other
 *   attempt is refused and maps to a cancelled execute result.
 * - `finishCommit` records the typed receipt identity after a dispatch
 *   succeeds, owner only. A cancel that lands mid-commit awaits that
 *   receipt and then reports already-accepted with the exact identity, or
 *   unknown when the commit failed. Success is never claimed pre-receipt.
 * - Anything that settles without dispatching leaves no acceptance record,
 *   so a later cancel answers unknown instead of claiming work that never
 *   ran. A retry after a recorded cancel never runs again; a retry after a
 *   recorded acceptance runs untracked so the existing downstream
 *   idempotency and conflict rules govern unchanged. Failures and fiber
 *   interruptions clean up owner-only with no record, so a retry may run
 *   and a late cancel answers unknown.
 * - No durable ledger: all maps are in-memory and bounded. Evicted keys
 *   answer unknown.
 */

export interface JarvisPreAcceptIdentity {
  readonly threadId?: ThreadId;
  readonly taskRef?: JarvisTaskRef;
  readonly projectId?: ProjectId;
}

export interface JarvisPreAcceptLease {
  readonly key: string;
  readonly owner: symbol;
}

export type JarvisPreAcceptOutcome<A> =
  | {
      readonly status: "tracked";
      readonly key: string;
      readonly lease: JarvisPreAcceptLease;
      readonly value: A;
    }
  | { readonly status: "shared"; readonly key: string; readonly value: A }
  | { readonly status: "untracked"; readonly value: A }
  | { readonly status: "cancelled" };

export type JarvisPreAcceptCancelDecision =
  | { readonly status: "cancelled" }
  | { readonly status: "already-accepted"; readonly identity: JarvisPreAcceptIdentity }
  | { readonly status: "unknown" };

type CommitReceipt =
  | { readonly status: "accepted"; readonly identity: JarvisPreAcceptIdentity }
  | { readonly status: "failed" };

type SharedInterpretation =
  | { readonly status: "success"; readonly value: unknown }
  | { readonly status: "cancelled" }
  | { readonly status: "failed"; readonly cause: Cause.Cause<unknown> };

interface Slot {
  readonly gate: Deferred.Deferred<void>;
  readonly receipt: Deferred.Deferred<CommitReceipt>;
  readonly result: Deferred.Deferred<SharedInterpretation>;
  readonly phase: "interpreting" | "committing";
  readonly owner: symbol;
}

type StoredOutcome =
  | { readonly status: "cancelled" }
  | { readonly status: "accepted"; readonly identity: JarvisPreAcceptIdentity };

interface CancellationState {
  readonly inflight: ReadonlyMap<string, Slot>;
  readonly settled: ReadonlyMap<string, StoredOutcome>;
  readonly preCancel: ReadonlyMap<string, true>;
  readonly completed: ReadonlyMap<string, true>;
}

export interface JarvisRequestCancellationState {
  readonly ref: Ref.Ref<CancellationState>;
  readonly settledLimit: number;
}

export const makeJarvisRequestCancellationState = (
  settledLimit = 128,
): Effect.Effect<JarvisRequestCancellationState> =>
  Ref.make<CancellationState>({
    inflight: new Map(),
    settled: new Map(),
    preCancel: new Map(),
    completed: new Map(),
  }).pipe(Effect.map((ref) => ({ ref, settledLimit: Math.max(1, settledLimit) })));

const recordBounded = <V>(
  current: ReadonlyMap<string, V>,
  limit: number,
  key: string,
  value: V,
): Map<string, V> => {
  const next = new Map(current);
  next.delete(key);
  next.set(key, value);
  while (next.size > limit) {
    const oldest = next.keys().next().value;
    if (oldest === undefined) break;
    next.delete(oldest);
  }
  return next;
};

const recordSettled = (
  settled: ReadonlyMap<string, StoredOutcome>,
  limit: number,
  key: string,
  outcome: StoredOutcome,
): Map<string, StoredOutcome> => recordBounded(settled, limit, key, outcome);

const recordCompleted = (
  completed: ReadonlyMap<string, true>,
  limit: number,
  key: string,
): Map<string, true> => recordBounded(completed, limit, key, true);

const untrackedOutcome = <A>(value: A): JarvisPreAcceptOutcome<A> => ({
  status: "untracked",
  value,
});

const cancelledOutcome = <A>(): JarvisPreAcceptOutcome<A> => ({ status: "cancelled" });

type Registration =
  | StoredOutcome
  | { readonly preCancelled: true }
  | { readonly duplicate: true; readonly slot: Slot }
  | {
      readonly fresh: true;
      readonly gate: Deferred.Deferred<void>;
      readonly receipt: Deferred.Deferred<CommitReceipt>;
      readonly result: Deferred.Deferred<SharedInterpretation>;
      readonly owner: symbol;
    };

/**
 * Run one semantic interpretation under pre-accept cancellation. Without a
 * request key the effect runs untracked. A retry after a recorded cancel
 * never runs again. A retry after a recorded acceptance runs untracked so
 * the existing downstream idempotency and conflict rules govern unchanged.
 * A concurrent duplicate awaits the owner's single interpretation result
 * and shares it with no lease, so exactly one inference and one dispatch
 * can happen per key. A pre-register cancel tombstone makes the next track
 * report cancelled without running.
 */
export const trackPreAccept = <A, E, R>(
  state: JarvisRequestCancellationState,
  key: string | undefined,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<JarvisPreAcceptOutcome<A>, E, R> => {
  if (key === undefined) return Effect.map(effect, untrackedOutcome);
  return Effect.gen(function* () {
    const gate = yield* Deferred.make<void>();
    const receipt = yield* Deferred.make<CommitReceipt>();
    const result = yield* Deferred.make<SharedInterpretation>();
    const owner = Symbol(key);
    const registration = yield* Ref.modify(
      state.ref,
      (current): readonly [Registration, CancellationState] => {
        const stored = current.settled.get(key);
        if (stored !== undefined) {
          return [stored, current];
        }
        const slot = current.inflight.get(key);
        if (slot !== undefined) {
          return [{ duplicate: true as const, slot }, current];
        }
        if (current.preCancel.has(key)) {
          const preCancel = new Map(current.preCancel);
          preCancel.delete(key);
          return [
            { preCancelled: true as const },
            {
              inflight: current.inflight,
              settled: recordSettled(current.settled, state.settledLimit, key, {
                status: "cancelled",
              }),
              preCancel,
              completed: current.completed,
            },
          ];
        }
        const inflight = new Map(current.inflight);
        inflight.set(key, { gate, receipt, result, phase: "interpreting", owner });
        return [
          { fresh: true as const, gate, receipt, result, owner },
          {
            inflight,
            settled: current.settled,
            preCancel: current.preCancel,
            completed: current.completed,
          },
        ];
      },
    );
    if ("status" in registration) {
      // A retry after a recorded cancel never runs again; a retry
      // after a recorded acceptance runs untracked for the
      // downstream reconcile, exactly as before this registry.
      if (registration.status === "cancelled") return cancelledOutcome<A>();
      return yield* Effect.map(effect, untrackedOutcome);
    }
    if ("preCancelled" in registration) {
      return cancelledOutcome<A>();
    }
    if ("duplicate" in registration) {
      const shared = yield* Deferred.await(registration.slot.result);
      if (shared.status === "success") {
        return { status: "shared" as const, key, value: shared.value as A };
      }
      if (shared.status === "failed") {
        // Truthful failure: the owner's single inference failed, so the
        // duplicate replays the same cause instead of claiming cancelled.
        // No second inference runs; no dispatch happens from a duplicate.
        return yield* Effect.failCause(shared.cause as Cause.Cause<E>);
      }
      return cancelledOutcome<A>();
    }
    const fresh = registration;
    type RaceWinner = { readonly tag: "value"; readonly value: A } | { readonly tag: "cancelled" };
    const raceExit = yield* Effect.exit(
      Effect.raceFirst(
        Effect.map(effect, (value): RaceWinner => ({ tag: "value" as const, value })),
        Effect.as(Deferred.await(fresh.gate), { tag: "cancelled" } as RaceWinner),
      ),
    );
    if (Exit.isSuccess(raceExit)) {
      const winner = raceExit.value;
      if (winner.tag === "cancelled") {
        yield* Effect.uninterruptible(
          Deferred.succeed(fresh.result, { status: "cancelled" } as SharedInterpretation),
        );
        return cancelledOutcome<A>();
      }
      yield* Effect.uninterruptible(
        Deferred.succeed(fresh.result, {
          status: "success",
          value: winner.value as unknown,
        } as SharedInterpretation),
      );
      return {
        status: "tracked" as const,
        key,
        lease: { key, owner: fresh.owner },
        value: winner.value,
      };
    }
    // The interpretation failed or the owner fiber was interrupted
    // (disconnect): owner-only cleanup with no acceptance record, so a
    // late cancel answers unknown and a retry may run. Concurrent
    // duplicates share the single inference failure truthfully via the
    // same cause (no second run, no dispatch, never cancelled); the owner
    // replays its own failure cause so its caller still sees the real
    // error. Cleanup is uninterruptible so an interruption cannot leak the
    // slot and hang shared waiters.
    const failureCause = raceExit.cause;
    yield* Effect.uninterruptible(
      Effect.gen(function* () {
        yield* removeInflightAndComplete(state, key, fresh.owner);
        yield* Deferred.succeed(fresh.result, {
          status: "failed",
          cause: failureCause as Cause.Cause<unknown>,
        } as SharedInterpretation);
      }),
    );
    return yield* Effect.failCause(failureCause);
  });
};

const slotOwnedBy = (current: CancellationState, key: string, owner: symbol): Slot | undefined => {
  const slot = current.inflight.get(key);
  return slot !== undefined && slot.owner === owner ? slot : undefined;
};

const removeInflightIfOwner = (
  state: JarvisRequestCancellationState,
  key: string,
  owner: symbol,
): Effect.Effect<void> =>
  Ref.update(state.ref, (current) => {
    if (slotOwnedBy(current, key, owner) === undefined) return current;
    const inflight = new Map(current.inflight);
    inflight.delete(key);
    return {
      inflight,
      settled: current.settled,
      preCancel: current.preCancel,
      completed: recordCompleted(current.completed, state.settledLimit, key),
    };
  });

const removeInflightAndComplete = (
  state: JarvisRequestCancellationState,
  key: string,
  owner: symbol,
): Effect.Effect<void> => removeInflightIfOwner(state, key, owner);

/**
 * The single atomic gate before any command is invoked. Only the owner
 * lease proceeds, exactly once per key while the slot is still
 * interpreting and no cancel was requested. Every refusal maps to a
 * cancelled execute result, so a refused duplicate or a post-cancel
 * validation tail never dispatches. Non-owners have no lease and never
 * reach this gate.
 */
export const beginCommit = Effect.fn("JarvisRequestCancellation.beginCommit")(function* (
  state: JarvisRequestCancellationState,
  lease: JarvisPreAcceptLease | undefined,
): Effect.fn.Return<{ readonly proceed: boolean }> {
  if (lease === undefined) return { proceed: true };
  return yield* Ref.modify(
    state.ref,
    (current): readonly [{ readonly proceed: boolean }, CancellationState] => {
      const slot = slotOwnedBy(current, lease.key, lease.owner);
      // Only the interpreting owner can commit, exactly once. A cancel
      // that lands first removes the entry, so absence here always
      // refuses. Removal and refusal are both single atomic modifies,
      // which is the whole race boundary: no flag is needed.
      if (slot === undefined || slot.phase !== "interpreting") {
        return [{ proceed: false }, current];
      }
      const inflight = new Map(current.inflight);
      inflight.set(lease.key, { ...slot, phase: "committing" });
      return [
        { proceed: true },
        {
          inflight,
          settled: current.settled,
          preCancel: current.preCancel,
          completed: current.completed,
        },
      ];
    },
  );
});

const succeedReceipt = (
  slotReceipt: Deferred.Deferred<CommitReceipt>,
  receipt: CommitReceipt,
): Effect.Effect<void> => Deferred.succeed(slotReceipt, receipt).pipe(Effect.asVoid);

/**
 * Record the typed receipt identity after a dispatch succeeds. Only the
 * committing owner completes: anything else is a programming error or a
 * refused duplicate and stays untouched rather than inventing an
 * acceptance. The receipt Deferred must be captured before the atomic
 * removal so a mid-commit waiter hears the real outcome.
 */
export const finishCommit = Effect.fn("JarvisRequestCancellation.finishCommit")(function* (
  state: JarvisRequestCancellationState,
  lease: JarvisPreAcceptLease | undefined,
  identity: JarvisPreAcceptIdentity,
): Effect.fn.Return<void> {
  if (lease === undefined) return;
  const slot = yield* Ref.get(state.ref).pipe(
    Effect.map((current) => slotOwnedBy(current, lease.key, lease.owner)),
  );
  if (slot === undefined || slot.phase !== "committing") return;
  const receipt: CommitReceipt = { status: "accepted", identity };
  const stored: StoredOutcome = { status: "accepted", identity };
  const removed = yield* Ref.modify(state.ref, (current) => {
    const owned = slotOwnedBy(current, lease.key, lease.owner);
    if (owned === undefined || owned.phase !== "committing") return [null, current] as const;
    const inflight = new Map(current.inflight);
    inflight.delete(lease.key);
    return [
      owned.receipt,
      {
        inflight,
        settled: recordSettled(current.settled, state.settledLimit, lease.key, stored),
        preCancel: current.preCancel,
        completed: current.completed,
      },
    ] as const;
  });
  if (removed !== null) yield* succeedReceipt(removed, receipt);
});

/**
 * Drop a tracked entry without recording an acceptance. The execute
 * wrapper runs this for the owner only when the turn settles without
 * dispatching, and when a commit fails: a later cancel then answers
 * unknown instead of claiming work that never ran. A commit waiter hears
 * the failure receipt. Non-owners are always no-ops, so a refused
 * duplicate can never remove the owner's commit.
 */
export const closeCommit = Effect.fn("JarvisRequestCancellation.closeCommit")(function* (
  state: JarvisRequestCancellationState,
  lease: JarvisPreAcceptLease | undefined,
): Effect.fn.Return<void> {
  if (lease === undefined) return;
  const slot = yield* Ref.get(state.ref).pipe(
    Effect.map((current) => slotOwnedBy(current, lease.key, lease.owner)),
  );
  if (slot === undefined) return;
  if (slot.phase === "committing") {
    const removed = yield* Ref.modify(state.ref, (current) => {
      const owned = slotOwnedBy(current, lease.key, lease.owner);
      if (owned === undefined || owned.phase !== "committing") return [null, current] as const;
      const inflight = new Map(current.inflight);
      inflight.delete(lease.key);
      return [
        owned.receipt,
        {
          inflight,
          settled: current.settled,
          preCancel: current.preCancel,
          completed: recordCompleted(current.completed, state.settledLimit, lease.key),
        },
      ] as const;
    });
    if (removed !== null) yield* succeedReceipt(removed, { status: "failed" });
    return;
  }
  yield* removeInflightIfOwner(state, lease.key, lease.owner);
});

/**
 * Cancel one tracked request. An interpreting slot is aborted through its
 * gate and reports cancelled. A committing slot cannot be prevented, so
 * the cancel awaits the typed receipt: accepted with the exact identity,
 * or unknown when the commit failed. Stored outcomes repeat idempotently.
 * A cancel for an unknown key leaves a bounded pre-register tombstone and
 * answers unknown, so the next track for that key reports cancelled
 * without running; anything else unknown stays unknown, never cancelled.
 */
export const cancelPreAccept = Effect.fn("JarvisRequestCancellation.cancel")(function* (
  state: JarvisRequestCancellationState,
  key: string,
): Effect.fn.Return<JarvisPreAcceptCancelDecision> {
  const action = yield* Ref.modify(
    state.ref,
    (
      current,
    ): readonly [
      (
        | { readonly kind: "cancelled" }
        | { readonly kind: "cancel-now"; readonly gate: Deferred.Deferred<void> }
        | { readonly kind: "await-receipt"; readonly receipt: Deferred.Deferred<CommitReceipt> }
        | { readonly kind: "stored"; readonly decision: JarvisPreAcceptCancelDecision }
        | { readonly kind: "unknown" }
      ),
      CancellationState,
    ] => {
      const slot = current.inflight.get(key);
      if (slot !== undefined) {
        if (slot.phase === "committing") {
          return [{ kind: "await-receipt", receipt: slot.receipt }, current];
        }
        // Interpreting slots cancel unconditionally: removal plus the
        // recorded outcome is one atomic modify, so a racing beginCommit
        // either sees the entry and commits first, or finds it gone.
        // The owner's gate wakes its race; the owner completes the shared
        // result so concurrent duplicates also report cancelled.
        const inflight = new Map(current.inflight);
        inflight.delete(key);
        return [
          { kind: "cancel-now", gate: slot.gate },
          {
            inflight,
            settled: recordSettled(current.settled, state.settledLimit, key, {
              status: "cancelled",
            }),
            preCancel: current.preCancel,
            completed: current.completed,
          },
        ];
      }
      const stored = current.settled.get(key);
      if (stored !== undefined) {
        return [
          {
            kind: "stored",
            decision:
              stored.status === "cancelled"
                ? { status: "cancelled" }
                : { status: "already-accepted", identity: stored.identity },
          },
          current,
        ];
      }
      if (current.preCancel.has(key)) {
        return [{ kind: "unknown" }, current];
      }
      if (current.completed.has(key)) {
        // Previously tracked then settled without dispatch (clarification,
        // failure, disconnect): unknown without a new tombstone, so a retry
        // with the same key may still run.
        return [{ kind: "unknown" }, current];
      }
      return [
        { kind: "unknown" },
        {
          inflight: current.inflight,
          settled: current.settled,
          preCancel: recordBounded(current.preCancel, state.settledLimit, key, true),
          completed: current.completed,
        },
      ];
    },
  );
  switch (action.kind) {
    case "cancel-now": {
      yield* Deferred.succeed(action.gate, undefined);
      return { status: "cancelled" };
    }
    case "await-receipt": {
      const receipt = yield* Deferred.await(action.receipt);
      if (receipt.status === "accepted") {
        return { status: "already-accepted", identity: receipt.identity };
      }
      return { status: "unknown" };
    }
    case "stored": {
      return action.decision;
    }
    case "cancelled": {
      return { status: "cancelled" };
    }
    case "unknown": {
      return { status: "unknown" };
    }
  }
});
