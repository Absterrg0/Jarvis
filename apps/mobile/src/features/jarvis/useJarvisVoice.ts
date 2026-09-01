import { AsyncResult } from "effect/unstable/reactivity";
import {
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioPlayer,
  useAudioPlayerStatus,
  useAudioStream,
  type AudioStreamBuffer,
} from "expo-audio";
import { File, Paths } from "expo-file-system";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, JarvisProjectRef } from "@t3tools/contracts";
import type { JarvisMeshNode } from "@t3tools/jarvis-client-runtime/jarvis/mesh";

import { uuidv4 } from "../../lib/uuid";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { jarvisMeshEnvironment } from "../../state/jarvisMesh";
import { useAbortableAtomCommand } from "../../state/use-atom-command";
import { base64ToBytes, buildMobilePcmUtterance } from "./mobileVoiceAudio";
import { createMobileJarvisVoiceTurn, type MobileJarvisTurn } from "./mobileJarvisTurn";
import {
  createMobileSpeechPrefetch,
  type MobileSpeechPrefetch,
  segmentMobileSpeech,
} from "./mobileSpeechQueue";
import { selectVoiceNode } from "./voiceNodeSelection";

export type MobileVoicePhase = "idle" | "preparing" | "recording" | "transcribing" | "speaking";

type SpeechItem = {
  readonly nodeId: EnvironmentId;
  readonly text: string;
};

function hasVoiceCompute(node: JarvisMeshNode): boolean {
  return node.capabilities?.voiceCompute === true;
}

function resultError(result: { readonly _tag: string; readonly cause?: unknown }): string {
  if (result._tag !== "Failure") return "";
  return result.cause instanceof Error ? result.cause.message : "Jarvis voice failed.";
}

export function useJarvisVoice(input: {
  readonly nodes: ReadonlyArray<JarvisMeshNode>;
  readonly onMessage: (message: string) => void;
  readonly onTranscript: (turn: MobileJarvisTurn, transcript: string) => Promise<void>;
}) {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const transcribeVoice = useAbortableAtomCommand(jarvisMeshEnvironment.transcribeVoice, {
    reportFailure: false,
    reportDefect: false,
  });
  const synthesizeVoice = useAbortableAtomCommand(jarvisMeshEnvironment.synthesizeVoice, {
    reportFailure: false,
    reportDefect: false,
  });
  const [phase, setPhaseState] = useState<MobileVoicePhase>("idle");
  const phaseRef = useRef<MobileVoicePhase>("idle");
  const captureBuffers = useRef<AudioStreamBuffer[]>([]);
  const captureActive = useRef(false);
  const captureStarting = useRef(false);
  const captureTurn = useRef<MobileJarvisTurn | null>(null);
  const captureDeadline = useRef<ReturnType<typeof setTimeout> | null>(null);
  const captureGeneration = useRef(0);
  const transcriptionRequest = useRef<AbortController | null>(null);
  const pushToTalkHeld = useRef(false);
  const speechBusy = useRef(false);
  const speechGeneration = useRef(0);
  const playbackFile = useRef<File | null>(null);
  const player = useAudioPlayer(null);
  const playerStatus = useAudioPlayerStatus(player);
  const onMessageRef = useRef(input.onMessage);
  const onTranscriptRef = useRef(input.onTranscript);
  onMessageRef.current = input.onMessage;
  onTranscriptRef.current = input.onTranscript;

  type SpeechSynthesisResult = Awaited<ReturnType<typeof synthesizeVoice>>;
  const synthesizeVoiceRef = useRef(synthesizeVoice);
  synthesizeVoiceRef.current = synthesizeVoice;
  const speechPrefetch = useRef<MobileSpeechPrefetch<SpeechItem, SpeechSynthesisResult> | null>(
    null,
  );
  if (speechPrefetch.current === null) {
    speechPrefetch.current = createMobileSpeechPrefetch({
      synthesize: (item, signal) =>
        synthesizeVoiceRef.current({ nodeId: item.nodeId, input: { text: item.text } }, signal),
    });
  }
  const speechPrefetchController = speechPrefetch.current;
  if (speechPrefetchController === null) {
    throw new Error("Mobile speech prefetch failed to initialize.");
  }

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

  const deletePlaybackFile = useCallback(() => {
    const file = playbackFile.current;
    playbackFile.current = null;
    try {
      if (file?.exists) file.delete();
    } catch {
      // Cache cleanup must not keep the mobile audio owner active.
    }
  }, []);

  const stopCaptureStream = useCallback(() => {
    try {
      stream.stop();
    } catch {
      // Native stop is best-effort and this state is already cancelled locally.
    }
  }, [stream]);

  const startNextSpeechRef = useRef<() => Promise<void>>(async () => undefined);
  const startNextSpeech = useCallback(async () => {
    if (speechBusy.current || (phaseRef.current !== "idle" && phaseRef.current !== "speaking")) {
      return;
    }
    speechBusy.current = true;
    setPhase("speaking");
    const generation = speechGeneration.current;
    let next: Awaited<
      ReturnType<MobileSpeechPrefetch<SpeechItem, SpeechSynthesisResult>["takeNext"]>
    >;
    try {
      next = await speechPrefetchController.takeNext();
    } catch (cause) {
      if (generation !== speechGeneration.current) return;
      speechBusy.current = false;
      onMessageRef.current(cause instanceof Error ? cause.message : "Jarvis voice failed.");
      void startNextSpeechRef.current();
      return;
    }
    if (next === undefined) {
      speechBusy.current = false;
      if (phaseRef.current === "speaking") setPhase("idle");
      return;
    }
    const result = next.audio;
    if (generation !== speechGeneration.current) return;
    if (result._tag !== "Success") {
      speechPrefetchController.playbackFinished();
      speechBusy.current = false;
      onMessageRef.current(resultError(result));
      void startNextSpeechRef.current();
      return;
    }
    try {
      await setAudioModeAsync({
        allowsRecording: false,
        playsInSilentMode: true,
        interruptionMode: "doNotMix",
        shouldPlayInBackground: false,
        shouldRouteThroughEarpiece: false,
      });
      if (generation !== speechGeneration.current) return;
      player.replace(null);
      deletePlaybackFile();
      const file = new File(Paths.cache, `jarvis-speech-${uuidv4()}.wav`);
      file.create({ overwrite: true, intermediates: true });
      file.write(base64ToBytes(result.value.wavBase64));
      playbackFile.current = file;
      player.replace({ uri: file.uri });
      player.play();
      speechPrefetchController.playbackStarted();
    } catch (cause) {
      speechPrefetchController.playbackFinished();
      speechBusy.current = false;
      onMessageRef.current(
        cause instanceof Error ? cause.message : "Jarvis speech playback failed.",
      );
      void startNextSpeechRef.current();
    }
  }, [deletePlaybackFile, player, setPhase, speechPrefetchController]);
  startNextSpeechRef.current = startNextSpeech;

  useEffect(() => {
    if (!playerStatus.didJustFinish || !speechBusy.current) return;
    speechBusy.current = false;
    speechPrefetchController.playbackFinished();
    try {
      player.replace(null);
    } catch {
      // The queue can advance even if the native player already released itself.
    }
    deletePlaybackFile();
    void startNextSpeechRef.current();
  }, [deletePlaybackFile, player, playerStatus.didJustFinish, speechPrefetchController]);

  const enqueueSpeech = useCallback(
    (text: string, nodeId: EnvironmentId) => {
      speechPrefetchController.enqueue(
        segmentMobileSpeech(text).map((segment) => ({ nodeId, text: segment })),
      );
      void startNextSpeechRef.current();
    },
    [speechPrefetchController],
  );

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
    captureActive.current = false;
    captureTurn.current = null;
    captureBuffers.current = [];
    clearCaptureDeadline();
    stopCaptureStream();
    if (phaseRef.current !== "speaking") setPhase("idle");
  }, [clearCaptureDeadline, setPhase, stopCaptureStream]);

  const stopSpeech = useCallback(() => {
    speechGeneration.current += 1;
    speechPrefetchController.cancel();
    speechBusy.current = false;
    try {
      player.pause();
      player.replace(null);
    } catch {
      // Local ownership is released even if the native player is already gone.
    }
    deletePlaybackFile();
    if (phaseRef.current === "speaking") setPhase("idle");
  }, [deletePlaybackFile, player, setPhase, speechPrefetchController]);

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
    if (captureStarting.current || !captureActive.current) return;
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
        onMessageRef.current(resultError(result));
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
    async (turnInput: {
      readonly projectRef: JarvisProjectRef;
      readonly originInteractionId: string;
    }) => {
      if (phaseRef.current !== "idle" || selection.status !== "selected") return;
      const generation = ++captureGeneration.current;
      pushToTalkHeld.current = true;
      captureStarting.current = true;
      captureBuffers.current = [];
      captureTurn.current = createMobileJarvisVoiceTurn({
        ...turnInput,
        voiceNodeId: selection.node.nodeId,
      });
      setPhase("preparing");
      try {
        const permission = await requestRecordingPermissionsAsync();
        if (!permission.granted) {
          onMessageRef.current("Microphone permission is required for Jarvis push-to-talk.");
          cancelCapture();
          return;
        }
        await setAudioModeAsync({
          allowsRecording: true,
          playsInSilentMode: true,
          interruptionMode: "doNotMix",
          shouldPlayInBackground: false,
          shouldRouteThroughEarpiece: false,
          allowsBackgroundRecording: false,
        });
        if (generation !== captureGeneration.current || !pushToTalkHeld.current) {
          cancelCapture();
          return;
        }
        captureActive.current = true;
        setPhase("recording");
        await stream.start();
        captureStarting.current = false;
        if (generation !== captureGeneration.current || !pushToTalkHeld.current) {
          cancelCapture();
          return;
        }
        captureDeadline.current = setTimeout(() => void finishCapture(), 15_000);
      } catch (cause) {
        if (generation !== captureGeneration.current) return;
        onMessageRef.current(
          cause instanceof Error ? cause.message : "Voice capture failed to start.",
        );
        cancelCapture();
      }
    },
    [cancelCapture, finishCapture, selection, setPhase, stream],
  );

  return {
    phase,
    selection,
    startCapture,
    finishCapture,
    cancelSurface,
    enqueueSpeech,
    setPreferredVoiceNode: (nodeId: EnvironmentId) =>
      savePreferences({ preferredVoiceNodeId: nodeId }),
  };
}
