// @effect-diagnostics nodeBuiltinImport:off - this is a narrow native boundary for the
// companion. Windows includes a speech recognizer, so it avoids shipping a resident model.
import { execFile, spawn } from "node:child_process";
import * as Timers from "node:timers/promises";
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

export async function playNativeCue(path: string, platform = process.platform): Promise<void> {
  if (platform !== "win32") return;
  const escapedPath = path.replaceAll("'", "''");
  await executeFile(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$cue = New-Object System.Media.SoundPlayer '${escapedPath}'; $cue.PlaySync()`,
    ],
    { timeout: 5_000, windowsHide: true, maxBuffer: 16 * 1024 },
  );
}

export async function recognizeWithWhisper(input: {
  readonly executablePath: string;
  readonly modelPath: string;
  readonly platform?: string;
}): Promise<string> {
  if ((input.platform ?? process.platform) !== "win32") {
    throw new Error("Local Whisper is available on Windows only.");
  }
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(
      input.executablePath,
      ["-m", input.modelPath, "-t", "4", "--step", "0", "--length", "12000", "-vth", "0.6"],
      { windowsHide: true },
    );
    let output = "";
    let settled = false;
    const finish = (value: string | Error) => {
      if (settled) return;
      settled = true;
      child.kill();
      if (value instanceof Error) reject(value);
      else resolve(value);
    };
    const receiveOutput = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      const lines = output
        .split(/\r?\n/u)
        .map((line) => line.trim().replace(/^\[[^\]]+\]\s*/u, ""))
        .filter(
          (line) =>
            line.length > 0 &&
            !/^(system_info|main:|init:|whisper_|processing|start speaking|capture|press ctrl)/iu.test(
              line,
            ),
        );
      const transcript = lines.at(-1);
      if (transcript) finish(transcript);
    };
    child.stdout.on("data", receiveOutput);
    child.stderr.on("data", receiveOutput);
    child.once("error", (error) => finish(error));
    child.once("exit", () => {
      if (!settled) finish(new Error("Local Whisper stopped before recognizing speech."));
    });
    void Timers.setTimeout(20_000).then(() =>
      finish(new Error("I didn't hear a complete instruction. Try again.")),
    );
  });
}
