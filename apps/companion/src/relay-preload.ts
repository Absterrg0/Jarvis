import { contextBridge, ipcRenderer } from "electron";

/**
 * The hidden Jarvis Host page only needs report delivery. It deliberately
 * cannot start capture, change pairings/defaults, or submit direct tasks.
 */
contextBridge.exposeInMainWorld("jarvisCompanion", {
  relayMode: true,
  speak: (text: string) => ipcRenderer.invoke("jarvis-companion:speak", text),
  taskStatus: (state: string, detail: string, kind: string) =>
    ipcRenderer.invoke("jarvis-companion:task-status", { state, detail, kind }),
  setAttentionTarget: (target: { projectId: string; threadId: string }) =>
    ipcRenderer.invoke("jarvis-companion:set-attention-target", target),
  reportRelayStatus: (available: boolean) =>
    ipcRenderer.invoke("jarvis-companion:report-relay-status", available),
});
