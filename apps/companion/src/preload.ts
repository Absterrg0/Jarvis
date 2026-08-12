import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("jarvisCompanion", {
  submitPairingLink: (url: string) => ipcRenderer.invoke("jarvis-companion:pair", url),
  hideOverlay: () => ipcRenderer.invoke("jarvis-companion:hide"),
  recognizeSpeech: () => ipcRenderer.invoke("jarvis-companion:recognize"),
});

ipcRenderer.on("jarvis-companion:open", () => {
  window.dispatchEvent(new Event("t3code:open-jarvis"));
});
