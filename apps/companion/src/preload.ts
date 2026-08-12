import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("jarvisCompanion", {
  submitPairingLink: (url: string) => ipcRenderer.invoke("jarvis-companion:pair", url),
  recognizeSpeech: () => ipcRenderer.invoke("jarvis-companion:recognize"),
  speak: (text: string) => ipcRenderer.invoke("jarvis-companion:speak", text),
  submitTranscript: (text: string) =>
    ipcRenderer.invoke("jarvis-companion:submit-transcript", text),
  taskStatus: (state: string, detail: string, kind: string) =>
    ipcRenderer.invoke("jarvis-companion:task-status", { state, detail, kind }),
  setAttentionTarget: (target: { projectId: string; threadId: string }) =>
    ipcRenderer.invoke("jarvis-companion:set-attention-target", target),
  bubbleReady: () => ipcRenderer.invoke("jarvis-companion:bubble-ready"),
});

ipcRenderer.on("jarvis-companion:capture-start", () => {
  window.dispatchEvent(new Event("t3code:jarvis-capture-start"));
});

ipcRenderer.on("jarvis-companion:status", (_event, status: unknown) => {
  window.dispatchEvent(new CustomEvent("t3code:jarvis-status", { detail: status }));
});
