import * as Layer from "effect/Layer";

import { JarvisControllerLive } from "./JarvisController.ts";
import { JarvisProjectLexiconLive } from "./JarvisProjectLexicon.ts";
import { JarvisTaskDeskLive } from "./JarvisTaskDesk.ts";
import { JarvisFollowUpQueueLive } from "./JarvisFollowUpQueue.ts";

export const JarvisDataServicesLive = Layer.mergeAll(
  JarvisTaskDeskLive,
  JarvisProjectLexiconLive,
  JarvisFollowUpQueueLive,
);

export const makeJarvisRuntimeServicesLive = () =>
  JarvisControllerLive.pipe(Layer.provideMerge(JarvisDataServicesLive));
