import type { JarvisSpeakerClaimInput } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export interface JarvisSpeakerLeaseShape {
  readonly claim: (input: JarvisSpeakerClaimInput) => Effect.Effect<{ readonly granted: boolean }>;
}

export class JarvisSpeakerLease extends Context.Service<
  JarvisSpeakerLease,
  JarvisSpeakerLeaseShape
>()("t3/jarvis/Services/JarvisSpeakerLease") {}
