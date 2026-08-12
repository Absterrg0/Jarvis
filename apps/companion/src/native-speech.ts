// @effect-diagnostics nodeBuiltinImport:off - this is a narrow native boundary for the
// companion. Windows includes a speech recognizer, so it avoids shipping a resident model.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const executeFile = promisify(execFile);

export const windowsSpeechCommand = [
  "$ErrorActionPreference = 'Stop'",
  "Add-Type -AssemblyName System.Speech",
  "$recognizer = New-Object System.Speech.Recognition.SpeechRecognitionEngine",
  "try {",
  "  $recognizer.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))",
  "  $recognizer.SetInputToDefaultAudioDevice()",
  "  $result = $recognizer.Recognize([TimeSpan]::FromSeconds(18))",
  "  if ($null -ne $result) { [Console]::Out.Write($result.Text) }",
  "} finally { $recognizer.Dispose() }",
].join("; ");

export async function recognizeNativeSpeech(platform = process.platform): Promise<string> {
  if (platform !== "win32")
    throw new Error("Native speech recognition is available on Windows only.");

  const { stdout } = await executeFile(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", windowsSpeechCommand],
    { timeout: 22_000, windowsHide: true, maxBuffer: 16 * 1024 },
  );
  return stdout.trim();
}

export async function speakNativeSpeech(text: string, platform = process.platform): Promise<void> {
  if (platform !== "win32") return;
  const escapedText = text.replaceAll("'", "''");
  await executeFile(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Add-Type -AssemblyName System.Speech; $voice = New-Object System.Speech.Synthesis.SpeechSynthesizer; try { $voice.Rate = 1; $voice.Speak('${escapedText}') } finally { $voice.Dispose() }`,
    ],
    { timeout: 30_000, windowsHide: true, maxBuffer: 16 * 1024 },
  );
}
