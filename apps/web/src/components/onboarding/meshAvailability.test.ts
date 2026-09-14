import { describe, expect, it } from "vite-plus/test";

import { resolveOnboardingMeshAvailability } from "./meshAvailability";

describe("resolveOnboardingMeshAvailability", () => {
  it("shows the reach prompt when the environment is unlinked", () => {
    expect(
      resolveOnboardingMeshAvailability({
        linked: false,
        managedTunnelActive: false,
        publishAgentActivity: false,
      }),
    ).toEqual({
      checked: false,
      description: "Reach this computer from your phone or another computer.",
    });
  });

  it("shows checked only when both the tunnel and publishing are on", () => {
    expect(
      resolveOnboardingMeshAvailability({
        linked: true,
        managedTunnelActive: true,
        publishAgentActivity: true,
      }),
    ).toEqual({ checked: true, description: "This computer is on Circe Mesh." });
  });

  it("keeps the switch checked when only publishing is off", () => {
    expect(
      resolveOnboardingMeshAvailability({
        linked: true,
        managedTunnelActive: true,
        publishAgentActivity: false,
      }),
    ).toEqual({
      checked: true,
      description: "This computer is reachable, but activity sharing is off.",
    });
  });

  it("shows a publish_only link as off instead of claiming remote access", () => {
    // linked=true, managedTunnel=false, publish=true is the mixed state the
    // switch used to render as fully on even though the managed tunnel was off.
    expect(
      resolveOnboardingMeshAvailability({
        linked: true,
        managedTunnelActive: false,
        publishAgentActivity: true,
      }),
    ).toEqual({
      checked: false,
      description: "Sharing activity only. Turn on to allow remote access.",
    });
  });

  it("does not claim activity sharing for a link with neither capability on", () => {
    expect(
      resolveOnboardingMeshAvailability({
        linked: true,
        managedTunnelActive: false,
        publishAgentActivity: false,
      }),
    ).toEqual({ checked: false, description: "This computer is linked to Circe Mesh." });
  });
});
