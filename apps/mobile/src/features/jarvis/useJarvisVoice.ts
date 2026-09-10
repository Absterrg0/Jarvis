import { createMobilePcmSession, segmentMobilePcmSpeech } from "./mobilePcmSession";
import { AsyncResult } from "effect/unstable/reactivity";
import {
  getRecordingPermissionsAsync,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioStream,
  type AudioStreamBuffer,
} from "expo-audio";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, TurnId } from "@t3tools/contracts";
import {
  VoiceTranscriptionError,
  type PreparedVoiceTranscription,
  type VoiceTranscriber,
} from "@t3tools/client-runtime/voice-input";
import type { JarvisMeshNode } from "@t3tools/jarvis-client-runtime/jarvis/mesh";
import type {
  LocalLiveVoiceRecognizer,
  PreparedLocalLiveVoiceSession,
} from "../../native/voiceTranscription.android";

import { uuidv4 } from "../../lib/uuid";
import {
  getLocalLiveVoiceRecognizer,
  getLocalVoiceTranscriber,
} from "../../native/voiceTranscription";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { jarvisMeshEnvironment } from "../../state/jarvisMesh";
import { useAbortableAtomCommand } from "../../state/use-atom-command";
import { buildMobilePcmUtterance } from "./mobileVoiceAudio";
import {
  deleteLocalAsrFile,
  encodeWavPcm16Mono,
  JARVIS_LOCAL_ASR_SAMPLE_RATE,
  pcmBytesFromCaptureBuffers,
  writeLocalAsrWavFile,
} from "./mobileLocalAsrAudio";
import { getMobilePcmPlayer } from "./mobilePcmPlayer";
import { createMobileJarvisVoiceTurn, type MobileJarvisDraft } from "./mobileJarvisTurn";
import { mobileVoiceFailureMessage } from "./mobileVoiceFailure";
import {
  resolveMicrophonePermissionAction,
  resolveCaptureReleaseAction,
  resolveMobileVoiceCancelMessage,
  shouldAbortCapturePreparation,
  shouldSuppressDuplicateMobileSpeech,
  type MobileVoicePhase,
} from "./mobilePushToTalk";

import { selectVoiceNode } from "./voiceNodeSelection";
import { createMobileSpeechGate, type MobileSpeechRequest } from "./mobileSpeechGate";
import { playMobileVoiceReceipt } from "./mobileVoiceReceipt";

type SpeechItem = {
  readonly nodeId: EnvironmentId;
  readonly text: string;
  readonly speechKey: string;
  readonly threadKey: string;
  readonly turnId?: TurnId;
  readonly requestId?: string;
  readonly originInteractionId?: string;
  readonly terminal?: boolean;
};

function hasVoiceCompute(node: JarvisMeshNode): boolean {
  return node.capabilities?.voiceCompute === true;
}

/**
 * Transcription backend snapshotted at capture start.
 *
 * Local binds the on-device implementation and its resolved locale. Remote
 * binds the exact voice node id. A snapshot never changes mid-operation: a
 * local failure reports locally and never uploads audio, and a disconnected
 * remote node reports the disconnection instead of redirecting to another
 * node or service. TTS availability stays separate in `selection`.
 */
export type JarvisVoiceSttBackend =
  | { readonly kind: "local"; readonly locale: string; readonly live: boolean }
  | { readonly kind: "remote"; readonly nodeId: EnvironmentId };

export type JarvisVoiceSttPreference = "local" | "remote";

function safeGetLocalVoiceTranscriber(): VoiceTranscriber | null {
  try {
    return getLocalVoiceTranscriber();
  } catch {
    return null;
  }
}

function safeGetLocalLiveRecognizer(): LocalLiveVoiceRecognizer | null {
  try {
    return getLocalLiveVoiceRecognizer();
  } catch {
    return null;
  }
}

export function isJarvisLocalAsrAvailable(): boolean {
  return safeGetLocalLiveRecognizer() !== null || safeGetLocalVoiceTranscriber() !== null;
}

export function resolveLocalAsrErrorMessage(error: unknown): string | null {
  if (error instanceof VoiceTranscriptionError && error.code === "cancelled") return null;
  if (error instanceof VoiceTranscriptionError && error.code === "unsupported-locale") {
    return "On-device transcription does not support this device language.";
  }
  if (error instanceof VoiceTranscriptionError && error.code === "unavailable") {
    return "On-device transcription is not available on this device.";
  }
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  return "On-device transcription failed. Your audio stayed on this device.";
}

function resolveSttPreference(input: {
  readonly explicitProp: JarvisVoiceSttPreference | undefined;
  readonly stored: unknown;
}): JarvisVoiceSttPreference {
  if (input.explicitProp === "local" || input.explicitProp === "remote") return input.explicitProp;
  if (input.stored === "local" || input.stored === "remote") return input.stored;
  return "remote";
}

export function useJarvisVoice(input: {
  readonly nodes: ReadonlyArray<JarvisMeshNode>;
  readonly onMessage: (message: string) => void;
  readonly onTranscript: (draft: MobileJarvisDraft, transcript: string) => Promise<void>;
  readonly sttPreference?: JarvisVoiceSttPreference;
}) {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const transcribeVoice = useAbortableAtomCommand(jarvisMeshEnvironment.transcribeVoice, {
    reportFailure: false,
    reportDefect: false,
  });
  const streamVoice = useAbortableAtomCommand(jarvisMeshEnvironment.streamVoice, {
    reportFailure: false,
    reportDefect: false,
  });
  const [phase, setPhaseState] = useState<MobileVoicePhase>("idle");
  const phaseRef = useRef<MobileVoicePhase>("idle");
  const captureBuffers = useRef<AudioStreamBuffer[]>([]);
  const captureActive = useRef(false);
  const captureStarting = useRef(false);
  const captureFinishPending = useRef(false);
  const captureTurn = useRef<MobileJarvisDraft | null>(null);
  const captureDeadline = useRef<ReturnType<typeof setTimeout> | null>(null);
  const captureGeneration = useRef(0);
  const transcriptionRequest = useRef<AbortController | null>(null);
  const captureBackend = useRef<JarvisVoiceSttBackend | null>(null);
  const localFilePrepared = useRef<PreparedVoiceTranscription | null>(null);
  const localLiveSession = useRef<PreparedLocalLiveVoiceSession | null>(null);
  const localAbort = useRef<AbortController | null>(null);
  const localWavUri = useRef<string | null>(null);
  const localTranscribing = useRef(false);
  const pushToTalkHeld = useRef(false);
  const speechBusy = useRef(false);
  const speechGeneration = useRef(0);
  const playbackId = useRef<string | null>(null);
  const playbackRequest = useRef<AbortController | null>(null);
  const speechQueue = useRef<SpeechItem[]>([]);
  // Single owner of speak/suppress decisions: arrival dedup plus the
  // thread-latest map playback checkpoints consult before going audible.
  const speechGateRef = useRef(createMobileSpeechGate());
  const playingSpeechRef = useRef<SpeechItem | null>(null);
  const onMessageRef = useRef(input.onMessage);
  const onTranscriptRef = useRef(input.onTranscript);
  onMessageRef.current = input.onMessage;
  onTranscriptRef.current = input.onTranscript;

  const streamVoiceRef = useRef(streamVoice);
  streamVoiceRef.current = streamVoice;

  const setPhase = useCallback((next: MobileVoicePhase) => {
    phaseRef.current = next;
    setPhaseState(next);
  }, []);

  const { stream } = useAudioStream({
    sampleRate: 16_000,
    channels: 1,
    encoding: "int16",
    onBuffer: (buffer) => {
      if (!captureActive.current) return;
      captureBuffers.current.push({ ...buffer, data: buffer.data.slice(0) });
    },
  });

  const selection = selectVoiceNode({
    preferredVoiceNodeId: AsyncResult.isSuccess(preferencesResult)
      ? preferencesResult.value.preferredVoiceNodeId
      : undefined,
    nodes: input.nodes.map((node) => ({
      nodeId: node.nodeId,
      label: node.label,
      reachability: node.reachability,
      voiceCompute: hasVoiceCompute(node),
    })),
  });

  // Explicit STT choice. Availability never overrides it: unset defaults to
  // remote, local without an implementation reports locally, remote without a
  // node stays gated. TTS selection above stays independent.
  const sttBackend: JarvisVoiceSttPreference = resolveSttPreference({
    explicitProp: input.sttPreference,
    stored: AsyncResult.isSuccess(preferencesResult)
      ? (preferencesResult.value as { preferredVoiceStt?: unknown }).preferredVoiceStt
      : undefined,
  });

  const setSttBackend = useCallback(
    (backend: JarvisVoiceSttPreference) => savePreferences({ preferredVoiceStt: backend }),
    [savePreferences],
  );

  const stopCaptureStream = useCallback(() => {
    try {
      stream.stop();
    } catch {
      // Native stop is best-effort and this state is already cancelled locally.
    }
  }, [stream]);

  const clearLocalAsrState = useCallback(() => {
    const abort = localAbort.current;
    if (abort !== null) {
      try {
        abort.abort();
      } catch {
        // Abort is best-effort; the error below owns the result.
      }
    }
    if (localTranscribing.current) {
      // Hold the prepared session, temp file, and backend snapshot until the
      // in-flight native transcribe settles. Its finally owns cleanup.
      return;
    }
    if (transcriptionRequest.current !== null && transcriptionRequest.current === abort) {
      transcriptionRequest.current = null;
    }
    localAbort.current = null;
    localFilePrepared.current = null;
    localLiveSession.current = null;
    captureBackend.current = null;
    deleteLocalAsrFile(localWavUri.current);
    localWavUri.current = null;
  }, []);

  // TTS availability (selected voice node) stays independent of the STT
  // backend snapshot. Local STT never implies a speech node and a speech
  // node never implies local transcription.
  let localAsrAvailable = false;
  try {
    localAsrAvailable = isJarvisLocalAsrAvailable();
  } catch {
    localAsrAvailable = false;
  }

  const startNextSpeechRef = useRef<() => Promise<void>>(async () => undefined);
  const startNextSpeech = useCallback(async () => {
    if (speechBusy.current || phaseRef.current !== "idle") return;
    const next = speechQueue.current.shift();
    if (next === undefined) return;
    // Playback checkpoint: a newer input, cancel, or terminal for this turn
    // retires queued audio before any preparation starts.
    if (speechGateRef.current.isStale(next)) {
      void startNextSpeechRef.current();
      return;
    }
    speechBusy.current = true;
    playingSpeechRef.current = next;
    const generation = speechGeneration.current;
    const id = uuidv4();
    const cancellation = new AbortController();
    playbackId.current = id;
    playbackRequest.current = cancellation;
    // A superseded item leaves quietly: the newer speech owns the floor, so
    // no failure toast may blame the cancelled audio.
    // The slot is marked released before the next item starts so the shared
    // finally below does not reset the new item's playback state or start a
    // second item behind it.
    let released = false;
    const settleStale = (): void => {
      released = true;
      playingSpeechRef.current = null;
      playbackId.current = null;
      playbackRequest.current = null;
      speechBusy.current = false;
      setPhase("idle");
      void startNextSpeechRef.current();
    };
    setPhase("synthesizing");
    try {
      await setAudioModeAsync({
        allowsRecording: false,
        playsInSilentMode: true,
        interruptionMode: "doNotMix",
        shouldPlayInBackground: false,
        shouldRouteThroughEarpiece: false,
      });
      if (generation !== speechGeneration.current) return;
      if (speechGateRef.current.isStale(next)) {
        settleStale();
        return;
      }
      const player = getMobilePcmPlayer();
      await player.begin(id);
      if (generation !== speechGeneration.current) {
        player.stop(id);
        return;
      }
      if (speechGateRef.current.isStale(next)) {
        player.stop(id);
        settleStale();
        return;
      }
      const session = createMobilePcmSession({
        write: (chunk) => player.write(id, chunk.sequence, chunk.pcmBase64),
      });
      cancellation.signal.addEventListener("abort", session.cancel, { once: true });
      const result = await streamVoiceRef
        .current(
          {
            nodeId: next.nodeId,
            input: { text: next.text },
            onAudio: async (chunk) => {
              if (cancellation.signal.aborted) throw new Error("Speech was cancelled.");
              // Late synthesis checkpoint: audio that arrives after a newer
              // input, cancel, or terminal for this turn never goes audible.
              if (speechGateRef.current.isStale(next)) throw new Error("Speech was superseded.");
              await session.write(chunk);
              if (generation === speechGeneration.current && chunk.sequence === 0)
                setPhase("speaking");
            },
          },
          cancellation.signal,
        )
        .finally(() => cancellation.signal.removeEventListener("abort", session.cancel));
      if (generation !== speechGeneration.current) return;
      if (speechGateRef.current.isStale(next)) {
        player.stop(id);
        settleStale();
        return;
      }
      if (result._tag !== "Success") throw new Error(mobileVoiceFailureMessage(result));
      session.finish();
      await player.end(id);
    } catch (cause) {
      if (generation === speechGeneration.current && !speechGateRef.current.isStale(next)) {
        onMessageRef.current(cause instanceof Error ? cause.message : "Speech playback failed.");
      }
    } finally {
      try {
        getMobilePcmPlayer().stop(id);
      } catch {
        /* A missing native module owns no audio. */
      }
      // A stale item that already released its slot via settleStale must not
      // touch the next item's playback state or drain the queue a second time.
      if (released) return;
      if (generation === speechGeneration.current) {
        playingSpeechRef.current = null;
        playbackId.current = null;
        playbackRequest.current = null;
        speechBusy.current = false;
        setPhase("idle");
        void startNextSpeechRef.current();
      }
    }
  }, [setPhase]);
  startNextSpeechRef.current = startNextSpeech;

  const enqueueSpeech = useCallback(
    (request: MobileSpeechRequest) => {
      if (AppState.currentState !== "active") return;
      // Disabled voice clients stay idle: with no selected voice node there
      // is no TTS preparation, playback, or network synthesis.
      if (selection.status !== "selected") return;
      // Presentations are already bounded. One stream preserves pauses and avoids
      // a file/player restart between sentences; old queued reports are not replayed.
      let segments: ReadonlyArray<string>;
      try {
        segments = segmentMobilePcmSpeech(request.text);
      } catch (cause) {
        onMessageRef.current(cause instanceof Error ? cause.message : "Speech is too long.");
        return;
      }
      // Completion-before-ack suppression: a segment already queued for the
      // same turn is not spoken twice when its outcome arrives before an
      // earlier ack. Identity is thread plus turn, else the shared request:
      // one origin may repeat across later legitimate turns, so origin never
      // decides. Later legitimate turns stay speakable on the same task even
      // with identical wording. No verb filtering here.
      const fresh = segments.filter(
        (segment) =>
          !shouldSuppressDuplicateMobileSpeech(speechQueue.current, segment, {
            threadKey: request.threadKey,
            ...(request.turnId === undefined ? {} : { turnId: request.turnId }),
            ...(request.requestId === undefined ? {} : { requestId: request.requestId }),
          }),
      );
      if (fresh.length === 0) return;
      // Exact re-delivery (reconnect, completion-before-ack) never re-speaks.
      if (!speechGateRef.current.arrive(request)) return;
      if (speechQueue.current.length + fresh.length > 8) {
        onMessageRef.current("More updates are available in Tasks. The speech queue is full.");
        return;
      }
      speechQueue.current.push(
        ...fresh.map((segment) => ({
          text: segment,
          nodeId: request.nodeId,
          speechKey: request.speechKey,
          threadKey: request.threadKey,
          ...(request.turnId === undefined ? {} : { turnId: request.turnId }),
          ...(request.requestId === undefined ? {} : { requestId: request.requestId }),
          ...(request.originInteractionId === undefined
            ? {}
            : { originInteractionId: request.originInteractionId }),
          ...(request.terminal === undefined ? {} : { terminal: request.terminal }),
        })),
      );
      // A newer input, cancel, or terminal for the playing turn takes the
      // floor immediately: abort its synthesis so late audio never plays.
      const playing = playingSpeechRef.current;
      if (playing !== null && speechGateRef.current.isStale(playing)) {
        playbackRequest.current?.abort();
      }
      void startNextSpeechRef.current();
    },
    [selection.status],
  );

  const clearCaptureDeadline = useCallback(() => {
    if (captureDeadline.current === null) return;
    clearTimeout(captureDeadline.current);
    captureDeadline.current = null;
  }, []);

  const cancelCapture = useCallback(
    (input?: { readonly announce?: boolean }) => {
      const abortedWork =
        captureStarting.current ||
        captureActive.current ||
        captureFinishPending.current ||
        transcriptionRequest.current !== null ||
        captureTurn.current !== null;
      const phase = phaseRef.current;
      captureGeneration.current += 1;
      try {
        transcriptionRequest.current?.abort();
      } catch {
        // Abort is best-effort.
      }
      clearLocalAsrState();
      pushToTalkHeld.current = false;
      captureStarting.current = false;
      captureFinishPending.current = false;
      captureActive.current = false;
      captureTurn.current = null;
      captureBuffers.current = [];
      clearCaptureDeadline();
      stopCaptureStream();
      if (phaseRef.current !== "speaking" && phaseRef.current !== "synthesizing") setPhase("idle");
      // Honest correction race: an explicit cancel of in-flight capture
      // reports the cancel instead of claiming success or going silent.
      // Internal failure paths already messaged, so they stay silent.
      if (input?.announce === true && abortedWork) {
        const message = resolveMobileVoiceCancelMessage(phase);
        if (message !== null) onMessageRef.current(message);
      }
    },
    [clearCaptureDeadline, clearLocalAsrState, setPhase, stopCaptureStream],
  );

  const stopSpeech = useCallback(() => {
    speechGeneration.current += 1;
    playbackRequest.current?.abort();
    playbackRequest.current = null;
    speechQueue.current = [];
    playingSpeechRef.current = null;
    speechGateRef.current.reset();
    speechBusy.current = false;
    const id = playbackId.current;
    playbackId.current = null;
    if (id !== null) {
      try {
        getMobilePcmPlayer().stop(id);
      } catch {
        /* Native startup may have failed. */
      }
    }
    if (phaseRef.current === "speaking" || phaseRef.current === "synthesizing") setPhase("idle");
  }, [setPhase]);

  const cancelSurface = useCallback(() => {
    cancelCapture({ announce: true });
    stopSpeech();
  }, [cancelCapture, stopSpeech]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") cancelSurface();
    });
    return () => subscription.remove();
  }, [cancelSurface]);

  useEffect(() => () => cancelSurface(), [cancelSurface]);

  const finishCapture = useCallback(async () => {
    pushToTalkHeld.current = false;
    const releaseAction = resolveCaptureReleaseAction({
      captureStarting: captureStarting.current,
      captureActive: captureActive.current,
    });
    if (releaseAction === "defer") {
      captureFinishPending.current = true;
      return;
    }
    if (releaseAction === "ignore") return;
    captureFinishPending.current = false;
    // Immediate receipt: local haptic only, before transcription or provider
    // dispatch. Never acceptance. Failures stay silent so the Heard or empty
    // message below still lands even when haptics is unavailable.
    try {
      playMobileVoiceReceipt();
    } catch {
      // A missing haptics module must not block the release.
    }
    const generation = captureGeneration.current;
    const turn = captureTurn.current;
    const backend = captureBackend.current;
    captureActive.current = false;
    captureTurn.current = null;
    clearCaptureDeadline();
    stopCaptureStream();
    if (turn === null) {
      if (!localTranscribing.current) clearLocalAsrState();
      setPhase("idle");
      void startNextSpeechRef.current();
      return;
    }
    // Local snapshot: transcribe on-device, never upload, never fall back.
    if (backend?.kind === "local") {
      const filePrepared = localFilePrepared.current;
      const liveSession = localLiveSession.current;
      const abort = localAbort.current;
      const backendSnapshot = backend;
      try {
        setPhase("transcribing");
        if (!turn.speechEnabled || turn.inputMode !== "voice") {
          throw new Error("The voice capture target was lost.");
        }
        if (!abort) throw new Error("On-device transcription was not prepared.");
        localTranscribing.current = true;
        let transcript: string;
        if (backendSnapshot.live) {
          if (!liveSession) throw new Error("On-device transcription was not prepared.");
          transcript = await liveSession.finish({ signal: abort.signal });
        } else {
          if (!filePrepared) throw new Error("On-device transcription was not prepared.");
          const wavBytes = encodeWavPcm16Mono(
            pcmBytesFromCaptureBuffers(captureBuffers.current),
            JARVIS_LOCAL_ASR_SAMPLE_RATE,
          );
          captureBuffers.current = [];
          const uri = writeLocalAsrWavFile(wavBytes);
          localWavUri.current = uri;
          try {
            transcript = await filePrepared.transcribe(uri, { signal: abort.signal });
          } finally {
            deleteLocalAsrFile(uri);
            if (localWavUri.current === uri) localWavUri.current = null;
          }
        }
        if (generation !== captureGeneration.current) return;
        if (transcript.trim().length === 0) {
          onMessageRef.current("No speech was detected.");
          setPhase("idle");
          void startNextSpeechRef.current();
          return;
        }
        setPhase("idle");
        await onTranscriptRef.current(turn, transcript.trim());
        void startNextSpeechRef.current();
      } catch (cause) {
        if (generation !== captureGeneration.current) return;
        if (cause instanceof VoiceTranscriptionError && cause.code === "cancelled") {
          setPhase("idle");
          void startNextSpeechRef.current();
          return;
        }
        const message = resolveLocalAsrErrorMessage(cause);
        if (message !== null) onMessageRef.current(message);
        setPhase("idle");
        void startNextSpeechRef.current();
      } finally {
        localTranscribing.current = false;
        if (transcriptionRequest.current === abort) transcriptionRequest.current = null;
        if (localAbort.current === abort) localAbort.current = null;
        if (backendSnapshot.live) {
          if (localLiveSession.current === liveSession) localLiveSession.current = null;
        } else if (localFilePrepared.current === filePrepared) {
          localFilePrepared.current = null;
        }
        if (captureBackend.current === backendSnapshot) captureBackend.current = null;
      }
      return;
    }
    try {
      setPhase("transcribing");
      const utterance = buildMobilePcmUtterance(captureBuffers.current);
      captureBuffers.current = [];
      if (!turn.speechEnabled || turn.inputMode !== "voice") {
        throw new Error("The voice capture target was lost.");
      }
      // Remote snapshot: the exact node bound at capture start. A missing or
      // changed node reports the disconnection instead of redirecting audio
      // to another node or service. Local turns without a TTS node never reach
      // this branch because their backend snapshot is local.
      const remoteNodeId = backend?.kind === "remote" ? backend.nodeId : turn.voiceNodeId;
      if (remoteNodeId === undefined || remoteNodeId !== turn.voiceNodeId) {
        throw new Error(
          "The voice node changed while recording. Your audio was not sent elsewhere.",
        );
      }
      const cancellation = new AbortController();
      transcriptionRequest.current = cancellation;
      const result = await transcribeVoice(
        { nodeId: remoteNodeId, input: utterance },
        cancellation.signal,
      ).finally(() => {
        if (transcriptionRequest.current === cancellation) transcriptionRequest.current = null;
      });
      if (generation !== captureGeneration.current) return;
      if (result._tag !== "Success") {
        onMessageRef.current(mobileVoiceFailureMessage(result));
        setPhase("idle");
        void startNextSpeechRef.current();
        return;
      }
      // An empty remote result is a failure, never silence or acceptance:
      // the receipt cue already fired, so report instead of submitting blank.
      if (result.value.text.trim().length === 0) {
        onMessageRef.current("No speech was detected.");
        setPhase("idle");
        void startNextSpeechRef.current();
        return;
      }
      setPhase("idle");
      await onTranscriptRef.current(turn, result.value.text.trim());
      void startNextSpeechRef.current();
    } catch (cause) {
      if (generation !== captureGeneration.current) return;
      onMessageRef.current(cause instanceof Error ? cause.message : "Voice capture failed.");
      setPhase("idle");
      void startNextSpeechRef.current();
    } finally {
      if (generation === captureGeneration.current && !localTranscribing.current) {
        clearLocalAsrState();
      } else if (transcriptionRequest.current !== null && backend?.kind === "remote") {
        // A cancelled remote transcribe already aborted; its finally above
        // clears the exact request. Nothing local to hold here.
      }
    }
  }, [clearCaptureDeadline, clearLocalAsrState, setPhase, stopCaptureStream, transcribeVoice]);

  const startCapture = useCallback(
    async (turnInput: { readonly originInteractionId: string }) => {
      if (
        phaseRef.current !== "idle" &&
        phaseRef.current !== "speaking" &&
        phaseRef.current !== "synthesizing"
      ) {
        return;
      }
      // Remote input still needs a voice node. Local input runs on-device with
      // or without one; TTS stays gated separately on selection.
      if (sttBackend === "remote" && selection.status !== "selected") {
        return;
      }
      // Barge-in: taking the floor stops whatever ARIS is saying first.
      if (phaseRef.current === "speaking" || phaseRef.current === "synthesizing") stopSpeech();
      const generation = ++captureGeneration.current;
      pushToTalkHeld.current = true;
      captureStarting.current = true;
      captureFinishPending.current = false;
      captureBuffers.current = [];
      // A new capture never inherits a held transcribe: the previous
      // generation aborted it and its finally already settled or will settle
      // without touching these overwritten refs.
      localTranscribing.current = false;
      clearLocalAsrState();
      // Snapshot the explicit transcription backend before claiming the mic.
      // Local binds implementation plus locale, remote binds the exact node
      // id. The snapshot never changes mid-operation and availability never
      // overrides the explicit choice.
      const wantsLocal = sttBackend === "local";
      let localLive = false;
      if (wantsLocal) {
        const liveRecognizer = safeGetLocalLiveRecognizer();
        const fileTranscriber = liveRecognizer === null ? safeGetLocalVoiceTranscriber() : null;
        if (liveRecognizer === null && fileTranscriber === null) {
          onMessageRef.current("On-device transcription is not available on this device.");
          setPhase("idle");
          cancelCapture();
          return;
        }
        const abort = new AbortController();
        localAbort.current = abort;
        transcriptionRequest.current = abort;
        try {
          if (liveRecognizer !== null) {
            const session = await liveRecognizer.prepare({ signal: abort.signal });
            if (generation !== captureGeneration.current || !pushToTalkHeld.current) {
              cancelCapture();
              return;
            }
            localLiveSession.current = session;
            localFilePrepared.current = null;
            localLive = true;
            captureBackend.current = { kind: "local", locale: session.locale, live: true };
          } else if (fileTranscriber !== null) {
            const prepared = await fileTranscriber.prepare({ signal: abort.signal });
            if (generation !== captureGeneration.current || !pushToTalkHeld.current) {
              cancelCapture();
              return;
            }
            localFilePrepared.current = prepared;
            localLiveSession.current = null;
            localLive = false;
            captureBackend.current = { kind: "local", locale: prepared.locale, live: false };
          }
        } catch (error) {
          if (generation !== captureGeneration.current) return;
          // No silent fallback: a local failure never uploads audio to the
          // voice node. Fix the device language or pack, then try again.
          if (error instanceof VoiceTranscriptionError && error.code === "cancelled") {
            cancelCapture();
            return;
          }
          const message = resolveLocalAsrErrorMessage(error);
          if (message !== null) onMessageRef.current(message);
          setPhase("idle");
          cancelCapture();
          return;
        } finally {
          const preparedNow = localFilePrepared.current ?? localLiveSession.current;
          if (transcriptionRequest.current === abort && preparedNow === null) {
            transcriptionRequest.current = null;
          }
        }
      } else {
        if (selection.status !== "selected") return;
        captureBackend.current = { kind: "remote", nodeId: selection.node.nodeId };
      }
      // Local turns carry a TTS node only when one is selected. Without a
      // node the transcript still routes through onTranscript; speech stays
      // silent because enqueueSpeech remains gated on selection.
      captureTurn.current =
        captureBackend.current?.kind === "local"
          ? selection.status === "selected"
            ? createMobileJarvisVoiceTurn({
                ...turnInput,
                voiceNodeId: selection.node.nodeId,
              })
            : createMobileJarvisVoiceTurn({ ...turnInput })
          : selection.status === "selected"
            ? createMobileJarvisVoiceTurn({
                ...turnInput,
                voiceNodeId: selection.node.nodeId,
              })
            : null;
      if (captureTurn.current === null) {
        cancelCapture();
        return;
      }
      setPhase("preparing");
      try {
        const currentPermission = await getRecordingPermissionsAsync();
        const permissionAction = resolveMicrophonePermissionAction(currentPermission);
        if (permissionAction === "blocked") {
          onMessageRef.current("Enable microphone access for ARIS in Android Settings.");
          cancelCapture();
          return;
        }
        if (permissionAction === "request") {
          const permission = await requestRecordingPermissionsAsync();
          if (!permission.granted) {
            onMessageRef.current("Microphone permission is required for ARIS push-to-talk.");
            cancelCapture();
            return;
          }
          if (generation !== captureGeneration.current || !pushToTalkHeld.current) {
            cancelCapture();
            return;
          }
          // Permission was granted while the button is still held, so continue
          // into audio setup instead of asking for a second press.
        }
        await setAudioModeAsync({
          allowsRecording: true,
          playsInSilentMode: true,
          interruptionMode: "doNotMix",
          shouldPlayInBackground: false,
          shouldRouteThroughEarpiece: false,
          allowsBackgroundRecording: false,
        });
        if (
          shouldAbortCapturePreparation({
            generationChanged: generation !== captureGeneration.current,
            pushToTalkHeld: pushToTalkHeld.current,
          })
        ) {
          cancelCapture();
          return;
        }
        captureActive.current = false;
        // Live on-device sessions own the mic, so PCM streaming stays off.
        // File-based local transcription shares the PCM capture below.
        if (!localLive) {
          await stream.start();
        }
        captureStarting.current = false;
        if (generation !== captureGeneration.current) {
          cancelCapture();
          return;
        }
        captureActive.current = true;
        if (captureFinishPending.current || !pushToTalkHeld.current) {
          void finishCapture();
          return;
        }
        setPhase("recording");
        // Stop below the fifteen-second transport bound so timer and frame
        // latency cannot push the assembled utterance over the limit.
        captureDeadline.current = setTimeout(() => void finishCapture(), 14_000);
      } catch (cause) {
        if (generation !== captureGeneration.current) return;
        onMessageRef.current(
          cause instanceof Error ? cause.message : "Voice capture failed to start.",
        );
        cancelCapture();
      }
    },
    [cancelCapture, finishCapture, selection, setPhase, stopSpeech, stream, sttBackend],
  );

  return {
    phase,
    selection,
    sttBackend,
    setSttBackend,
    localAsrAvailable,
    ttsAvailable: selection.status === "selected",
    startCapture,
    finishCapture,
    cancelCapture,
    cancelSurface,
    stopSpeech,
    enqueueSpeech,
    setPreferredVoiceNode: (nodeId: EnvironmentId) =>
      savePreferences({ preferredVoiceNodeId: nodeId }),
  };
}
