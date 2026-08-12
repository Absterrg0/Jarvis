import { contextBridge, ipcRenderer } from "electron";

let pendingVoiceTranscript: string | null = null;

contextBridge.exposeInMainWorld("jarvisCompanion", {
  submitPairingLink: (url: string) => ipcRenderer.invoke("jarvis-companion:pair", url),
  hideOverlay: () => ipcRenderer.invoke("jarvis-companion:hide"),
  recognizeSpeech: () => ipcRenderer.invoke("jarvis-companion:recognize"),
  speak: (text: string) => ipcRenderer.invoke("jarvis-companion:speak", text),
  submitTranscript: (text: string) =>
    ipcRenderer.invoke("jarvis-companion:submit-transcript", text),
  consumeVoiceTranscript: () => {
    const transcript = pendingVoiceTranscript;
    pendingVoiceTranscript = null;
    return transcript;
  },
});

ipcRenderer.on("jarvis-companion:voice-transcript", (_event, transcript: unknown) => {
  if (typeof transcript === "string") {
    pendingVoiceTranscript = transcript;
    window.dispatchEvent(new CustomEvent("t3code:jarvis-voice-transcript", { detail: transcript }));
  }
});

ipcRenderer.on("jarvis-companion:capture-start", () => {
  window.dispatchEvent(new Event("t3code:jarvis-capture-start"));
});
