import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { make } from "./ElectronGlobalShortcut.ts";

describe("ElectronGlobalShortcut", () => {
  it.effect("keeps a registered accelerator for the scope and releases it afterward", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      const shortcut = make({
        register: (accelerator) => {
          calls.push(`register:${accelerator}`);
          return true;
        },
        unregister: (accelerator) => calls.push(`unregister:${accelerator}`),
      });

      yield* Effect.scoped(shortcut.register("CommandOrControl+Shift+J", () => undefined));

      expect(calls).toEqual([
        "register:CommandOrControl+Shift+J",
        "unregister:CommandOrControl+Shift+J",
      ]);
    }),
  );

  it.effect("does not unregister an accelerator claimed by another application", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      const shortcut = make({
        register: () => false,
        unregister: (accelerator) => calls.push(accelerator),
      });

      yield* Effect.scoped(shortcut.register("CommandOrControl+Shift+J", () => undefined));

      expect(calls).toEqual([]);
    }),
  );
});
