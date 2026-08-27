import * as Layer from "effect/Layer";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import { JarvisManagerLive } from "./JarvisManager.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { JarvisProjectLexiconLive } from "./JarvisProjectLexicon.ts";
import { JarvisReportOutboxLive } from "./JarvisReportOutbox.ts";
import { JarvisTaskDeskLive } from "./JarvisTaskDesk.ts";
import { JarvisReportOutbox } from "../Services/JarvisReportOutbox.ts";

export const JarvisDataServicesLive = Layer.mergeAll(
  JarvisTaskDeskLive,
  JarvisProjectLexiconLive,
  JarvisReportOutboxLive,
);

// Tests can replace the outbox while preserving the same manager dependency shape. Production
// composes JarvisManagerLive directly over RuntimeCoreDependenciesLive, whose single data-services
// aggregate is also provided to the reactors.
export const makeJarvisRuntimeServicesLive = (
  reportOutboxLayer?: Layer.Layer<JarvisReportOutbox, never, SqlClient.SqlClient>,
) =>
  JarvisManagerLive.pipe(
    Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
    Layer.provideMerge(
      reportOutboxLayer === undefined
        ? JarvisDataServicesLive
        : Layer.mergeAll(JarvisTaskDeskLive, JarvisProjectLexiconLive, reportOutboxLayer),
    ),
  );
