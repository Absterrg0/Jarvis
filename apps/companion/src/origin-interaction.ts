/** Safe renderer argument used to carry the Companion installation identity into a relay preload. */
export const companionOriginInteractionIdArgumentPrefix = "--jarvis-origin-interaction-id=";

export function companionOriginInteractionIdArgument(originInteractionId: string): string {
  return `${companionOriginInteractionIdArgumentPrefix}${originInteractionId}`;
}

/** Stable origin node identity for this Companion installation.
 *
 * The paired host's environment ID identifies where execution happens, not
 * where the interaction began, so it must never be reused as the origin.
 */
export function companionOriginNodeIdForInstallation(originInteractionId: string): string {
  const identity = originInteractionId.trim();
  return `companion-origin:${identity}`;
}

/** Reads the identity synchronously before the hidden web reporter starts mounting. */
export function parseCompanionOriginInteractionId(argv: ReadonlyArray<string>): string | undefined {
  const argument = argv.find((value) =>
    value.startsWith(companionOriginInteractionIdArgumentPrefix),
  );
  const identity = argument?.slice(companionOriginInteractionIdArgumentPrefix.length).trim();
  return identity === undefined || identity.length === 0 ? undefined : identity;
}
