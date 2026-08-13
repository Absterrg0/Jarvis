import { autoUpdater } from "electron-updater";

import type { CompanionUpdateEvent, CompanionUpdater } from "./updates.ts";

export const electronCompanionUpdater: CompanionUpdater = {
  configure: () => {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.disableDifferentialDownload = false;
    autoUpdater.allowPrerelease = false;
  },
  on: (event: CompanionUpdateEvent, listener: (...args: ReadonlyArray<unknown>) => void) => {
    const callback = listener as (...args: Array<unknown>) => void;
    autoUpdater.on(event, callback);
    return () => autoUpdater.removeListener(event, callback);
  },
  check: async () => {
    await autoUpdater.checkForUpdates();
  },
  install: () => autoUpdater.quitAndInstall(false, true),
};
