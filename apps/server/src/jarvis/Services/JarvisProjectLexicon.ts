import type { JarvisProjectAlias, ProjectId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";

export interface JarvisProjectLexiconShape {
  readonly list: () => Effect.Effect<ReadonlyArray<JarvisProjectAlias>, ProjectionRepositoryError>;
  readonly learn: (input: {
    readonly projectId: ProjectId;
    readonly alias: string;
    readonly kind: JarvisProjectAlias["kind"];
  }) => Effect.Effect<JarvisProjectAlias, ProjectionRepositoryError>;
  readonly forget: (input: {
    readonly projectId: ProjectId;
    readonly alias: string;
  }) => Effect.Effect<boolean, ProjectionRepositoryError>;
}

export class JarvisProjectLexicon extends Context.Service<
  JarvisProjectLexicon,
  JarvisProjectLexiconShape
>()("t3/jarvis/Services/JarvisProjectLexicon") {}
