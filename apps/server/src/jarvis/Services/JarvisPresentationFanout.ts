import type { JarvisPresentationEvent } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Stream from "effect/Stream";

/**
 * One ephemeral presentation stream for the node. Each source event is
 * projected once and routed to subscribers by origin; listeners never rebuild
 * each other's presentations. Delivery stays live-only with no durable
 * report ledger: late subscribers see future events, never replays.
 */
export interface JarvisPresentationFanoutShape {
  readonly subscribe: (input: {
    readonly originInteractionId: string;
    readonly originNodeId?: string;
  }) => Stream.Stream<JarvisPresentationEvent>;
}

export class JarvisPresentationFanout extends Context.Service<
  JarvisPresentationFanout,
  JarvisPresentationFanoutShape
>()("t3/jarvis/Services/JarvisPresentationFanout") {}
