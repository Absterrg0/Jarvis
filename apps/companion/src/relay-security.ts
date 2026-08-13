/** The report relay may only expose its tiny preload bridge to the paired host origin. */
export function isTrustedRelayNavigation(input: {
  readonly destination: string;
  readonly pairedHost: string | null;
}): boolean {
  if (input.pairedHost === null) return false;
  try {
    return new URL(input.destination).origin === new URL(input.pairedHost).origin;
  } catch {
    return false;
  }
}
