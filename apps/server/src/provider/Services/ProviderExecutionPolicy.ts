import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

export interface ProviderExecutionPolicyShape {
  readonly canExecute: Effect.Effect<boolean>;
}

const allowAll: ProviderExecutionPolicyShape = {
  canExecute: Effect.succeed(true),
};

export class ProviderExecutionPolicy extends Context.Reference<ProviderExecutionPolicyShape>(
  "t3/provider/Services/ProviderExecutionPolicy",
  { defaultValue: () => allowAll },
) {}
