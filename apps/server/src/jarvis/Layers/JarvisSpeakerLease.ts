import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import { JarvisSpeakerLease } from "../Services/JarvisSpeakerLease.ts";

const ELECTION_WINDOW = Duration.millis(200);
const CLAIM_RETENTION_MS = 30_000;

interface Claim {
  readonly deviceId: string;
  readonly priority: number;
}

interface Election {
  readonly selectionAt: number;
  readonly expiresAt: number;
  readonly claims: ReadonlyMap<string, Claim>;
  readonly winnerDeviceId?: string;
}

type Registration =
  | { readonly _tag: "finalized"; readonly winnerDeviceId: string }
  | { readonly _tag: "collecting"; readonly selectionAt: number };

export const JarvisSpeakerLeaseLive = Layer.effect(
  JarvisSpeakerLease,
  Effect.gen(function* () {
    const elections = yield* Ref.make(new Map<string, Election>());
    const claim: JarvisSpeakerLease["Service"]["claim"] = Effect.fn("JarvisSpeakerLease.claim")(
      function* (input) {
        const now = yield* Clock.currentTimeMillis;
        const registration = yield* Ref.modify(
          elections,
          (current): readonly [Registration, Map<string, Election>] => {
            const next = new Map([...current].filter(([, election]) => election.expiresAt > now));
            const election = next.get(input.reportId);
            if (election?.winnerDeviceId !== undefined) {
              return [{ _tag: "finalized", winnerDeviceId: election.winnerDeviceId }, next];
            }
            const claims = new Map(election?.claims ?? []);
            claims.set(input.deviceId, {
              deviceId: input.deviceId,
              priority: input.priority,
            });
            next.set(input.reportId, {
              selectionAt: election?.selectionAt ?? now + Duration.toMillis(ELECTION_WINDOW),
              expiresAt: election?.expiresAt ?? now + CLAIM_RETENTION_MS,
              claims,
            });
            return [
              {
                _tag: "collecting",
                selectionAt: election?.selectionAt ?? now + Duration.toMillis(ELECTION_WINDOW),
              },
              next,
            ];
          },
        );

        if (registration._tag === "finalized") {
          return { granted: registration.winnerDeviceId === input.deviceId };
        }
        yield* Effect.sleep(Duration.millis(Math.max(0, registration.selectionAt - now)));
        const winnerDeviceId = yield* Ref.modify(elections, (current) => {
          const next = new Map(current);
          const election = next.get(input.reportId);
          if (!election) return [undefined, next] as const;
          const winner =
            election.winnerDeviceId ??
            [...election.claims.values()].toSorted(
              (left, right) =>
                right.priority - left.priority || left.deviceId.localeCompare(right.deviceId),
            )[0]?.deviceId;
          if (winner !== undefined) {
            next.set(input.reportId, { ...election, winnerDeviceId: winner });
          }
          return [winner, next] as const;
        });
        return { granted: winnerDeviceId === input.deviceId };
      },
    );
    const release: JarvisSpeakerLease["Service"]["release"] = Effect.fn(
      "JarvisSpeakerLease.release",
    )(function* (input) {
      yield* Ref.update(elections, (current) => {
        const election = current.get(input.reportId);
        if (election === undefined) return current;
        if (election.winnerDeviceId !== undefined) {
          if (election.winnerDeviceId !== input.deviceId) return current;
          const next = new Map(current);
          next.delete(input.reportId);
          return next;
        }
        const claims = new Map(election.claims);
        claims.delete(input.deviceId);
        const next = new Map(current);
        if (claims.size === 0) next.delete(input.reportId);
        else next.set(input.reportId, { ...election, claims });
        return next;
      });
    });
    return JarvisSpeakerLease.of({ claim, release });
  }),
);
