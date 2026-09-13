import { describe, expect, it } from "vite-plus/test";
import { EnvironmentAuthorizationError, ServerEnvironmentLabelError } from "@t3tools/contracts";

import {
  describeCirceOnboardingLabelSaveError,
  circeOnboardingDeviceNameHint,
  validateCirceNodeLabel,
} from "./deviceName";

describe("onboarding device name", () => {
  it("validates and trims the persisted device label boundary", () => {
    expect(validateCirceNodeLabel("  Studio node  ")).toEqual({
      valid: true,
      value: "Studio node",
    });
    expect(validateCirceNodeLabel("   ").valid).toBe(false);
    expect(validateCirceNodeLabel("x".repeat(81)).valid).toBe(false);
  });

  it("names the exact save failure so the device step can retry truthfully", () => {
    expect(
      describeCirceOnboardingLabelSaveError(
        new EnvironmentAuthorizationError({
          message: "The authenticated token is missing required scope: orchestration:operate.",
          requiredScope: "orchestration:operate",
        }),
      ),
    ).toBe(
      "You don't have permission to rename this device (needs orchestration:operate). " +
        "Ask an admin to rename it, then try again.",
    );
    expect(
      describeCirceOnboardingLabelSaveError(
        new ServerEnvironmentLabelError({ message: "Environment label must be 1–80 characters." }),
      ),
    ).toBe(
      "The server couldn't save the name (Environment label must be 1–80 characters.). Try again.",
    );
    expect(describeCirceOnboardingLabelSaveError({ _tag: "EnvironmentNotRegisteredError" })).toBe(
      "This device isn't connected. Reconnect it and try again.",
    );
    expect(describeCirceOnboardingLabelSaveError({ _tag: "ConnectionTransientError" })).toBe(
      "This device isn't connected. Reconnect it and try again.",
    );
    expect(describeCirceOnboardingLabelSaveError({ _tag: "ConnectionBlockedError" })).toBe(
      "This device isn't connected. Reconnect it and try again.",
    );
    expect(describeCirceOnboardingLabelSaveError({ _tag: "EnvironmentRpcUnavailableError" })).toBe(
      "This device isn't connected. Reconnect it and try again.",
    );
    expect(describeCirceOnboardingLabelSaveError(new Error("boom"))).toBe(
      "Could not save the device name.",
    );
    expect(describeCirceOnboardingLabelSaveError(null)).toBe("Could not save the device name.");
  });

  it("keeps the server-wide rename copy only for the local node", () => {
    expect(circeOnboardingDeviceNameHint("PrimaryConnectionTarget")).toBe(
      "Circe uses this name anywhere this node appears. It saves when you continue.",
    );
    expect(circeOnboardingDeviceNameHint("BearerConnectionTarget")).toBe(
      "This renames the connected node for every client. " +
        "To rename only your view, use Settings → Connections.",
    );
    expect(circeOnboardingDeviceNameHint("RelayConnectionTarget")).toContain("every client");
  });
});
