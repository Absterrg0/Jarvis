import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  JarvisWsRpcGroup,
  WS_METHODS,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  jarvisDurableClaimReleasesElection,
  jarvisDurableSpeechClaimResult,
  jarvisRpcScopeExtension,
} from "./JarvisWsRpc.ts";

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
    expect(jarvisRpcScopeExtension[WS_METHODS.jarvisAcknowledgeReport]).toBe(
      AuthOrchestrationOperateScope,
    );
    expect(jarvisRpcScopeExtension[WS_METHODS.jarvisClaimSpeaker]).toBe(
      AuthOrchestrationOperateScope,
    );
    expect(jarvisRpcScopeExtension[WS_METHODS.jarvisConfirmReportSpoken]).toBe(
      AuthOrchestrationOperateScope,
    );
    expect(jarvisRpcScopeExtension[WS_METHODS.jarvisReleaseReportSpeech]).toBe(
      AuthOrchestrationOperateScope,
    );
  });

  it("grants a normal durable speech claim and the legacy missing-row path", () => {
    expect(jarvisDurableSpeechClaimResult("claimed")).toEqual({
      granted: true,
      speechState: "claimed",
    });
    expect(jarvisDurableSpeechClaimResult("missing")).toEqual({
      granted: true,
      speechState: "missing",
    });
    expect(jarvisDurableSpeechClaimResult("leased")).toEqual({
      granted: false,
      speechState: "leased",
    });
    expect(jarvisDurableSpeechClaimResult("already-spoken")).toEqual({
      granted: false,
      speechState: "already-spoken",
    });
    expect(jarvisDurableClaimReleasesElection("claimed")).toBe(false);
    expect(jarvisDurableClaimReleasesElection("missing")).toBe(false);
    expect(jarvisDurableClaimReleasesElection("leased")).toBe(true);
    expect(jarvisDurableClaimReleasesElection("already-spoken")).toBe(true);
  });
});
