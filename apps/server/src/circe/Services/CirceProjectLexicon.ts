import type { CirceProjectAlias, ProjectId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";

export interface CirceProjectLexiconShape {
  readonly list: () => Effect.Effect<ReadonlyArray<CirceProjectAlias>, ProjectionRepositoryError>;
  readonly learn: (input: {
    readonly projectId: ProjectId;
    readonly alias: string;
    readonly kind: CirceProjectAlias["kind"];
  }) => Effect.Effect<CirceProjectAlias, ProjectionRepositoryError>;
  readonly forget: (input: {
    readonly projectId: ProjectId;
    readonly alias: string;
  }) => Effect.Effect<boolean, ProjectionRepositoryError>;
}

export class CirceProjectLexicon extends Context.Service<
  CirceProjectLexicon,
  CirceProjectLexiconShape
>()("t3/circe/Services/CirceProjectLexicon") {}
