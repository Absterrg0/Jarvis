import type {
  DesktopJarvisVoiceSpeechOutcome,
  EnvironmentId,
  JarvisPresentationEvent,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAtomValue } from "@effect/atom-react";

import { jarvisReporterIdentity } from "../../jarvisIdentity";
import { onInterruptJarvisReportSpeech, publishJarvisSpeechTerminal } from "../../jarvisBus";
import { areJarvisVoiceReportsEnabled, onJarvisPreferencesChanged } from "../../jarvisPreferences";
import { useEnvironment, useEnvironments } from "../../state/environments";
import { jarvisEnvironment } from "../../state/jarvis";
import { useEnvironmentSessionState } from "../../state/session";
import { toastManager } from "../ui/toast";
import {
  canMountJarvisVoiceReporter,
  cancelJarvisSpeechDelivery,
  createJarvisSpeechPlaybackQueue,
  enqueueBrowserSpeech,
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
    // One shared lane per renderer: per-node queues hold their reports, and
    // this lane holds the single live utterance at the browser singleton.
    // A disconnect drops waiting entries before they reach the speaker.
    return enqueueBrowserSpeech(text, deliveryId);
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
    "ARIS could not deliver this update by voice. The result remains in the task.";
  toastManager.add({
    type: "warning",
    title: "ARIS voice delivery failed",
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
  const environment = useEnvironment(environmentId);
  const identity = useMemo(() => jarvisReporterIdentity(), []);
  const result = useAtomValue(
    jarvisEnvironment.presentations({
      environmentId,
      input: { originInteractionId: identity },
    }),
  );
  const active = useRef(true);
  const connected = useRef(environment?.connection.phase === "connected");
  const seen = useRef(new Set<string>());
  const playback = useRef(
    createJarvisSpeechPlaybackQueue({
      speak: (presentation) =>
        speakPresentation(environmentId, presentation, presentation.presentationId),
      cancel: (presentation) => cancelJarvisSpeechDelivery(presentation.presentationId),
      shouldDeliver: () => active.current && connected.current,
      onTerminal: (notice) => {
        publishJarvisSpeechTerminal({
          threadId: notice.threadId,
          ...(notice.taskRef === undefined ? {} : { taskRef: notice.taskRef }),
          ...(notice.turnId === undefined ? {} : { turnId: notice.turnId }),
          ...(notice.requestId === undefined ? {} : { requestId: notice.requestId }),
        });
      },
      onDeliveryFailure: () => {
        if (active.current) presentationDeliveryFailure();
      },
    }),
  );

  connected.current = environment?.connection.phase === "connected";

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      // Unmount drops obsolete queued speech and cancels the in-flight
      // utterance on every platform adapter, not just desktop.
      playback.current.clear();
    };
  }, []);

  useEffect(
    () =>
      onInterruptJarvisReportSpeech(() => {
        // A new capture or a terminal pre-accept outcome invalidates live
        // reports: drop the queue so a stale completion never speaks over
        // the next acknowledgement.
        playback.current.clear();
      }),
    [],
  );

  useEffect(() => {
    if (environment?.connection.phase === "connected") return;
    // Disconnect drops obsolete queued speech instead of speaking stale
    // results on reconnect; live state is re-inspected, never replayed.
    playback.current.clear();
  }, [environment?.connection.phase]);

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
