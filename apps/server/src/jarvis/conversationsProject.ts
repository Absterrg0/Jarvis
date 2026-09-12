import { CommandId, JARVIS_CONVERSATIONS_PROJECT_TITLE, ProjectId } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";

/**
 * ARIS keeps general questions out of the user's coding projects. Every
 * conversation thread lives in one dedicated project per node, rooted at a
 * workspace that carries the conversational provider guidance in AGENTS.md, so
 * the guidance never leaks into the visible transcript.
 */
export { JARVIS_CONVERSATIONS_PROJECT_TITLE };

export const JARVIS_CONVERSATIONS_AGENTS_MD = [
  "# Conversations",
  "",
  "This project holds ARIS general-question threads. Nothing here is a coding task.",
  "",
  "- You have full shell access in this workspace.",
  "- When the answer depends on live or external data (weather, prices, schedules, current facts), fetch it with a command before answering.",
  "- For example: curl -s 'wttr.in/<city>?format=3'.",
  "- Do not claim you cannot access live data without trying.",
  "- Keep answers short and direct; they are read aloud.",
  "",
].join("\n");

const conversationsRoot = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  return path.join(config.baseDir, "conversations");
});

/** The Conversations project id, or null before startup has created it. */
export const resolveJarvisConversationsProjectId = conversationsRoot.pipe(
  Effect.flatMap((root) =>
    Effect.gen(function* () {
      const projections = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
      const existing = yield* projections.getActiveProjectByWorkspaceRoot(root);
      return Option.isSome(existing) ? existing.value.id : null;
    }),
  ),
  Effect.orElseSucceed(() => null),
);

/**
 * Idempotently create the Conversations project and its AGENTS.md. Safe to run
 * on every startup: an existing project with the same workspace root is reused.
 */
export const ensureJarvisConversationsProject = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const crypto = yield* Crypto.Crypto;
  const path = yield* Path.Path;
  const projections = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const orchestration = yield* OrchestrationEngine.OrchestrationEngineService;
  const root = yield* conversationsRoot;

  yield* fs.makeDirectory(root, { recursive: true }).pipe(Effect.orElseSucceed(() => undefined));
  const agentsPath = path.join(root, "AGENTS.md");
  const existingAgents = yield* fs
    .readFileString(agentsPath)
    .pipe(Effect.orElseSucceed(() => null));
  if (existingAgents === null) {
    yield* fs.writeFileString(agentsPath, JARVIS_CONVERSATIONS_AGENTS_MD);
  }

  const existing = yield* projections.getActiveProjectByWorkspaceRoot(root);
  if (Option.isSome(existing)) return existing.value.id;

  const projectId = ProjectId.make(yield* crypto.randomUUIDv4);
  yield* orchestration.dispatch({
    type: "project.create",
    commandId: CommandId.make(yield* crypto.randomUUIDv4),
    projectId,
    title: JARVIS_CONVERSATIONS_PROJECT_TITLE,
    workspaceRoot: root,
    createWorkspaceRootIfMissing: true,
    createdAt: DateTime.formatIso(yield* DateTime.now),
  });
  return projectId;
});
