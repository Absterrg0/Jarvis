import { JarvisMesh, make as makeJarvisMesh } from "@t3tools/jarvis-client-runtime/jarvis/mesh";
import { createRuntimeCommand } from "@t3tools/client-runtime/state/runtime";
import type {
  JarvisMeshExecuteInput,
  JarvisMeshNavigateTaskDeskInput,
} from "@t3tools/jarvis-client-runtime/jarvis/mesh";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { connectionAtomRuntime } from "../connection/runtime";

/**
 * Web/desktop owns the Atom boundary; JarvisMesh owns all node routing and
 * keeps the transport implementation in client-runtime. Each command builds
 * a short-lived service over the shared EnvironmentRegistry, so connections
 * remain owned by the registry rather than by the dialog.
 */
function runWithMesh<A, E>(operation: (mesh: JarvisMesh["Service"]) => Effect.Effect<A, E>) {
  return makeJarvisMesh.pipe(Effect.flatMap((mesh) => operation(mesh)));
}

export const jarvisMeshEnvironment = {
  refresh: createRuntimeCommand(connectionAtomRuntime, {
    label: "jarvis-mesh:refresh",
    execute: () => runWithMesh((mesh) => mesh.refresh),
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
  navigateTaskDesk: createRuntimeCommand(connectionAtomRuntime, {
    label: "jarvis-mesh:navigate-task-desk",
    execute: (input: JarvisMeshNavigateTaskDeskInput) =>
      runWithMesh((mesh) => mesh.navigateTaskDesk(input)),
  }),
};
