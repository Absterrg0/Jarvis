import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("jarvisCompanion", {
  submitPairingLink: (url: string) => ipcRenderer.invoke("jarvis-companion:pair", url),
});

ipcRenderer.on("jarvis-companion:open", () => {
  window.dispatchEvent(new Event("t3code:open-jarvis"));
});
