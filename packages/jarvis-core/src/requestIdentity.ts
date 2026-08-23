import type { EnvironmentId, JarvisRequestMetadata } from "@t3tools/contracts";

/**
 * Derive the deterministic scope used by Jarvis command IDs.
 *
 * Auth sessions are intentionally absent here. A session is a transport
 * lease, not the identity of a submitted interaction, and it changes when a
 * companion reconnects or is recreated. The target environment is part of
 * the scope so a request ID reused by two execution nodes cannot collide;
 * origin fields further separate independent clients that happen to choose
 * the same request ID.
 */
export function jarvisRequestAcceptanceKey(input: {
  readonly executionNodeId?: EnvironmentId | undefined;
  readonly requestMetadata?: JarvisRequestMetadata | undefined;
}): string | undefined {
  const metadata = input.requestMetadata;
  if (metadata === undefined) return undefined;

  const part = (value: string | undefined, fallback: string): string =>
    encodeURIComponent(value === undefined || value.length === 0 ? fallback : value);
  const origin = metadata.origin;
  return [
    "jarvis",
    "request",
    part(input.executionNodeId, "local-node"),
    part(origin?.originNodeId, "unknown-origin-node"),
    part(origin?.originInteractionId, "unknown-origin-interaction"),
    part(metadata.requestId, "unknown-request"),
  ].join(":");
}
