import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  JarvisWsRpcGroup,
  WS_METHODS,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { deriveTaskDeskTaskState, jarvisRpcScopeExtension } from "./JarvisWsRpc.ts";

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
    expect(jarvisRpcScopeExtension[WS_METHODS.subscribeJarvisPresentation]).toBe(
      AuthOrchestrationReadScope,
    );
  });

  it("derives blocking states from the authoritative T3 shell", () => {
    const idle = {
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      latestTurn: null,
      session: null,
    } as const;

    expect(
      deriveTaskDeskTaskState({
        ...idle,
        hasPendingApprovals: true,
        hasPendingUserInput: true,
      }),
    ).toBe("waiting-for-approval");
    expect(deriveTaskDeskTaskState({ ...idle, hasPendingUserInput: true })).toBe(
      "waiting-for-input",
    );
  });
});
