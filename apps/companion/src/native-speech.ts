// @effect-diagnostics nodeBuiltinImport:off - this is a narrow native boundary for the
// companion. It owns local speech runtimes and keeps native process details out of the UI.
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import * as Timers from "node:timers/promises";
import { promisify } from "node:util";

const executeFile = promisify(execFile);

const piperVoiceModel = "en_US-hfc_female-medium.onnx";
const piperVoiceConfig = `${piperVoiceModel}.json`;

export type PiperVoicePaths = {
  readonly executablePath: string;
  readonly modelPath: string;
  readonly configPath: string;
};

/**
 * Piper and the voice are shipped as separate generated resources so the
 * repository stays small while every packaged Windows companion is entirely
 * local at runtime.
 */
export function piperVoicePaths(resourceRoot: string): PiperVoicePaths {
  return {
    executablePath: join(resourceRoot, "runtime", "piper.exe"),
    modelPath: join(resourceRoot, "voice", piperVoiceModel),
    configPath: join(resourceRoot, "voice", piperVoiceConfig),
  };
}

function bundledPiperVoicePaths(): PiperVoicePaths {
  const packagedRoot =
    typeof process.resourcesPath === "string"
      ? join(process.resourcesPath, "jarvis-resources", "piper")
      : undefined;
  const resourceRoot =
    packagedRoot !== undefined && existsSync(join(packagedRoot, "runtime", "piper.exe"))
      ? packagedRoot
      : resolve(import.meta.dirname, "../resources/piper");
  return piperVoicePaths(resourceRoot);
}

export function piperSynthesisArguments(paths: PiperVoicePaths, outputPath: string): Array<string> {
  return [
    "--model",
    paths.modelPath,
    "--config",
    paths.configPath,
    "--output_file",
    outputPath,
    // Stay close to this voice model's trained inference defaults. A slightly
    // longer phrase and sentence pause produces calmer conversational cadence
    // than the previous sped-up, high-variance rendering.
    "--noise_scale",
    "0.667",
    "--length_scale",
    "1.03",
    "--noise_w",
    "0.8",
    "--sentence_silence",
    "0.28",
    "--quiet",
  ];
}

function piperResourceError(paths: PiperVoicePaths): Error | undefined {
  const resources: ReadonlyArray<readonly [string, string]> = [
    [paths.executablePath, "Piper runtime"],
    [paths.modelPath, "Piper hfc_female voice"],
    [paths.configPath, "Piper hfc_female voice configuration"],
  ];
  const missing = resources.find(([path]) => !existsSync(path));
  if (missing === undefined) return undefined;
  return new Error(
    `Jarvis voice is unavailable because the bundled ${missing[1]} is missing. Reinstall Jarvis Companion.`,
  );
}

function speechInterruptedError(): Error {
  const error = new Error("Jarvis speech was interrupted.");
  error.name = "AbortError";
  return error;
}

async function synthesizeWithPiper(
  text: string,
  paths: PiperVoicePaths,
  signal?: AbortSignal,
): Promise<string> {
  const resourceError = piperResourceError(paths);
  if (resourceError !== undefined) throw resourceError;
  if (signal?.aborted) throw speechInterruptedError();

  const outputPath = join(tmpdir(), `jarvis-piper-${randomUUID()}.wav`);
  try {
    await new Promise<void>((resolveSynthesis, rejectSynthesis) => {
      const child = spawn(paths.executablePath, piperSynthesisArguments(paths, outputPath), {
        cwd: dirname(paths.executablePath),
        windowsHide: true,
        stdio: ["pipe", "ignore", "pipe"],
      });
      let diagnostics = "";
      let settled = false;
      const timeoutAbort = new AbortController();
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        timeoutAbort.abort();
        signal?.removeEventListener("abort", onAbort);
        if (error !== undefined) {
          if (!child.killed) child.kill();
          rejectSynthesis(error);
        } else {
          resolveSynthesis();
        }
      };
      const onAbort = () => finish(speechInterruptedError());
      signal?.addEventListener("abort", onAbort, { once: true });
      void Timers.setTimeout(nativeSpeechSynthesisTimeoutMs, undefined, {
        signal: timeoutAbort.signal,
      })
        .then(() => finish(new Error("Jarvis voice took too long to respond.")))
        .catch(() => undefined);
      child.stderr.on("data", (chunk: Buffer) => {
        diagnostics = `${diagnostics}${chunk.toString("utf8")}`.slice(-4_096);
      });
      child.once("error", (error) => finish(error));
      child.once("exit", (code, exitSignal) => {
        if (signal?.aborted) {
          finish(speechInterruptedError());
          return;
        }
        if (code === 0) {
          finish();
          return;
        }
        const detail = diagnostics.trim().split(/\r?\n/u).at(-1);
        finish(
          new Error(
            detail
              ? `Jarvis voice could not start: ${detail}`
              : `Jarvis voice could not start${exitSignal === null ? ` (exit ${code ?? "unknown"})` : ` (${exitSignal})`}.`,
          ),
        );
      });
      child.stdin.end(`${text.trim()}\n`);
    });
  } catch (cause) {
    await rm(outputPath, { force: true });
    throw cause;
  }
  return outputPath;
}

type SpeechJob = {
  readonly text: string;
  readonly resolve: () => void;
  readonly reject: (cause: unknown) => void;
};

export type CompanionSpeechInterruptSource = "tray" | "overlay" | "capture" | "relay";

/**
 * User-facing stop commands cancel playback locally. The speak promise still
 * completes so Host report acknowledgement is independent of whether the user
 * heard the whole sentence.
 */
export function companionSpeechInterruptPolicy(source: CompanionSpeechInterruptSource): {
  readonly accepted: boolean;
  readonly presentInterrupted: boolean;
  readonly completeSpeak: boolean;
} {
  if (source === "relay") {
    return { accepted: false, presentInterrupted: false, completeSpeak: true };
  }
  return {
    accepted: true,
    presentInterrupted: source !== "capture",
    completeSpeak: true,
  };
}

export type LatestSpeechQueue = {
  readonly enqueue: (text: string) => Promise<void>;
  readonly interrupt: () => void;
  readonly isActive: () => boolean;
};

/**
 * Keeps spoken reports useful when several arrive together: the sentence in
 * progress can be interrupted, stale queued sentences are discarded, and only
 * the latest state remains. A completion report should not be read minutes late.
 */
export function createLatestSpeechQueue(
  speak: (text: string, signal: AbortSignal) => Promise<void>,
): LatestSpeechQueue {
  let active = false;
  let generation = 0;
  let latest: SpeechJob | undefined;
  let currentAbort: AbortController | undefined;

  const run = async (job: SpeechJob, runGeneration: number): Promise<void> => {
    const abort = new AbortController();
    currentAbort = abort;
    try {
      await speak(job.text, abort.signal);
      job.resolve();
    } catch (cause) {
      if (abort.signal.aborted || (cause instanceof Error && cause.name === "AbortError")) {
        job.resolve();
      } else {
        job.reject(cause);
      }
    } finally {
      if (currentAbort === abort) currentAbort = undefined;
      if (generation !== runGeneration) return;
      const next = latest;
      latest = undefined;
      if (next === undefined) {
        active = false;
        return;
      }
      void run(next, runGeneration);
    }
  };

  return {
    enqueue(text) {
      return new Promise<void>((resolveSpeech, rejectSpeech) => {
        const job: SpeechJob = { text, resolve: resolveSpeech, reject: rejectSpeech };
        if (!active) {
          active = true;
          void run(job, generation);
          return;
        }
        // A replaced report was intentionally skipped, rather than failed.
        latest?.resolve();
        latest = job;
      });
    },
    interrupt() {
      latest?.resolve();
      latest = undefined;
      generation += 1;
      active = false;
      currentAbort?.abort();
      currentAbort = undefined;
    },
    isActive() {
      return active;
    },
  };
}

async function synthesizeAndPlayPiper(text: string, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  const outputPath = await synthesizeWithPiper(text, bundledPiperVoicePaths(), signal);
  try {
    if (signal.aborted) return;
    await playNativeCue(outputPath, process.platform, signal);
  } finally {
    await rm(outputPath, { force: true });
  }
}

const piperSpeechQueue = createLatestSpeechQueue(synthesizeAndPlayPiper);

/**
 * `whisper-stream` writes engine diagnostics to stderr before it opens an
 * audio device. Actual VAD results are bracketed on stdout by
 * `### Transcription … START/END`, so this parser deliberately accepts only
 * stdout and can surface every completed segment during a held capture.
 */
export function createWhisperTranscriptBatchReader() {
  let remainder = "";
  let capturing = false;
  let segments: Array<string> = [];

  return {
    push(output: string): Array<string> {
      remainder += output;
      const lines = remainder.split(/\r?\n/u);
      remainder = lines.pop() ?? "";
      const transcripts: Array<string> = [];

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (/^### Transcription \d+ START\b/u.test(line)) {
          capturing = true;
          segments = [];
          continue;
        }
        if (/^### Transcription \d+ END\b/u.test(line)) {
          if (!capturing) continue;
          capturing = false;
          const transcript = segments.join(" ").replace(/\s+/gu, " ").trim();
          if (transcript.length > 0) transcripts.push(transcript);
          continue;
        }
        if (!capturing || line.length === 0) continue;
        const text = line.replace(/^\[[^\]]+\]\s*/u, "").trim();
        if (text.length > 0) segments.push(text);
      }
      return transcripts;
    },
  };
}

/**
 * Compatibility reader for one-shot callers. Held capture uses the batch
 * reader above so two VAD blocks in one stdout chunk are never dropped.
 */
export function createWhisperTranscriptReader() {
  const batchReader = createWhisperTranscriptBatchReader();
  const queued: Array<string> = [];
  return {
    push(output: string): string | undefined {
      queued.push(...batchReader.push(output));
      return queued.shift();
    },
  };
}

export type WhisperCapture = {
  readonly result: Promise<string>;
  release(): void;
  cancel(): void;
};

export type WhisperCaptureInput = {
  readonly executablePath: string;
  readonly modelPath: string;
  /** Fires only after whisper-stream has opened the local audio device. */
  readonly onReady?: () => void;
  readonly onTranscript?: (transcript: string) => void;
  /** Applies the live Host vocabulary at the recognizer boundary. */
  readonly transformTranscript?: (transcript: string) => string;
  readonly platform?: string;
};

/**
 * Whisper-stream emits its final VAD segment after a natural pause. A short
 * release tail drops that segment under normal desktop scheduling, which is
 * indistinguishable from the user not speaking at all.
 */
export const whisperReleaseTailMs = 3_500;

/**
 * Holds the small amount of policy that separates partial VAD transcripts
 * from the result sent after the hotkey is released. Keeping it pure makes the
 * native process boundary predictable and directly testable.
 */
export function createWhisperCaptureState() {
  let released = false;
  let completeTranscript: string | undefined;

  const mergeTranscript = (current: string | undefined, next: string): string => {
    if (current === undefined || current.length === 0) return next;
    const currentWords = current.split(/\s+/u);
    const nextWords = next.split(/\s+/u);
    const comparable = (value: string) =>
      value.toLocaleLowerCase("en-US").replace(/[^\p{Letter}\p{Number}]/gu, "");
    const overlap = Array.from(
      { length: Math.min(currentWords.length, nextWords.length) },
      (_, index) => index + 1,
    )
      .toReversed()
      .find((size) =>
        currentWords
          .slice(-size)
          .map(comparable)
          .every((word, index) => word === comparable(nextWords[index]!)),
      );
    return [...currentWords, ...nextWords.slice(overlap ?? 0)].join(" ").trim();
  };

  return {
    recordTranscript(transcript: string): boolean {
      completeTranscript = mergeTranscript(completeTranscript, transcript);
      return released;
    },
    release(): void {
      released = true;
    },
    latestTranscript(): string | undefined {
      return completeTranscript;
    },
    isReleased(): boolean {
      return released;
    },
  };
}

/** Keeps one second of microphone pre-roll so the opening word survives VAD. */
export const whisperArguments = (modelPath: string) => [
  "-m",
  modelPath,
  "-t",
  "4",
  "--step",
  "0",
  "--length",
  "12000",
  "--keep",
  "1000",
  "-vth",
  "0.5",
];

/** The bundled whisper-stream program prints this only after audio.init succeeds. */
export function isWhisperCaptureReadyOutput(output: string): boolean {
  return /\[Start speaking\]/u.test(output);
}

type WhisperCaptureMode = "held" | "one-shot";

function startWhisperCaptureInternal(
  input: WhisperCaptureInput,
  mode: WhisperCaptureMode,
): WhisperCapture {
  if ((input.platform ?? process.platform) !== "win32") {
    throw new Error("Local Whisper is available on Windows only.");
  }

  const transcriptReader = createWhisperTranscriptBatchReader();
  const captureState = createWhisperCaptureState();
  let child: ReturnType<typeof spawn> | undefined;
  let settled = false;
  let diagnostics = "";
  let readinessOutput = "";
  let microphoneReady = false;
  let releaseTailAbort: AbortController | undefined;
  let oneShotTimeoutAbort: AbortController | undefined;
  let resolveResult: (transcript: string) => void;
  let rejectResult: (error: Error) => void;
  const result = new Promise<string>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  const finish = (value: string | Error) => {
    if (settled) return;
    settled = true;
    releaseTailAbort?.abort();
    oneShotTimeoutAbort?.abort();
    if (child !== undefined && !child.killed) child.kill();
    if (value instanceof Error) rejectResult(value);
    else resolveResult(value);
  };

  const finishFromLatestTranscript = () => {
    const transcript = captureState.latestTranscript();
    finish(transcript ?? new Error("I didn't hear a complete instruction. Try again."));
  };

  const markMicrophoneReady = (output: string) => {
    if (microphoneReady) return;
    readinessOutput = `${readinessOutput}${output}`.slice(-256);
    if (!isWhisperCaptureReadyOutput(readinessOutput)) return;
    microphoneReady = true;
    try {
      input.onReady?.();
    } catch {
      // A presentation callback must not stop the local recorder.
    }
  };

  const release = () => {
    if (settled || captureState.isReleased()) return;
    captureState.release();
    releaseTailAbort = new AbortController();
    void Timers.setTimeout(whisperReleaseTailMs, undefined, { signal: releaseTailAbort.signal })
      .then(finishFromLatestTranscript)
      .catch(() => undefined);
  };

  try {
    child = spawn(input.executablePath, whisperArguments(input.modelPath), { windowsHide: true });
  } catch (cause) {
    finish(cause instanceof Error ? cause : new Error("Local Whisper could not start."));
    return { result, release, cancel: () => finish(new Error("Voice capture cancelled.")) };
  }

  if (child.stdout === null || child.stderr === null) {
    finish(new Error("Local Whisper did not expose its audio transcript streams."));
    return { result, release, cancel: () => finish(new Error("Voice capture cancelled.")) };
  }

  child.stdout.on("data", (chunk: Buffer) => {
    const output = chunk.toString("utf8");
    markMicrophoneReady(output);
    let finalTranscript: string | undefined;
    for (const rawTranscript of transcriptReader.push(output)) {
      let transcript = rawTranscript;
      try {
        transcript = input.transformTranscript?.(rawTranscript) ?? rawTranscript;
      } catch {
        // Vocabulary repair is advisory; never discard a valid local transcript.
      }
      const shouldFinish = captureState.recordTranscript(transcript);
      try {
        input.onTranscript?.(transcript);
      } catch {
        // Rendering a partial transcript must never stop the microphone.
      }
      if (mode === "one-shot") {
        finish(transcript);
        break;
      }
      if (shouldFinish) finalTranscript = transcript;
    }
    if (finalTranscript !== undefined) finish(finalTranscript);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    const output = chunk.toString("utf8");
    diagnostics = `${diagnostics}${output}`.slice(-4_096);
    markMicrophoneReady(output);
  });
  child.once("error", (error) => finish(error));
  child.once("exit", () => {
    if (settled) return;
    if (captureState.isReleased() && captureState.latestTranscript() !== undefined) {
      finishFromLatestTranscript();
      return;
    }
    const detail = diagnostics.trim().split(/\r?\n/u).at(-1);
    finish(
      new Error(
        detail
          ? `Local Whisper stopped before recognizing speech: ${detail}`
          : "Local Whisper stopped before recognizing speech.",
      ),
    );
  });

  if (mode === "one-shot") {
    oneShotTimeoutAbort = new AbortController();
    void Timers.setTimeout(20_000, undefined, { signal: oneShotTimeoutAbort.signal })
      .then(() => finish(new Error("I didn't hear a complete instruction. Try again.")))
      .catch(() => undefined);
  }

  return {
    result,
    release,
    cancel: () => finish(new Error("Voice capture cancelled.")),
  };
}

/**
 * Starts an abortable local Whisper process for a push-to-talk interaction.
 * Completed VAD blocks arrive through `onTranscript` while the key remains
 * held. Calling `release` waits briefly for the last VAD block, then resolves
 * with that latest transcript. Calling `cancel` rejects and stops the process.
 */
export function startWhisperCapture(input: WhisperCaptureInput): WhisperCapture {
  return startWhisperCaptureInternal(input, "held");
}

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

export function speakNativeSpeech(text: string, platform = process.platform): Promise<void> {
  if (platform !== "win32" || text.trim().length === 0) return Promise.resolve();
  return piperSpeechQueue.enqueue(text);
}

/** Stops current Piper playback and discards any stale queued report. */
export function interruptNativeSpeech(): void {
  piperSpeechQueue.interrupt();
}

export function isNativeSpeechActive(): boolean {
  return piperSpeechQueue.isActive();
}

export async function playNativeCue(
  path: string,
  platform = process.platform,
  signal?: AbortSignal,
): Promise<void> {
  if (platform !== "win32") return;
  if (signal?.aborted) return;
  const escapedPath = path.replaceAll("'", "''");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$cue = New-Object System.Media.SoundPlayer '${escapedPath}'; $cue.PlaySync()`,
      ],
      { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] },
    );
    let settled = false;
    const timeoutAbort = new AbortController();
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      timeoutAbort.abort();
      signal?.removeEventListener("abort", onAbort);
      if (error !== undefined) {
        if (!child.killed) child.kill();
        reject(error);
        return;
      }
      resolve();
    };
    const onAbort = () => {
      if (!child.killed) child.kill();
      finish();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    void Timers.setTimeout(nativeAudioPlaybackTimeoutMs, undefined, {
      signal: timeoutAbort.signal,
    })
      .then(() => finish(new Error("Jarvis voice playback took too long.")))
      .catch(() => undefined);
    child.once("error", (error) => finish(error));
    child.once("exit", (code, exitSignal) => {
      if (signal?.aborted) {
        finish();
        return;
      }
      if (code === 0) {
        finish();
        return;
      }
      finish(
        new Error(
          exitSignal === null
            ? `Jarvis voice playback stopped (exit ${code ?? "unknown"}).`
            : `Jarvis voice playback stopped (${exitSignal}).`,
        ),
      );
    });
  });
}

export const nativeAudioPlaybackTimeoutMs = 120_000;
export const nativeSpeechSynthesisTimeoutMs = 120_000;

export async function recognizeWithWhisper(input: WhisperCaptureInput): Promise<string> {
  return await startWhisperCaptureInternal(input, "one-shot").result;
}
