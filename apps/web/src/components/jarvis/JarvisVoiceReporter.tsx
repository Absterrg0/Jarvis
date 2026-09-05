import type {
  DesktopJarvisVoiceSpeechOutcome,
  EnvironmentId,
  JarvisPresentationEvent,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAtomValue } from "@effect/atom-react";

import { jarvisReporterIdentity } from "../../jarvisIdentity";
import { areJarvisVoiceReportsEnabled, onJarvisPreferencesChanged } from "../../jarvisPreferences";
import { useEnvironmentConnectionState, useEnvironments } from "../../state/environments";
import { jarvisEnvironment } from "../../state/jarvis";
import { useEnvironmentSessionState } from "../../state/session";
import { toastManager } from "../ui/toast";
import {
  canMountJarvisVoiceReporter,
  cancelJarvisSpeechDelivery,
  createJarvisSpeechPlaybackQueue,
  rememberBoundedPresentationId,
  spokenPresentationText,
} from "./JarvisVoiceReporter.logic";

export function speakPresentation(
  _environmentId: EnvironmentId,
  presentation: JarvisPresentationEvent,
  deliveryId = presentation.presentationId,
): Promise<DesktopJarvisVoiceSpeechOutcome> {
  const text = spokenPresentationText(presentation);
  const speakFallback = (): Promise<DesktopJarvisVoiceSpeechOutcome> => {
    return new Promise((resolve) => {
      if (!("speechSynthesis" in window) || !("SpeechSynthesisUtterance" in window)) {
        resolve({ status: "failed", code: "speech-unavailable" });
        return;
      }
      try {
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.lang = navigator.language || "en-US";
        utterance.rate = 1.03;
        utterance.addEventListener("end", () => resolve({ status: "played" }), { once: true });
        utterance.addEventListener(
          "error",
          () => resolve({ status: "failed", code: "browser-speech-failed" }),
          { once: true },
        );
        window.speechSynthesis.speak(utterance);
      } catch {
        resolve({ status: "failed", code: "browser-speech-failed" });
      }
    });
  };

  try {
    if (window.desktopBridge?.jarvisVoice) {
      return window.desktopBridge.jarvisVoice.speak(text, "report", deliveryId).then(
        (outcome) => outcome,
        () => ({ status: "failed", code: "desktop-speech-failed" }),
      );
    }
    return speakFallback().catch(() => ({ status: "failed", code: "speech-delivery-failed" }));
  } catch {
    return Promise.resolve({ status: "failed", code: "speech-delivery-failed" });
  }
}

function presentationDeliveryFailure(): void {
  const description =
    "Jarvis could not deliver this update by voice. The result remains in the task.";
  toastManager.add({
    type: "warning",
    title: "Jarvis voice delivery failed",
    description,
    timeout: 10_000,
  });
}

function EnvironmentVoiceReporter({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const sessionState = useEnvironmentSessionState(environmentId);
  if (!canMountJarvisVoiceReporter(sessionState.data)) return null;
  return <MountedEnvironmentVoiceReporter environmentId={environmentId} />;
}

function MountedEnvironmentVoiceReporter({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const connection = useEnvironmentConnectionState(environmentId);
  const identity = useMemo(() => jarvisReporterIdentity(), []);
  const result = useAtomValue(
    jarvisEnvironment.presentations({
      environmentId,
      input: { originInteractionId: identity },
    }),
  );
  const active = useRef(true);
  const connected = useRef(connection.data?.phase === "connected");
  const seen = useRef(new Set<string>());
  const playback = useRef(
    createJarvisSpeechPlaybackQueue({
      speak: (presentation) =>
        speakPresentation(environmentId, presentation, presentation.presentationId),
      cancel: (presentation) => cancelJarvisSpeechDelivery(presentation.presentationId),
      shouldDeliver: () => active.current && connected.current,
      onDeliveryFailure: () => {
        if (active.current) presentationDeliveryFailure();
      },
    }),
  );

  connected.current = connection.data?.phase === "connected";

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      // Unmount drops obsolete queued speech and cancels the in-flight
      // utterance on every platform adapter, not just desktop.
      playback.current.clear();
    };
  }, []);

  useEffect(() => {
    if (connection.data?.phase === "connected") return;
    // Disconnect drops obsolete queued speech instead of speaking stale
    // results on reconnect; live state is re-inspected, never replayed.
    playback.current.clear();
  }, [connection.data?.phase]);

  useEffect(() => {
    if (!AsyncResult.isSuccess(result)) return;
    const presentation = result.value;
    if (!rememberBoundedPresentationId(seen.current, presentation.presentationId)) return;
    // Reports are display-only. They never steer command focus: the next
    // command keeps the user's explicit selection or current route.
    playback.current.enqueue(presentation);
  }, [environmentId, result]);

  return null;
}

/** Event-driven voice presentation. It has no replay, polling, election, or durable speech state. */
export function JarvisVoiceReporter() {
  const { environments } = useEnvironments();
  const [enabled, setEnabled] = useState(areJarvisVoiceReportsEnabled);
  const canSpeak =
    typeof window !== "undefined" &&
    (window.desktopBridge?.jarvisVoice !== undefined ||
      ("speechSynthesis" in window && "SpeechSynthesisUtterance" in window));

  useEffect(() => onJarvisPreferencesChanged(() => setEnabled(areJarvisVoiceReportsEnabled())), []);

  if (!enabled || !canSpeak) return null;
  return environments.map((environment) => (
    <EnvironmentVoiceReporter
      key={environment.environmentId}
      environmentId={environment.environmentId}
    />
  ));
}
