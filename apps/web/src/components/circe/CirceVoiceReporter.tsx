import type { EnvironmentId, CircePresentationEvent } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAtomValue } from "@effect/atom-react";

import { circeReporterIdentity } from "../../circeIdentity";
import { onInterruptCirceReportSpeech, publishCirceSpeechTerminal } from "../../circeBus";
import { areCirceVoiceReportsEnabled, onCircePreferencesChanged } from "../../circePreferences";
import { useEnvironment, useEnvironments } from "../../state/environments";
import { circeEnvironment } from "../../state/circe";
import { useEnvironmentSessionState } from "../../state/session";
import { toastManager } from "../ui/toast";
import {
  canMountCirceVoiceReporter,
  cancelCirceSpeechDelivery,
  createCirceSpeechPlaybackQueue,
  enqueueBrowserSpeech,
  rememberBoundedPresentationId,
  spokenPresentationText,
  type CirceSpeechOutcome,
} from "./CirceVoiceReporter.logic";
import {
  getCirceLiveVoiceEnabled,
  getCirceLiveVoiceSink,
  requestCirceLiveVoiceAnnouncement,
} from "./CirceLiveVoice.bridge";

export function speakPresentation(
  _environmentId: EnvironmentId,
  presentation: CircePresentationEvent,
  deliveryId = presentation.presentationId,
): Promise<CirceSpeechOutcome> {
  const text = spokenPresentationText(presentation);
  // A live conversation owns speech: append the report for the live model to
  // say instead of starting a separate local utterance.
  const liveSink = getCirceLiveVoiceSink();
  if (liveSink !== null) {
    liveSink.speak(text);
    return Promise.resolve({ status: "played" });
  }
  // No session is live. On a node with a live voice key, open a muted
  // announcement session so the finished work still speaks without leaving
  // the voice channel open while the task ran.
  if (getCirceLiveVoiceEnabled()) {
    requestCirceLiveVoiceAnnouncement(text);
    return Promise.resolve({ status: "played" });
  }
  // Ordinary report lane: one shared browser utterance. Reports stay
  // display-first; speech is best-effort and never blocks the task.
  return enqueueBrowserSpeech(text, deliveryId).catch(() => ({
    status: "failed",
    code: "speech-delivery-failed",
  }));
}

function presentationDeliveryFailure(): void {
  const description =
    "Circe could not deliver this update by voice. The result remains in the task.";
  toastManager.add({
    type: "warning",
    title: "Circe voice delivery failed",
    description,
    timeout: 10_000,
  });
}

function EnvironmentVoiceReporter({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const sessionState = useEnvironmentSessionState(environmentId);
  if (!canMountCirceVoiceReporter(sessionState.data)) return null;
  return <MountedEnvironmentVoiceReporter environmentId={environmentId} />;
}

function MountedEnvironmentVoiceReporter({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const environment = useEnvironment(environmentId);
  const identity = useMemo(() => circeReporterIdentity(), []);
  const result = useAtomValue(
    circeEnvironment.presentations({
      environmentId,
      input: { originInteractionId: identity },
    }),
  );
  const active = useRef(true);
  const connected = useRef(environment?.connection.phase === "connected");
  const seen = useRef(new Set<string>());
  const playback = useRef(
    createCirceSpeechPlaybackQueue({
      speak: (presentation) =>
        speakPresentation(environmentId, presentation, presentation.presentationId),
      cancel: (presentation) => cancelCirceSpeechDelivery(presentation.presentationId),
      shouldDeliver: () => active.current && connected.current,
      onTerminal: (notice) => {
        publishCirceSpeechTerminal({
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
      // browser utterance.
      playback.current.clear();
    };
  }, []);

  useEffect(
    () =>
      onInterruptCirceReportSpeech(() => {
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
export function CirceVoiceReporter() {
  const { environments } = useEnvironments();
  const [enabled, setEnabled] = useState(areCirceVoiceReportsEnabled);
  const canSpeak =
    typeof window !== "undefined" &&
    "speechSynthesis" in window &&
    "SpeechSynthesisUtterance" in window;

  useEffect(() => onCircePreferencesChanged(() => setEnabled(areCirceVoiceReportsEnabled())), []);

  if (!enabled || !canSpeak) return null;
  return environments.map((environment) => (
    <EnvironmentVoiceReporter
      key={environment.environmentId}
      environmentId={environment.environmentId}
    />
  ));
}
