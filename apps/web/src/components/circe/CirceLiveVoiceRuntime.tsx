import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import { usePrimaryCloudLinkState } from "../../cloud/primaryCloudLinkState";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { circeLiveVoiceEnvironment } from "../../state/circeLiveVoice";
import { circeMeshCatalogAtom } from "../../state/circeMesh";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { getCirceTargetSnapshot } from "../../circeBus";
import { toastManager } from "../ui/toast";
import {
  consumeCirceLiveVoiceActivationReason,
  getCirceLiveVoiceEnabled,
  getCirceLiveVoiceSink,
  getCirceLiveVoiceUiState,
  setCirceLiveVoiceActive,
  setCirceLiveVoiceEnabled,
  setCirceLiveVoiceSink,
  setCirceLiveVoiceStatus,
  submitCirceLiveVoiceDelegation,
  subscribeCirceLiveVoice,
  takeCirceLiveVoiceAnnouncements,
} from "./CirceLiveVoice.bridge";
import { buildCirceLiveVoiceContext, createCirceLiveVoiceController } from "./CirceLiveVoice.logic";

function liveVoiceFailureMessage(result: unknown): string {
  const error = squashAtomCommandFailure(result as Parameters<typeof squashAtomCommandFailure>[0]);
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  return "Live voice could not start on this device.";
}

function CirceLiveVoiceEnvironmentRuntime({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const startSession = useAtomCommand(circeLiveVoiceEnvironment.start, {
    reportFailure: false,
    reportDefect: false,
  });
  const releaseSession = useAtomCommand(circeLiveVoiceEnvironment.release, {
    reportFailure: false,
    reportDefect: false,
  });
  const renewSession = useAtomCommand(circeLiveVoiceEnvironment.renew, {
    reportFailure: false,
    reportDefect: false,
  });
  const releaseSessionRef = useRef(releaseSession);
  useEffect(() => {
    releaseSessionRef.current = releaseSession;
  }, [releaseSession]);
  const renewSessionRef = useRef(renewSession);
  useEffect(() => {
    renewSessionRef.current = renewSession;
  }, [renewSession]);
  const closingRef = useRef(Promise.resolve());
  const catalog = useAtomValue(circeMeshCatalogAtom);
  const catalogRef = useRef(catalog);
  useEffect(() => {
    catalogRef.current = catalog;
  }, [catalog]);
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const currentModel = config?.settings.circeDefaultModelSelection?.model;
  const modelRef = useRef(currentModel);
  useEffect(() => {
    modelRef.current = currentModel;
  }, [currentModel]);
  const cloudLink = usePrimaryCloudLinkState();
  const enabled =
    cloudLink.data?.linked === true || (config?.settings.circeLiveVoice.apiKey.length ?? 0) > 0;
  const startSessionRef = useRef(startSession);
  useEffect(() => {
    startSessionRef.current = startSession;
  }, [startSession]);
  const [uiState, setUiState] = useState(getCirceLiveVoiceUiState);
  const active = uiState.active;
  const [level, setLevel] = useState(0);
  const [caption, setCaption] = useState<string | null>(null);

  useEffect(() => subscribeCirceLiveVoice(() => setUiState(getCirceLiveVoiceUiState())), []);

  // The main process cannot read node settings, so the renderer reports the
  // key-configured flag plus the real session state for the tray label and the
  // global-shortcut decision. Level and caption drive the orb.
  useEffect(() => {
    window.desktopBridge?.circeLiveVoice?.report({
      enabled,
      active: uiState.active,
      status: uiState.status,
      ...(uiState.active ? { level: Math.max(0, Math.min(1, level)) } : {}),
      ...(uiState.active && caption !== null ? { caption } : {}),
    });
    setCirceLiveVoiceEnabled(enabled);
  }, [enabled, uiState.active, uiState.status, level, caption]);

  const onFailure = useCallback((message: string) => {
    toastManager.add({
      type: "warning",
      title: "Live voice",
      description: message,
      timeout: 10_000,
    });
  }, []);

  useEffect(() => {
    if (!active) return;
    let disposed = false;
    // Announcement sessions speak a report without listening: silent track,
    // input muted, no microphone prompt.
    const activationReason = consumeCirceLiveVoiceActivationReason();
    const controller = createCirceLiveVoiceController({
      listen: activationReason !== "announcement",
      // Announcement sessions only read a report; keep them short so the
      // voice channel is not billed while nothing is being spoken.
      ...(activationReason === "announcement" ? { idleTimeoutMs: 45_000 } : {}),
      release: async (sessionId) => {
        const result = await releaseSessionRef.current({ environmentId, input: { sessionId } });
        if (result._tag === "Failure") throw new Error(liveVoiceFailureMessage(result));
      },
      renew: async (sessionId) => {
        // Best-effort: a renew failure must not tear down a live conversation.
        // The node closes the session only if renewals stop entirely.
        await renewSessionRef.current({ environmentId, input: { sessionId } });
      },
      start: async ({ sdpOffer, context }) => {
        await closingRef.current;
        if (disposed) throw new Error("Live voice startup was cancelled.");
        const result = await startSessionRef.current({
          environmentId,
          input: { sdpOffer, ...(context === undefined ? {} : { context }) },
        });
        if (result._tag === "Failure") {
          if (isAtomCommandInterrupted(result)) {
            throw new Error("Live voice startup was interrupted.");
          }
          throw new Error(liveVoiceFailureMessage(result));
        }
        return result.value;
      },
      delegate: (utterance, delegationId) =>
        submitCirceLiveVoiceDelegation(utterance, delegationId),
      onStatus: (status) => {
        if (disposed) return;
        setCirceLiveVoiceStatus(status);
        if (status === "failed") setCirceLiveVoiceActive(false);
        if (status !== "live") setLevel(0);
      },
      onAudioLevel: (value) => setLevel(value),
      onTranscript: (state) => {
        const spoken = (state.assistantText || state.userText).trim();
        setCaption(spoken.length === 0 ? null : spoken.slice(-120));
      },
      // Idle, max-duration, and remote closes must release the toggle too, or
      // the button and orb keep claiming a session that is already gone.
      onClosed: () => {
        if (!disposed) setCirceLiveVoiceActive(false);
      },
      onFailure,
      context: () => {
        const current = catalogRef.current;
        if (current === null) return undefined;
        const target = getCirceTargetSnapshot();
        return buildCirceLiveVoiceContext({
          nodeLabels: current.nodes.map((node) => node.label),
          projects: current.projects.map((project) => ({
            title: project.title,
            repositoryNames: project.repositoryNames,
            aliases: project.aliases,
          })),
          providerNames: current.providers.map(
            (provider) => provider.snapshot.displayName ?? provider.snapshot.instanceId,
          ),
          ...(target?.projectTitle === undefined
            ? {}
            : { currentProjectTitle: target.projectTitle }),
          ...(target?.contextThreadTitle === undefined
            ? {}
            : { currentTaskTitle: target.contextThreadTitle }),
          ...(target?.recentTasks === undefined ? {} : { recentTasks: target.recentTasks }),
          ...(modelRef.current === undefined ? {} : { currentModel: modelRef.current }),
          ...(target?.recentTasks === undefined
            ? {}
            : {
                runningTaskCount: target.recentTasks.filter(
                  (task) => task.state === "running" || task.state === "input",
                ).length,
              }),
        });
      },
    });
    setCirceLiveVoiceSink({ speak: controller.speak, note: controller.note });
    // Reports that arrived before this session connected speak as soon as it
    // goes live; the controller queues them.
    for (const announcement of takeCirceLiveVoiceAnnouncements()) {
      controller.speak(announcement);
    }
    void controller.start();
    return () => {
      disposed = true;
      // Drop the sink first so late reports fall back to the ordinary lane
      // while the session closes.
      if (getCirceLiveVoiceSink()?.speak === controller.speak) {
        setCirceLiveVoiceSink(null);
      }
      closingRef.current = controller.close();
    };
  }, [active, environmentId, onFailure]);

  return null;
}

/**
 * Owns at most one full-duplex GPT-Live conversation. The session is off
 * unless the user turns it on, so a disabled client holds no microphone and
 * opens no socket.
 */
export function CirceLiveVoiceRuntime() {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  // The desktop hotkey arrives on its own channel so it is never held behind
  // the generic menu-action readiness handshake.
  useEffect(
    () =>
      window.desktopBridge?.circeLiveVoice?.onToggle(() => {
        if (!getCirceLiveVoiceEnabled() && !getCirceLiveVoiceUiState().active) {
          // The shortcut works; the session cannot start without a key. Say so
          // instead of leaving the press with no visible effect.
          toastManager.add({
            type: "warning",
            title: "Live voice is not configured",
            description:
              "Link this node to Circe Mesh or add an OpenAI live voice key in its agent settings, then try again.",
            timeout: 12_000,
          });
          return;
        }
        setCirceLiveVoiceActive(!getCirceLiveVoiceUiState().active);
      }),
    [],
  );
  if (primaryEnvironmentId === null) return null;
  return <CirceLiveVoiceEnvironmentRuntime environmentId={primaryEnvironmentId} />;
}
