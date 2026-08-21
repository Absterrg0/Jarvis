import { contextBridge, ipcRenderer } from "electron";

/**
 * The hidden Jarvis Host page only needs report delivery. It deliberately
 * cannot start capture, change pairings/defaults, or submit direct tasks.
 */
contextBridge.exposeInMainWorld("jarvisCompanion", {
  relayMode: true,
  prepareSpeech: () => ipcRenderer.invoke("jarvis-companion:prepare-speech"),
  speak: (text: string) => ipcRenderer.invoke("jarvis-companion:speak", text),
  taskStatus: (
    state: string,
    detail: string,
    kind: string,
    options?: { readonly context?: string; readonly stream?: boolean; readonly statusId?: string },
  ) => ipcRenderer.invoke("jarvis-companion:task-status", { state, detail, kind, ...options }),
  finishTaskStatus: (statusId: string) =>
    ipcRenderer.invoke("jarvis-companion:finish-task-status", statusId),
  setAttentionTarget: (target: { projectId: string; threadId: string; reportKind?: string }) =>
    ipcRenderer.invoke("jarvis-companion:set-attention-target", target),
  reportRelayStatus: (available: boolean) =>
    ipcRenderer.invoke("jarvis-companion:report-relay-status", available),
});
