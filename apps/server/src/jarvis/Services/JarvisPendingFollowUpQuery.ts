import { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";

export interface JarvisPendingFollowUpQueryShape {
  readonly listReadyThreads: () => Effect.Effect<
    ReadonlyArray<ThreadId>,
    ProjectionRepositoryError
  >;
}

export class JarvisPendingFollowUpQuery extends Context.Service<
  JarvisPendingFollowUpQuery,
  JarvisPendingFollowUpQueryShape
>()("t3/jarvis/Services/JarvisPendingFollowUpQuery") {}
