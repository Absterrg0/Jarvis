import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/** A bounded lookup, independent of projects, providers, and desktop control. */
export const CirceQuickLookupInput = Schema.Struct({
  kind: Schema.Literals(["weather", "time"]),
  location: TrimmedNonEmptyString.check(Schema.isMaxLength(160)),
  day: Schema.Literals(["now", "today", "tomorrow"]),
  /**
   * The verbatim utterance the location was copied from. Required: the node
   * refuses a place that does not appear here, so a model can never invent a
   * location, including by omitting this field.
   */
  sourceUtterance: TrimmedNonEmptyString.check(Schema.isMaxLength(16_000)),
});
export type CirceQuickLookupInput = typeof CirceQuickLookupInput.Type;

export const CirceQuickLookupResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("answer"),
    message: TrimmedNonEmptyString,
    source: TrimmedNonEmptyString,
  }),
  Schema.Struct({ status: Schema.Literal("needs-input"), message: TrimmedNonEmptyString }),
  Schema.Struct({ status: Schema.Literal("unavailable"), message: TrimmedNonEmptyString }),
]);
export type CirceQuickLookupResult = typeof CirceQuickLookupResult.Type;
