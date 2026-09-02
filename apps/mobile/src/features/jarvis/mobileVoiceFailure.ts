import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type * as Cause from "effect/Cause";

export function mobileVoiceFailureMessage(
  result: { readonly cause: Cause.Cause<unknown> },
  fallback = "Jarvis voice failed.",
): string {
  const failure = squashAtomCommandFailure(result);
  return failure instanceof Error && failure.message.trim().length > 0 ? failure.message : fallback;
}
