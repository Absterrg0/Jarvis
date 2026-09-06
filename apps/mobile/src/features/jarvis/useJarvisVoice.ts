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
import type { EnvironmentId } from "@t3tools/contracts";
import type { JarvisMeshNode } from "@t3tools/jarvis-client-runtime/jarvis/mesh";

import { uuidv4 } from "../../lib/uuid";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { jarvisMeshEnvironment } from "../../state/jarvisMesh";
import { useAbortableAtomCommand } from "../../state/use-atom-command";
import { buildMobilePcmUtterance } from "./mobileVoiceAudio";
import { getMobilePcmPlayer } from "./mobilePcmPlayer";
import { createMobileJarvisVoiceTurn, type MobileJarvisDraft } from "./mobileJarvisTurn";
import { mobileVoiceFailureMessage } from "./mobileVoiceFailure";
import {
  resolveMicrophonePermissionAction,
  resolveCaptureReleaseAction,
  shouldAbortCapturePreparation,
  type MobileVoicePhase,
} from "./mobilePushToTalk";

import { selectVoiceNode } from "./voiceNodeSelection";

type SpeechItem = {
  readonly nodeId: EnvironmentId;
  readonly text: string;
};

function hasVoiceCompute(node: JarvisMeshNode): boolean {
  return node.capabilities?.voiceCompute === true;
}

export function useJarvisVoice(input: {
  readonly nodes: ReadonlyArray<JarvisMeshNode>;
  readonly onMessage: (message: string) => void;
  readonly onTranscript: (draft: MobileJarvisDraft, transcript: string) => Promise<void>;
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
  const pushToTalkHeld = useRef(false);
  const speechBusy = useRef(false);
  const speechGeneration = useRef(0);
  const playbackId = useRef<string | null>(null);
  const playbackRequest = useRef<AbortController | null>(null);
  const speechQueue = useRef<SpeechItem[]>([]);
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

  const stopCaptureStream = useCallback(() => {
    try {
      stream.stop();
    } catch {
      // Native stop is best-effort and this state is already cancelled locally.
    }
  }, [stream]);

  const startNextSpeechRef = useRef<() => Promise<void>>(async () => undefined);
  const startNextSpeech = useCallback(async () => {
    if (speechBusy.current || phaseRef.current !== "idle") return;
    const next = speechQueue.current.shift();
    if (next === undefined) return;
    speechBusy.current = true;
    const generation = speechGeneration.current;
    const id = uuidv4();
    const cancellation = new AbortController();
    playbackId.current = id;
    playbackRequest.current = cancellation;
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
      const player = getMobilePcmPlayer();
      await player.begin(id);
      if (generation !== speechGeneration.current) {
        player.stop(id);
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
              await session.write(chunk);
              if (generation === speechGeneration.current && chunk.sequence === 0)
                setPhase("speaking");
            },
          },
          cancellation.signal,
        )
        .finally(() => cancellation.signal.removeEventListener("abort", session.cancel));
      if (generation !== speechGeneration.current) return;
      if (result._tag !== "Success") throw new Error(mobileVoiceFailureMessage(result));
      session.finish();
      await player.end(id);
    } catch (cause) {
      if (generation === speechGeneration.current) {
        onMessageRef.current(cause instanceof Error ? cause.message : "Speech playback failed.");
      }
    } finally {
      try {
        getMobilePcmPlayer().stop(id);
      } catch {
        /* A missing native module owns no audio. */
      }
      if (generation === speechGeneration.current) {
        playbackId.current = null;
        playbackRequest.current = null;
        speechBusy.current = false;
        setPhase("idle");
        void startNextSpeechRef.current();
      }
    }
  }, [setPhase]);
  startNextSpeechRef.current = startNextSpeech;

  const enqueueSpeech = useCallback((text: string, nodeId: EnvironmentId) => {
    if (AppState.currentState !== "active") return;
    // Presentations are already bounded. One stream preserves pauses and avoids
    // a file/player restart between sentences; old queued reports are not replayed.
    let segments: ReadonlyArray<string>;
    try {
      segments = segmentMobilePcmSpeech(text);
    } catch (cause) {
      onMessageRef.current(cause instanceof Error ? cause.message : "Speech is too long.");
      return;
    }
    if (speechQueue.current.length + segments.length > 8) {
      onMessageRef.current("More updates are available in Tasks. The speech queue is full.");
      return;
    }
    speechQueue.current.push(...segments.map((segment) => ({ text: segment, nodeId })));
    void startNextSpeechRef.current();
  }, []);

  const clearCaptureDeadline = useCallback(() => {
    if (captureDeadline.current === null) return;
    clearTimeout(captureDeadline.current);
    captureDeadline.current = null;
  }, []);

  const cancelCapture = useCallback(() => {
    captureGeneration.current += 1;
    transcriptionRequest.current?.abort();
    transcriptionRequest.current = null;
    pushToTalkHeld.current = false;
    captureStarting.current = false;
    captureFinishPending.current = false;
    captureActive.current = false;
    captureTurn.current = null;
    captureBuffers.current = [];
    clearCaptureDeadline();
    stopCaptureStream();
    if (phaseRef.current !== "speaking" && phaseRef.current !== "synthesizing") setPhase("idle");
  }, [clearCaptureDeadline, setPhase, stopCaptureStream]);

  const stopSpeech = useCallback(() => {
    speechGeneration.current += 1;
    playbackRequest.current?.abort();
    playbackRequest.current = null;
    speechQueue.current = [];
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
    cancelCapture();
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
    const generation = captureGeneration.current;
    const turn = captureTurn.current;
    captureActive.current = false;
    captureTurn.current = null;
    clearCaptureDeadline();
    stopCaptureStream();
    if (turn === null) {
      setPhase("idle");
      return;
    }
    try {
      setPhase("transcribing");
      const utterance = buildMobilePcmUtterance(captureBuffers.current);
      captureBuffers.current = [];
      if (!turn.speechEnabled || turn.voiceNodeId === undefined || turn.inputMode !== "voice") {
        throw new Error("The voice capture target was lost.");
      }
      const cancellation = new AbortController();
      transcriptionRequest.current = cancellation;
      const result = await transcribeVoice(
        { nodeId: turn.voiceNodeId, input: utterance },
        cancellation.signal,
      ).finally(() => {
        if (transcriptionRequest.current === cancellation) transcriptionRequest.current = null;
      });
      if (generation !== captureGeneration.current) return;
      if (result._tag !== "Success") {
        onMessageRef.current(mobileVoiceFailureMessage(result));
        setPhase("idle");
        return;
      }
      setPhase("idle");
      await onTranscriptRef.current(turn, result.value.text);
    } catch (cause) {
      if (generation !== captureGeneration.current) return;
      onMessageRef.current(cause instanceof Error ? cause.message : "Voice capture failed.");
      setPhase("idle");
    }
  }, [clearCaptureDeadline, setPhase, stopCaptureStream, transcribeVoice]);

  const startCapture = useCallback(
    async (turnInput: { readonly originInteractionId: string }) => {
      if (
        (phaseRef.current !== "idle" &&
          phaseRef.current !== "speaking" &&
          phaseRef.current !== "synthesizing") ||
        selection.status !== "selected"
      ) {
        return;
      }
      // Barge-in: taking the floor stops whatever Jarvis is saying first.
      if (phaseRef.current === "speaking" || phaseRef.current === "synthesizing") stopSpeech();
      const generation = ++captureGeneration.current;
      pushToTalkHeld.current = true;
      captureStarting.current = true;
      captureFinishPending.current = false;
      captureBuffers.current = [];
      captureTurn.current = createMobileJarvisVoiceTurn({
        ...turnInput,
        voiceNodeId: selection.node.nodeId,
      });
      setPhase("preparing");
      try {
        const currentPermission = await getRecordingPermissionsAsync();
        const permissionAction = resolveMicrophonePermissionAction(currentPermission);
        if (permissionAction === "blocked") {
          onMessageRef.current("Enable microphone access for Jarvis in Android Settings.");
          cancelCapture();
          return;
        }
        if (permissionAction === "request") {
          const permission = await requestRecordingPermissionsAsync();
          if (!permission.granted) {
            onMessageRef.current("Microphone permission is required for Jarvis push-to-talk.");
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
        await stream.start();
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
    [cancelCapture, finishCapture, selection, setPhase, stopSpeech, stream],
  );

  return {
    phase,
    selection,
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
