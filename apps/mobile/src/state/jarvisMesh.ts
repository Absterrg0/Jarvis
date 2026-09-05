import { JarvisMesh, type JarvisMeshCatalog } from "@t3tools/jarvis-client-runtime/jarvis/mesh";
import type {
  JarvisMeshConverseInput,
  JarvisMeshExecuteInput,
  JarvisMeshFocusTaskInput,
  JarvisMeshManageProjectAliasInput,
} from "@t3tools/jarvis-client-runtime/jarvis/mesh";
import {
  createAbortableRuntimeCommand,
  createRuntimeCommand,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import type { JarvisVoiceSynthesizeInput, JarvisVoiceTranscribeInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Option from "effect/Option";
import { Atom, AsyncResult } from "effect/unstable/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";

const catalogStreamAtom = connectionAtomRuntime.atom(
  Stream.unwrap(JarvisMesh.pipe(Effect.map((mesh) => mesh.catalogChanges))),
);
export const jarvisMeshCatalogAtom = Atom.make((get): JarvisMeshCatalog | null =>
  Option.getOrNull(AsyncResult.value(get(catalogStreamAtom))),
);

/**
 * Mobile owns only the Atom command boundary. JarvisMesh keeps catalog reads,
 * node qualification, and routing shared with the desktop and web clients.
 */
function runWithMesh<A, E>(operation: (mesh: JarvisMesh["Service"]) => Effect.Effect<A, E>) {
  return JarvisMesh.pipe(Effect.flatMap((mesh) => operation(mesh)));
}

export const jarvisMeshEnvironment = {
  refresh: createRuntimeCommand(connectionAtomRuntime, {
    label: "mobile:jarvis-mesh:refresh",
    execute: () => runWithMesh((mesh) => mesh.refresh),
  }),
  refreshNode: createRuntimeCommand(connectionAtomRuntime, {
    label: "mobile:jarvis-mesh:refresh-node",
    execute: ({ nodeId }: { readonly nodeId: EnvironmentId }) =>
      runWithMesh((mesh) => mesh.refreshNode(nodeId)),
  }),
  execute: createRuntimeCommand(connectionAtomRuntime, {
    label: "mobile:jarvis-mesh:execute",
    execute: (input: JarvisMeshExecuteInput) => runWithMesh((mesh) => mesh.execute(input)),
  }),
  converse: createRuntimeCommand(connectionAtomRuntime, {
    label: "mobile:jarvis-mesh:converse",
    execute: (input: JarvisMeshConverseInput) => runWithMesh((mesh) => mesh.converse(input)),
  }),
  getTaskDesk: createRuntimeCommand(connectionAtomRuntime, {
    label: "mobile:jarvis-mesh:get-task-desk",
    execute: ({ nodeId }: { readonly nodeId: EnvironmentId }) =>
      runWithMesh((mesh) => mesh.getTaskDesk(nodeId)),
  }),
  focusTask: createRuntimeCommand(connectionAtomRuntime, {
    label: "mobile:jarvis-mesh:focus-task",
    execute: (input: JarvisMeshFocusTaskInput) => runWithMesh((mesh) => mesh.focusTask(input)),
  }),
  manageProjectAlias: createRuntimeCommand(connectionAtomRuntime, {
    label: "mobile:jarvis-mesh:manage-project-alias",
    execute: (input: JarvisMeshManageProjectAliasInput) =>
      runWithMesh((mesh) => mesh.manageProjectAlias(input)),
  }),
  transcribeVoice: createAbortableRuntimeCommand(connectionAtomRuntime, {
    label: "mobile:jarvis-mesh:voice-transcribe",
    execute: ({
      nodeId,
      input,
    }: {
      readonly nodeId: EnvironmentId;
      readonly input: JarvisVoiceTranscribeInput;
    }) => runWithMesh((mesh) => mesh.transcribeVoice(nodeId, input)),
  }),
  synthesizeVoice: createAbortableRuntimeCommand(connectionAtomRuntime, {
    label: "mobile:jarvis-mesh:voice-synthesize",
    execute: ({
      nodeId,
      input,
    }: {
      readonly nodeId: EnvironmentId;
      readonly input: JarvisVoiceSynthesizeInput;
    }) => runWithMesh((mesh) => mesh.synthesizeVoice(nodeId, input)),
  }),
};
