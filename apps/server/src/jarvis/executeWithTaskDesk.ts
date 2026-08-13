import type { AuthSessionId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { JarvisManagerExecuteInput, JarvisManagerShape } from "./Services/JarvisManager.ts";
import type { JarvisTaskDeskShape } from "./Services/JarvisTaskDesk.ts";

export const executeWithTaskDesk = Effect.fn("Jarvis.executeWithTaskDesk")(function* (
  manager: JarvisManagerShape,
  taskDesk: JarvisTaskDeskShape,
  sessionId: AuthSessionId,
  input: JarvisManagerExecuteInput,
) {
  const desk = yield* taskDesk.get(sessionId);

  const result = yield* manager.execute({
    ...input,
    ...(desk.focusedThreadId !== null
      ? { referenceThreadId: desk.focusedThreadId }
      : input.referenceThreadId === undefined
        ? {}
        : { referenceThreadId: input.referenceThreadId }),
  });
  if (result.status === "started") {
    const existingTask = desk.recentTasks.find((task) => task.threadId === result.threadId);
    const generatedTitle =
      result.objective.length <= 80 ? result.objective : `${result.objective.slice(0, 79)}…`;
    yield* taskDesk.focus({
      sessionId,
      task: {
        threadId: result.threadId,
        projectId: input.projectId,
        title: existingTask?.title ?? generatedTitle,
        objective: existingTask?.objective ?? result.objective,
        state: "running",
        voiceAliases: existingTask?.voiceAliases ?? [],
      },
    });
  }
  return result;
});
