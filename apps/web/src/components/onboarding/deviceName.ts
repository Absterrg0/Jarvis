import { SERVER_ENVIRONMENT_LABEL_MAX_LENGTH } from "@t3tools/contracts";

/**
 * Device-name rules for the first-run setup wizard's "Name this device"
 * field. Pure helpers: validation, user-facing save failures, and helper copy.
 */

export function validateCirceNodeLabel(
  input: string,
):
  | { readonly valid: true; readonly value: string }
  | { readonly valid: false; readonly message: string } {
  const value = input.trim();
  if (value.length === 0) {
    return { valid: false, message: "Enter a device name." };
  }
  if (value.length > SERVER_ENVIRONMENT_LABEL_MAX_LENGTH) {
    return {
      valid: false,
      message: `Device names must be ${SERVER_ENVIRONMENT_LABEL_MAX_LENGTH} characters or fewer.`,
    };
  }
  return { valid: true, value };
}

/**
 * User-facing reason when the device save fails. The wizard keeps the typed
 * value so pressing Continue again retries the same rename.
 */
export function describeCirceOnboardingLabelSaveError(cause: unknown): string {
  if (typeof cause === "object" && cause !== null) {
    const tag = (cause as { readonly _tag?: unknown })._tag;
    if (tag === "EnvironmentAuthorizationError") {
      const requiredScope = (cause as { readonly requiredScope?: unknown }).requiredScope;
      const scope = typeof requiredScope === "string" ? requiredScope : "additional access";
      return (
        `You don't have permission to rename this device (needs ${scope}). ` +
        `Ask an admin to rename it, then try again.`
      );
    }
    if (tag === "ServerEnvironmentLabelError") {
      const message = (cause as { readonly message?: unknown }).message;
      if (typeof message === "string" && message.trim().length > 0) {
        return `The server couldn't save the name (${message}). Try again.`;
      }
      return "Could not save the device name.";
    }
    if (
      tag === "EnvironmentNotRegisteredError" ||
      tag === "EnvironmentRpcUnavailableError" ||
      tag === "ConnectionTransientError" ||
      tag === "ConnectionBlockedError"
    ) {
      return "This device isn't connected. Reconnect it and try again.";
    }
  }
  return "Could not save the device name.";
}

/**
 * Helper copy. Renaming from a remote view renames the connected node for
 * every client, so say so instead of implying a local-only label.
 */
export function circeOnboardingDeviceNameHint(targetTag: string | null | undefined): string {
  if (targetTag !== undefined && targetTag !== null && targetTag !== "PrimaryConnectionTarget") {
    return (
      "This renames the connected node for every client. " +
      "To rename only your view, use Settings → Connections."
    );
  }
  return "Circe uses this name anywhere this node appears. It saves when you continue.";
}
