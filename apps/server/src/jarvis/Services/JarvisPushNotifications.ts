import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface JarvisPushNotificationsShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class JarvisPushNotifications extends Context.Service<
  JarvisPushNotifications,
  JarvisPushNotificationsShape
>()("t3/jarvis/Services/JarvisPushNotifications") {}
