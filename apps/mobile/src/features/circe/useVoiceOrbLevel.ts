import { useEffect, useState } from "react";
import { AccessibilityInfo } from "react-native";
import { useSharedValue } from "react-native-reanimated";
import { requestRecordingPermissionsAsync, RecordingPresets, useAudioRecorder } from "expo-audio";

import {
  applyNoiseFloor,
  createLevelSmoother,
  responseCurve,
} from "../../components/circe-orb/audioLevel";
import type { CirceOrbState } from "../../components/circe-orb/types";
import { normalizeVoiceInputDecibels } from "../voice-input/voiceInputMetering";

const METERING_INTERVAL_MS = 80;

export type VoiceScreenPhase = CirceOrbState;

/**
 * Live microphone level for the voice orb. Requests permission, records while
 * mounted, and writes smoothed 0..1 levels into a Reanimated shared value so
 * no React render happens per meter sample. Only elapsed seconds and terminal
 * phase changes re-render.
 */
export function useVoiceOrbLevel(active: boolean): {
  readonly level: ReturnType<typeof useSharedValue<number>>;
  readonly phase: VoiceScreenPhase;
  readonly errorMessage: string | null;
  readonly elapsedLabel: string;
} {
  const levelSV = useSharedValue(0);
  const [phase, setPhase] = useState<VoiceScreenPhase>("listening");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const recorder = useAudioRecorder({
    ...RecordingPresets.HIGH_QUALITY,
    isMeteringEnabled: true,
  });

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const smoother = createLevelSmoother();
    const startedAt = Date.now();
    let interval: ReturnType<typeof setInterval> | undefined;

    (async () => {
      const permission = await requestRecordingPermissionsAsync();
      if (cancelled) return;
      if (!permission.granted) {
        setErrorMessage("Microphone access is off. Enable it in Settings to speak to Circe.");
        setPhase("error");
        return;
      }
      try {
        await recorder.prepareToRecordAsync();
        if (cancelled) return;
        recorder.record();
      } catch {
        if (cancelled) return;
        setErrorMessage("Could not start listening. Try again.");
        setPhase("error");
        return;
      }
      interval = setInterval(() => {
        if (cancelled) return;
        const status = recorder.getStatus();
        if (!status.isRecording) return;
        const raw = responseCurve(applyNoiseFloor(normalizeVoiceInputDecibels(status.metering)));
        levelSV.value = smoother.push(raw);
        const elapsed = Math.floor((Date.now() - startedAt) / 1000);
        setElapsedSeconds((previous) => (previous === elapsed ? previous : elapsed));
      }, METERING_INTERVAL_MS);
    })();

    return () => {
      cancelled = true;
      if (interval !== undefined) clearInterval(interval);
      levelSV.value = 0;
      void recorder.stop().catch(() => undefined);
    };
  }, [active, levelSV, recorder]);

  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = String(elapsedSeconds % 60).padStart(2, "0");
  return { level: levelSV, phase, errorMessage, elapsedLabel: `${minutes}:${seconds}` };
}

export function useSystemReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void AccessibilityInfo.isReduceMotionEnabled().then((value) => {
      if (!cancelled) setReduced(value ?? false);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return reduced;
}
