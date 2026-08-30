import * as Layer from "effect/Layer";

import { JarvisManagerLive } from "./JarvisManager.ts";
import { JarvisProjectLexiconLive } from "./JarvisProjectLexicon.ts";
import { JarvisTaskDeskLive } from "./JarvisTaskDesk.ts";
import { JarvisFollowUpQueueLive } from "./JarvisFollowUpQueue.ts";

export const JarvisDataServicesLive = Layer.mergeAll(
  JarvisTaskDeskLive,
  JarvisProjectLexiconLive,
  JarvisFollowUpQueueLive,
);

export const makeJarvisRuntimeServicesLive = () =>
  JarvisManagerLive.pipe(Layer.provideMerge(JarvisDataServicesLive));
