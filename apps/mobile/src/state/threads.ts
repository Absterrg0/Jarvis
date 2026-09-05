import { useAtomValue } from "@effect/atom-react";
import {
  createEnvironmentThreadDetailAtoms,
  createEnvironmentThreadShellAtoms,
  createEnvironmentThreadStateAtoms,
  EMPTY_ENVIRONMENT_THREAD_STATE,
  type EnvironmentThreadState,
  createThreadEnvironmentAtoms,
  ThreadSnapshotLoader,
} from "@t3tools/client-runtime/state/threads";
import type { EnvironmentId, OrchestrationSessionStatus, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { EnvironmentSupervisor } from "@t3tools/client-runtime/connection";
import { createEnvironmentCommand } from "@t3tools/client-runtime/state/runtime";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { environmentSnapshotAtom } from "./shell";

export const threadEnvironment = createThreadEnvironmentAtoms(connectionAtomRuntime);
export const environmentThreads = createEnvironmentThreadStateAtoms(connectionAtomRuntime);
export const environmentThreadDetails = createEnvironmentThreadDetailAtoms(
  environmentThreads.stateAtom,
);
export const environmentThreadShells = createEnvironmentThreadShellAtoms({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  snapshotAtom: environmentSnapshotAtom,
});

export type MobileThreadLookup =
  | {
      readonly status: "found";
      readonly sessionStatus: OrchestrationSessionStatus | null;
      readonly latestTurnState: "running" | "interrupted" | "completed" | "error" | null;
    }
  | { readonly status: "missing" }
  | { readonly status: "unreachable" };

/** Read one durable thread through the ordinary snapshot endpoint.
 *
 * A transport failure stays "unreachable" so reconnects do not discard a
 * retained Jarvis listener. A confirmed 404 is "missing" and can retire it.
 */
export const lookupThread = createEnvironmentCommand(connectionAtomRuntime, {
  label: "mobile:environment-data:thread:lookup",
  execute: ({ threadId }: { readonly threadId: ThreadId }) =>
    Effect.gen(function* () {
      const supervisor = yield* EnvironmentSupervisor;
      const prepared = yield* SubscriptionRef.get(supervisor.prepared);
      if (Option.isNone(prepared)) return { status: "unreachable" } as const;
      const loader = yield* ThreadSnapshotLoader;
      if (loader.lookup === undefined) return { status: "unreachable" } as const;
      return yield* loader.lookup(prepared.value, threadId).pipe(
        Effect.map(
          (result): MobileThreadLookup =>
            result._tag === "missing"
              ? { status: "missing" }
              : {
                  status: "found",
                  sessionStatus: result.snapshot.thread.session?.status ?? null,
                  latestTurnState: result.snapshot.thread.latestTurn?.state ?? null,
                },
        ),
        Effect.catch(() => Effect.succeed({ status: "unreachable" } as const)),
      );
    }),
});

const EMPTY_THREAD_STATE_ATOM = Atom.make(AsyncResult.success(EMPTY_ENVIRONMENT_THREAD_STATE)).pipe(
  Atom.withLabel("mobile-environment-thread:empty"),
);

export function useEnvironmentThread(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
): EnvironmentThreadState {
  const result = useAtomValue(
    environmentId !== null && threadId !== null
      ? environmentThreads.stateAtom(environmentId, threadId)
      : EMPTY_THREAD_STATE_ATOM,
  );
  return Option.getOrElse(
    AsyncResult.value(result),
    () => EMPTY_ENVIRONMENT_THREAD_STATE,
  ) as EnvironmentThreadState;
}
