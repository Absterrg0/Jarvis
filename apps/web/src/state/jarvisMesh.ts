import { JarvisMesh, type JarvisMeshCatalog } from "@t3tools/jarvis-client-runtime/jarvis/mesh";
import { createRuntimeCommand } from "@t3tools/client-runtime/state/runtime";
import type {
  JarvisMeshExecuteInput,
  JarvisMeshManageProjectAliasInput,
  JarvisMeshFocusTaskInput,
} from "@t3tools/jarvis-client-runtime/jarvis/mesh";
import type { EnvironmentId } from "@t3tools/contracts";
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

/** All commands and subscriptions share the runtime-owned mesh catalog. */
function runWithMesh<A, E>(operation: (mesh: JarvisMesh["Service"]) => Effect.Effect<A, E>) {
  return JarvisMesh.pipe(Effect.flatMap((mesh) => operation(mesh)));
}

export const jarvisMeshEnvironment = {
  refresh: createRuntimeCommand(connectionAtomRuntime, {
    label: "jarvis-mesh:refresh",
    execute: () => runWithMesh((mesh) => mesh.refresh),
  }),
  refreshNode: createRuntimeCommand(connectionAtomRuntime, {
    label: "jarvis-mesh:refresh-node",
    execute: ({ nodeId }: { readonly nodeId: EnvironmentId }) =>
      runWithMesh((mesh) => mesh.refreshNode(nodeId)),
  }),
  execute: createRuntimeCommand(connectionAtomRuntime, {
    label: "jarvis-mesh:execute",
    execute: (input: JarvisMeshExecuteInput) => runWithMesh((mesh) => mesh.execute(input)),
  }),
  getTaskDesk: createRuntimeCommand(connectionAtomRuntime, {
    label: "jarvis-mesh:get-task-desk",
    execute: ({ nodeId }: { readonly nodeId: EnvironmentId }) =>
      runWithMesh((mesh) => mesh.getTaskDesk(nodeId)),
  }),
  focusTask: createRuntimeCommand(connectionAtomRuntime, {
    label: "jarvis-mesh:focus-task",
    execute: (input: JarvisMeshFocusTaskInput) => runWithMesh((mesh) => mesh.focusTask(input)),
  }),
  manageProjectAlias: createRuntimeCommand(connectionAtomRuntime, {
    label: "jarvis-mesh:manage-project-alias",
    execute: (input: JarvisMeshManageProjectAliasInput) =>
      runWithMesh((mesh) => mesh.manageProjectAlias(input)),
  }),
};
