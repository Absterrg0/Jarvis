import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  JarvisWsRpcGroup,
  WS_METHODS,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { jarvisRpcScopeExtension } from "./JarvisWsRpc.ts";

describe("Jarvis WebSocket RPC extension", () => {
  it("declares exactly one scope for every product handler", () => {
    expect(new Set(Object.keys(jarvisRpcScopeExtension))).toEqual(
      new Set(JarvisWsRpcGroup.requests.keys()),
    );
  });

  it("keeps operation and read scopes exact", () => {
    expect(jarvisRpcScopeExtension[WS_METHODS.jarvisExecute]).toBe(AuthOrchestrationOperateScope);
    expect(jarvisRpcScopeExtension[WS_METHODS.jarvisGetTaskDesk]).toBe(AuthOrchestrationReadScope);
    expect(jarvisRpcScopeExtension[WS_METHODS.jarvisManageProjectAlias]).toBe(
      AuthOrchestrationOperateScope,
    );
    expect(jarvisRpcScopeExtension[WS_METHODS.subscribeJarvisReports]).toBe(
      AuthOrchestrationReadScope,
    );
  });
});
