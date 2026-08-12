import { contextBridge, ipcRenderer } from "electron";

import { isRelayDocument } from "./relay.ts";

let pendingVoiceTranscript: string | null = null;

contextBridge.exposeInMainWorld("jarvisCompanion", {
  submitPairingLink: (url: string) => ipcRenderer.invoke("jarvis-companion:pair", url),
  hideOverlay: () => ipcRenderer.invoke("jarvis-companion:hide"),
  recognizeSpeech: () => ipcRenderer.invoke("jarvis-companion:recognize"),
  speak: (text: string) => ipcRenderer.invoke("jarvis-companion:speak", text),
  submitTranscript: (text: string) =>
    ipcRenderer.invoke("jarvis-companion:submit-transcript", text),
  taskStatus: (state: string, detail: string, kind: string) =>
    ipcRenderer.invoke("jarvis-companion:task-status", { state, detail, kind }),
  relayReady: () => ipcRenderer.invoke("jarvis-companion:relay-ready"),
  consumeVoiceTranscript: () => {
    const transcript = pendingVoiceTranscript;
    pendingVoiceTranscript = null;
    return transcript;
  },
});

ipcRenderer.on("jarvis-companion:voice-transcript", (_event, transcript: unknown) => {
  if (typeof transcript === "string") {
    pendingVoiceTranscript = transcript;
    ipcRenderer.send("jarvis-companion:transcript-buffered", transcript);
    window.dispatchEvent(new CustomEvent("t3code:jarvis-voice-transcript", { detail: transcript }));
  }
});

ipcRenderer.on("jarvis-companion:capture-start", () => {
  window.dispatchEvent(new Event("t3code:jarvis-capture-start"));
});

ipcRenderer.on("jarvis-companion:status", (_event, status: unknown) => {
  window.dispatchEvent(new CustomEvent("t3code:jarvis-status", { detail: status }));
});

// This runs before the remote UI hydrates. The transcript receiver above
// retains anything sent immediately after the acknowledgement, then the UI
// consumes it once it is mounted. Keeping this at the preload boundary avoids
// a fragile dependency on a hidden React tree becoming ready in time.
window.addEventListener("DOMContentLoaded", () => {
  if (isRelayDocument(window.location.href)) {
    void ipcRenderer.invoke("jarvis-companion:relay-ready");
  }
});
