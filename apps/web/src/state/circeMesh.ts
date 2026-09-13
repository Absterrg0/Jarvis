import { CirceMesh, type CirceMeshCatalog } from "@circe/client-runtime/circe/mesh";
import type { CirceCancelRequestInput } from "@t3tools/contracts";
import { createRuntimeCommand } from "@t3tools/client-runtime/state/runtime";
import type {
  CirceMeshConverseInput,
  CirceMeshExecuteInput,
  CirceMeshInterpretInput,
  CirceMeshManageProjectAliasInput,
  CirceMeshFocusTaskInput,
} from "@circe/client-runtime/circe/mesh";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Option from "effect/Option";
import { Atom, AsyncResult } from "effect/unstable/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";

const catalogStreamAtom = connectionAtomRuntime.atom(
  Stream.unwrap(CirceMesh.pipe(Effect.map((mesh) => mesh.catalogChanges))),
);
export const circeMeshCatalogAtom = Atom.make((get): CirceMeshCatalog | null =>
  Option.getOrNull(AsyncResult.value(get(catalogStreamAtom))),
);

/** All commands and subscriptions share the runtime-owned mesh catalog. */
function runWithMesh<A, E>(operation: (mesh: CirceMesh["Service"]) => Effect.Effect<A, E>) {
  return CirceMesh.pipe(Effect.flatMap((mesh) => operation(mesh)));
}

export const circeMeshEnvironment = {
  refresh: createRuntimeCommand(connectionAtomRuntime, {
    label: "circe-mesh:refresh",
    execute: () => runWithMesh((mesh) => mesh.refresh),
  }),
  refreshNode: createRuntimeCommand(connectionAtomRuntime, {
    label: "circe-mesh:refresh-node",
    execute: ({ nodeId }: { readonly nodeId: EnvironmentId }) =>
      runWithMesh((mesh) => mesh.refreshNode(nodeId)),
  }),
  execute: createRuntimeCommand(connectionAtomRuntime, {
    label: "circe-mesh:execute",
    execute: (input: CirceMeshExecuteInput) => runWithMesh((mesh) => mesh.execute(input)),
  }),
  interpret: createRuntimeCommand(connectionAtomRuntime, {
    label: "circe-mesh:interpret",
    execute: (input: CirceMeshInterpretInput) => runWithMesh((mesh) => mesh.interpret(input)),
  }),
  converse: createRuntimeCommand(connectionAtomRuntime, {
    label: "circe-mesh:converse",
    execute: (input: CirceMeshConverseInput) => runWithMesh((mesh) => mesh.converse(input)),
  }),
  getTaskDesk: createRuntimeCommand(connectionAtomRuntime, {
    label: "circe-mesh:get-task-desk",
    execute: ({ nodeId }: { readonly nodeId: EnvironmentId }) =>
      runWithMesh((mesh) => mesh.getTaskDesk(nodeId)),
  }),
  focusTask: createRuntimeCommand(connectionAtomRuntime, {
    label: "circe-mesh:focus-task",
    execute: (input: CirceMeshFocusTaskInput) => runWithMesh((mesh) => mesh.focusTask(input)),
  }),
  cancelRequest: createRuntimeCommand(connectionAtomRuntime, {
    label: "circe-mesh:cancel-request",
    execute: ({
      nodeId,
      input,
    }: {
      readonly nodeId: EnvironmentId;
      readonly input: CirceCancelRequestInput;
    }) => runWithMesh((mesh) => mesh.cancelRequest(nodeId, input)),
  }),
  manageProjectAlias: createRuntimeCommand(connectionAtomRuntime, {
    label: "circe-mesh:manage-project-alias",
    execute: (input: CirceMeshManageProjectAliasInput) =>
      runWithMesh((mesh) => mesh.manageProjectAlias(input)),
  }),
};
