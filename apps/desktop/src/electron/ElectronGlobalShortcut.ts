import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";

import { globalShortcut } from "electron";

export interface ElectronGlobalShortcutApi {
  readonly register: (accelerator: string, callback: () => void) => boolean;
  readonly unregister: (accelerator: string) => void;
}

export class ElectronGlobalShortcut extends Context.Service<
  ElectronGlobalShortcut,
  {
    readonly register: (
      accelerator: string,
      callback: () => void,
    ) => Effect.Effect<boolean, never, Scope.Scope>;
  }
>()("@t3tools/desktop/electron/ElectronGlobalShortcut") {}

export const make = (api: ElectronGlobalShortcutApi): ElectronGlobalShortcut["Service"] =>
  ElectronGlobalShortcut.of({
    register: (accelerator, callback) =>
      Effect.acquireRelease(
        Effect.sync(() => api.register(accelerator, callback)),
        (registered) => (registered ? Effect.sync(() => api.unregister(accelerator)) : Effect.void),
      ),
  });

export const layer = Layer.succeed(ElectronGlobalShortcut, make(globalShortcut));
