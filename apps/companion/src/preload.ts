import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("jarvisCompanion", {
  submitPairingLink: (url: string) => ipcRenderer.invoke("jarvis-companion:pair", url),
  recognizeSpeech: () => ipcRenderer.invoke("jarvis-companion:recognize"),
  speak: (text: string) => ipcRenderer.invoke("jarvis-companion:speak", text),
  interruptSpeech: () => ipcRenderer.invoke("jarvis-companion:interrupt-speech"),
  submitTranscript: (text: string) =>
    ipcRenderer.invoke("jarvis-companion:submit-transcript", text),
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
  bubbleReady: () => ipcRenderer.invoke("jarvis-companion:bubble-ready"),
  getSetup: () => ipcRenderer.invoke("jarvis-companion:get-setup"),
  saveDefault: (selection: unknown) =>
    ipcRenderer.invoke("jarvis-companion:save-default", selection),
  saveConversationMode: (conversationMode: string) =>
    ipcRenderer.invoke("jarvis-companion:save-conversation-mode", conversationMode),
  openHost: () => ipcRenderer.invoke("jarvis-companion:open-host"),
  minimize: () => ipcRenderer.invoke("jarvis-companion:minimize"),
  testVoice: () => ipcRenderer.invoke("jarvis-companion:test-voice"),
});

ipcRenderer.on("jarvis-companion:capture-start", () => {
  window.dispatchEvent(new Event("t3code:jarvis-capture-start"));
});

ipcRenderer.on("jarvis-companion:capture-stop", () => {
  window.dispatchEvent(new Event("t3code:jarvis-capture-stop"));
});

ipcRenderer.on("jarvis-companion:status", (_event, status: unknown) => {
  window.dispatchEvent(new CustomEvent("t3code:jarvis-status", { detail: status }));
});
