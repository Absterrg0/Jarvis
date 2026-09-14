/**
 * Onboarding presents Circe Mesh as one switch, but the relay link carries two
 * independent capabilities: the managed tunnel (remote reachability) and agent
 * activity publishing. "Available to my other devices" promises reachability,
 * so the switch is checked only while the managed tunnel is active. A link that
 * exists in `publish_only` mode is therefore shown as off with copy that says
 * remote access is off, instead of a partial link reading as fully on.
 *
 * Turning the switch on reconciles both capabilities on; turning it off removes
 * the link entirely. The switch is an atomic onboarding shortcut, not a mirror
 * of the two independent settings.
 */

export interface OnboardingMeshAvailability {
  readonly linked: boolean;
  readonly managedTunnelActive: boolean;
  readonly publishAgentActivity: boolean;
}

export interface OnboardingMeshAvailabilityView {
  readonly checked: boolean;
  readonly description: string;
}

export function resolveOnboardingMeshAvailability(
  state: OnboardingMeshAvailability,
): OnboardingMeshAvailabilityView {
  if (!state.linked) {
    return {
      checked: false,
      description: "Reach this computer from your phone or another computer.",
    };
  }
  if (state.managedTunnelActive && state.publishAgentActivity) {
    return { checked: true, description: "This computer is on Circe Mesh." };
  }
  if (state.managedTunnelActive) {
    return {
      checked: true,
      description: "This computer is reachable, but activity sharing is off.",
    };
  }
  if (state.publishAgentActivity) {
    return {
      checked: false,
      description: "Sharing activity only. Turn on to allow remote access.",
    };
  }
  return { checked: false, description: "This computer is linked to Circe Mesh." };
}
