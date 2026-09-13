import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface CircePushNotificationsShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class CircePushNotifications extends Context.Service<
  CircePushNotifications,
  CircePushNotificationsShape
>()("t3/circe/Services/CircePushNotifications") {}
