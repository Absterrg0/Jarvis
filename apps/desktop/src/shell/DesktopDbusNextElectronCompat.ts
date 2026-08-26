/**
 * dbus-next optionally loads `usocket`, which still calls `util.isError`.
 * Electron's Node removed that helper, so the first portal D-Bus write becomes
 * an uncaught TypeError and kills the main process before any window opens.
 *
 * Prefer Node `net` for the session bus (`unix:path=...`) by refusing usocket.
 * Also best-effort polyfill `util.isError` if a code path still loads usocket.
 */

import * as NodeModule from "node:module";
import * as NodeUtil from "node:util";

let applied = false;

export function applyDesktopDbusNextElectronCompat(): void {
  if (applied) return;
  applied = true;

  const utilWithIsError = NodeUtil as typeof NodeUtil & {
    isError?: (value: unknown) => boolean;
  };
  if (typeof utilWithIsError.isError !== "function") {
    try {
      Object.defineProperty(utilWithIsError, "isError", {
        configurable: true,
        enumerable: false,
        writable: true,
        value: (value: unknown): boolean =>
          value instanceof Error || Object.prototype.toString.call(value) === "[object Error]",
      });
    } catch {
      try {
        utilWithIsError.isError = (value: unknown): boolean =>
          value instanceof Error || Object.prototype.toString.call(value) === "[object Error]";
      } catch {
        // Electron may freeze util; disabling usocket below is the real fix.
      }
    }
  }

  const moduleWithLoad = NodeModule.default as typeof NodeModule.default & {
    _load: (
      request: string,
      parent: NodeModule.Module | null | undefined,
      isMain: boolean,
    ) => unknown;
  };
  const originalLoad = moduleWithLoad._load.bind(NodeModule.default);
  moduleWithLoad._load = (request, parent, isMain) => {
    if (request === "usocket") {
      throw new Error("usocket is disabled under Electron; dbus-next should use node:net");
    }
    return originalLoad(request, parent, isMain);
  };
}
