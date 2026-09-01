import { useAtomSet, useAtomValue } from "@effect/atom-react";
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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type {
  JarvisMeshCatalog,
  JarvisMeshProject,
  JarvisMeshNode,
} from "@t3tools/jarvis-client-runtime/jarvis/mesh";
import type {
  EnvironmentId,
  JarvisPresentationEvent,
  JarvisTaskDeskView,
} from "@t3tools/contracts";

import { AppText as Text } from "../../components/AppText";
import { ControlPill } from "../../components/ControlPill";
import { uuidv4 } from "../../lib/uuid";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { jarvisEnvironment } from "../../state/jarvis";
import { jarvisMeshEnvironment } from "../../state/jarvisMesh";
import { useAtomCommand as useMobileAtomCommand } from "../../state/use-atom-command";
import { selectVoiceNode } from "./voiceNodeSelection";
import { base64ToBytes, buildMobilePcmUtterance } from "./mobileVoiceAudio";
import { useNavigation } from "@react-navigation/native";

type VoicePhase =
  | "idle"
  | "preparing"
  | "recording"
  | "transcribing"
  | "thinking"
  | "executing"
  | "speaking";

type PresentationSubscription = {
  readonly environmentId: EnvironmentId;
  readonly originInteractionId: string;
  readonly speak: boolean;
};

type VoiceCaptureSession = {
  readonly project: JarvisMeshProject;
  readonly voiceNodeId: EnvironmentId;
  readonly originInteractionId: string;
};

const projectKey = (project: JarvisMeshProject): string =>
  `${project.ref.nodeId}:${project.ref.projectId}`;

function commandError(result: { readonly _tag: string; readonly cause?: unknown }): string {
  if (result._tag !== "Failure") return "";
  const cause = result.cause;
  return cause instanceof Error ? cause.message : "The Jarvis request failed.";
}

function hasVoiceCompute(node: JarvisMeshNode): boolean {
  const capabilities = node.capabilities;
  return (
    capabilities !== undefined &&
    "voiceCompute" in capabilities &&
    capabilities.voiceCompute === true
  );
}

export function JarvisRouteScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const refreshMesh = useMobileAtomCommand(jarvisMeshEnvironment.refresh, {
    reportFailure: false,
    reportDefect: false,
  });
  const execute = useMobileAtomCommand(jarvisMeshEnvironment.execute, {
    reportFailure: false,
    reportDefect: false,
  });
  const getTaskDesk = useMobileAtomCommand(jarvisMeshEnvironment.getTaskDesk, {
    reportFailure: false,
    reportDefect: false,
  });
  const focusTask = useMobileAtomCommand(jarvisMeshEnvironment.focusTask, {
    reportFailure: false,
    reportDefect: false,
  });
  const transcribeVoice = useMobileAtomCommand(jarvisMeshEnvironment.transcribeVoice, {
    reportFailure: false,
    reportDefect: false,
  });
  const synthesizeVoice = useMobileAtomCommand(jarvisMeshEnvironment.synthesizeVoice, {
    reportFailure: false,
    reportDefect: false,
  });
  const [preparedOriginInteractionId, setPreparedOriginInteractionId] = useState(
    `mobile-jarvis-${uuidv4()}`,
  );
  const [activePresentationSubscriptions, setActivePresentationSubscriptions] = useState<
    PresentationSubscription[]
  >([]);
  const voiceOrigins = useRef(new Set<string>());
  const [catalog, setCatalog] = useState<JarvisMeshCatalog | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<EnvironmentId | null>(null);
  const selectedNodeIdRef = useRef<EnvironmentId | null>(null);
  const deskRequestGeneration = useRef(0);
  const [selectedProjectKey, setSelectedProjectKey] = useState<string | null>(null);
  const [desk, setDesk] = useState<JarvisTaskDeskView | null>(null);
  const [utterance, setUtterance] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [voicePhase, setVoicePhase] = useState<VoicePhase>("idle");
  const captureBuffers = useRef<AudioStreamBuffer[]>([]);
  const captureActive = useRef(false);
  const captureSession = useRef<VoiceCaptureSession | null>(null);
  const pushToTalkHeld = useRef(false);
  const captureDeadline = useRef<ReturnType<typeof setTimeout> | null>(null);
  const player = useAudioPlayer(null);
  const playerStatus = useAudioPlayerStatus(player);
  const playbackFile = useRef<File | null>(null);
  const { stream } = useAudioStream({
    sampleRate: 16_000,
    channels: 1,
    encoding: "int16",
    onBuffer: (buffer) => {
      if (!captureActive.current) return;
      captureBuffers.current.push({ ...buffer, data: buffer.data.slice(0) });
    },
  });

  useEffect(() => {
    if (!playerStatus.didJustFinish) return;
    setVoicePhase((phase) => (phase === "speaking" ? "idle" : phase));
  }, [playerStatus.didJustFinish]);

  useEffect(
    () => () => {
      if (captureDeadline.current !== null) clearTimeout(captureDeadline.current);
      stream.stop();
      const file = playbackFile.current;
      if (file?.exists) file.delete();
    },
    [stream],
  );

  const refresh = useCallback(async () => {
    setRefreshing(true);
    const result = await refreshMesh(undefined);
    if (result._tag === "Success") {
      setCatalog(result.value);
      setMessage(null);
    } else {
      setMessage(commandError(result));
    }
    setRefreshing(false);
  }, [refreshMesh]);

  const selectNodeId = useCallback((nodeId: EnvironmentId | null) => {
    selectedNodeIdRef.current = nodeId;
    setSelectedNodeId(nodeId);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (catalog === null) return;
    const node = catalog.nodes.find((candidate) => candidate.nodeId === selectedNodeId);
    if (node === undefined) selectNodeId(catalog.nodes[0]?.nodeId ?? null);
    const project = catalog.projects.find(
      (candidate) => projectKey(candidate) === selectedProjectKey,
    );
    if (project === undefined) setSelectedProjectKey(null);
  }, [catalog, selectNodeId, selectedNodeId, selectedProjectKey]);

  const refreshTaskDesk = useCallback(
    async (nodeId: EnvironmentId) => {
      const requestGeneration = ++deskRequestGeneration.current;
      const result = await getTaskDesk({ nodeId });
      if (
        requestGeneration !== deskRequestGeneration.current ||
        selectedNodeIdRef.current !== nodeId
      ) {
        return;
      }
      if (result._tag === "Success") setDesk(result.value);
      else setMessage(commandError(result));
    },
    [getTaskDesk],
  );

  const focusTaskOnDesk = useCallback(
    async (task: JarvisTaskDeskView["recentTasks"][number]) => {
      const nodeId = task.taskRef.executionNodeId;
      const requestGeneration = ++deskRequestGeneration.current;
      const result = await focusTask({
        nodeId,
        task: { threadId: task.threadId, taskRef: task.taskRef },
      });
      if (
        requestGeneration !== deskRequestGeneration.current ||
        selectedNodeIdRef.current !== nodeId
      ) {
        return;
      }
      if (result._tag === "Success") setDesk(result.value);
      else setMessage(commandError(result));
    },
    [focusTask],
  );

  useEffect(() => {
    if (selectedNodeId === null) {
      deskRequestGeneration.current += 1;
      setDesk(null);
      return;
    }
    void refreshTaskDesk(selectedNodeId);
  }, [refreshTaskDesk, selectedNodeId]);

  const selectedProject = catalog?.projects.find(
    (project) => projectKey(project) === selectedProjectKey,
  );
  const voiceSelection = useMemo(
    () =>
      selectVoiceNode({
        preferredVoiceNodeId: AsyncResult.isSuccess(preferencesResult)
          ? preferencesResult.value.preferredVoiceNodeId
          : undefined,
        nodes:
          catalog?.nodes.map((node) => ({
            nodeId: node.nodeId,
            label: node.label,
            reachability: node.reachability,
            voiceCompute: hasVoiceCompute(node),
          })) ?? [],
      }),
    [catalog?.nodes, preferencesResult],
  );

  const playSpeech = useCallback(
    async (text: string) => {
      if (voiceSelection.status !== "selected") {
        setMessage("The preferred voice node is unavailable. Select an online voice node.");
        setVoicePhase("idle");
        return;
      }
      const result = await synthesizeVoice({
        nodeId: voiceSelection.node.nodeId,
        input: { text },
      });
      if (result._tag !== "Success") {
        setMessage(commandError(result));
        setVoicePhase("idle");
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
        const previous = playbackFile.current;
        if (previous?.exists) previous.delete();
        const file = new File(Paths.cache, `jarvis-speech-${uuidv4()}.wav`);
        file.create({ overwrite: true, intermediates: true });
        file.write(base64ToBytes(result.value.wavBase64));
        playbackFile.current = file;
        setVoicePhase("speaking");
        player.replace({ uri: file.uri });
        player.play();
      } catch (cause) {
        setMessage(cause instanceof Error ? cause.message : "Jarvis speech playback failed.");
        setVoicePhase("idle");
      }
    },
    [player, synthesizeVoice, voiceSelection],
  );

  const runInstruction = useCallback(
    async (
      text: string,
      inputMode: "text" | "voice",
      targetProject = selectedProject,
      originInteractionId = preparedOriginInteractionId,
    ) => {
      if (targetProject === undefined || text.trim() === "") return;
      setSubmitting(true);
      setMessage(null);
      const commandOrigin: PresentationSubscription = {
        environmentId: targetProject.ref.nodeId,
        originInteractionId,
        speak: inputMode === "voice",
      };
      if (commandOrigin.speak) voiceOrigins.current.add(commandOrigin.originInteractionId);
      setActivePresentationSubscriptions((current) => [...current, commandOrigin]);
      setPreparedOriginInteractionId(`mobile-jarvis-${uuidv4()}`);
      if (inputMode === "voice") setVoicePhase("thinking");
      if (inputMode === "voice") setVoicePhase("executing");
      const result = await execute({
        projectRef: targetProject.ref,
        utterance: text.trim(),
        requestMetadata: {
          requestId: uuidv4(),
          origin: { originInteractionId: commandOrigin.originInteractionId },
          ...(inputMode === "voice"
            ? { inputMode: "voice" as const, sourceUtterance: text.trim() }
            : {}),
        },
      });
      if (result._tag === "Success") {
        setMessage(
          result.value.status === "started"
            ? `Started ${result.value.objective}`
            : result.value.status === "needs-input"
              ? result.value.prompt
              : result.value.message,
        );
        if (inputMode === "text") setUtterance("");
        await refreshTaskDesk(targetProject.ref.nodeId);
        if (inputMode === "voice" && result.value.status !== "started") {
          await playSpeech(
            result.value.status === "needs-input" ? result.value.prompt : result.value.message,
          );
        }
        if (result.value.status !== "started") {
          voiceOrigins.current.delete(commandOrigin.originInteractionId);
          setActivePresentationSubscriptions((current) =>
            current.filter(
              (subscription) =>
                subscription.originInteractionId !== commandOrigin.originInteractionId,
            ),
          );
        }
      } else {
        setMessage(commandError(result));
        if (inputMode === "voice") setVoicePhase("idle");
        voiceOrigins.current.delete(commandOrigin.originInteractionId);
        setActivePresentationSubscriptions((current) =>
          current.filter(
            (subscription) =>
              subscription.originInteractionId !== commandOrigin.originInteractionId,
          ),
        );
      }
      setSubmitting(false);
    },
    [execute, playSpeech, preparedOriginInteractionId, refreshTaskDesk, selectedProject],
  );

  const submit = useCallback(async () => {
    await runInstruction(utterance, "text");
  }, [runInstruction, utterance]);

  const finishVoiceCapture = useCallback(async () => {
    if (!captureActive.current) return;
    captureActive.current = false;
    const session = captureSession.current;
    captureSession.current = null;
    if (captureDeadline.current !== null) {
      clearTimeout(captureDeadline.current);
      captureDeadline.current = null;
    }
    try {
      stream.stop();
      if (session === null) {
        setMessage("The voice capture target was lost.");
        setVoicePhase("idle");
        return;
      }
      setVoicePhase("transcribing");
      const input = buildMobilePcmUtterance(captureBuffers.current);
      const result = await transcribeVoice({ nodeId: session.voiceNodeId, input });
      if (result._tag !== "Success") {
        setMessage(commandError(result));
        setVoicePhase("idle");
        return;
      }
      setUtterance(result.value.text);
      setMessage(`Transcript: ${result.value.text}`);
      await runInstruction(
        result.value.text,
        "voice",
        session.project,
        session.originInteractionId,
      );
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "Voice capture failed.");
      setVoicePhase("idle");
    }
  }, [runInstruction, stream, transcribeVoice]);

  const startVoiceCapture = useCallback(async () => {
    if (captureActive.current || selectedProject === undefined) return;
    if (voiceSelection.status !== "selected") {
      setMessage("Select an online preferred voice node before using push-to-talk.");
      return;
    }
    captureSession.current = {
      project: selectedProject,
      voiceNodeId: voiceSelection.node.nodeId,
      originInteractionId: preparedOriginInteractionId,
    };
    setVoicePhase("preparing");
    try {
      const permission = await requestRecordingPermissionsAsync();
      if (!permission.granted) {
        captureSession.current = null;
        setMessage("Microphone permission is required for Jarvis push-to-talk.");
        setVoicePhase("idle");
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
      if (!pushToTalkHeld.current) {
        captureSession.current = null;
        setVoicePhase("idle");
        return;
      }
      captureBuffers.current = [];
      setMessage(null);
      setVoicePhase("recording");
      await stream.start();
      if (!pushToTalkHeld.current) {
        stream.stop();
        captureSession.current = null;
        setVoicePhase("idle");
        return;
      }
      captureActive.current = true;
      captureDeadline.current = setTimeout(() => void finishVoiceCapture(), 15_000);
    } catch (cause) {
      captureActive.current = false;
      captureSession.current = null;
      setVoicePhase("idle");
      setMessage(cause instanceof Error ? cause.message : "Voice capture failed to start.");
    }
  }, [finishVoiceCapture, preparedOriginInteractionId, selectedProject, stream, voiceSelection]);

  const setPreferredVoiceNode = (nodeId: EnvironmentId) => {
    savePreferences({ preferredVoiceNodeId: nodeId });
  };
  const focusedTask = desk?.focusedTask;
  const targetsLocked = submitting || voicePhase !== "idle";
  const presentationSubscriptions: PresentationSubscription[] = [
    ...(selectedProject === undefined
      ? []
      : [
          {
            environmentId: selectedProject.ref.nodeId,
            originInteractionId: preparedOriginInteractionId,
            speak: false,
          },
        ]),
    ...activePresentationSubscriptions,
  ];

  return (
    <View className="flex-1 bg-screen">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{
          gap: 20,
          padding: 20,
          paddingBottom: Math.max(insets.bottom, 18) + 20,
        }}
        showsVerticalScrollIndicator={false}
      >
        <View className="gap-1">
          <Text className="text-3xl font-t3-bold text-foreground">Jarvis</Text>
          <Text className="text-base text-foreground-muted">
            Controller mode. Choose a project, send text, or hold push-to-talk. Voice compute stays
            on your selected node.
          </Text>
        </View>

        <View className="flex-row items-center justify-between">
          <Text className="text-lg font-t3-bold text-foreground">Nodes</Text>
          <ControlPill
            label={refreshing ? "Refreshing" : "Refresh"}
            variant="pill"
            onPress={() => void refresh()}
            disabled={refreshing}
          />
        </View>
        <View className="gap-2">
          {catalog?.nodes.map((node) => (
            <Pressable
              key={node.nodeId}
              accessibilityRole="button"
              onPress={() => selectNodeId(node.nodeId)}
              disabled={targetsLocked}
              className={`rounded-2xl border border-separator bg-card p-4 ${selectedNodeId === node.nodeId ? "border-primary" : ""}`}
            >
              <View className="flex-row items-center justify-between">
                <Text className="text-base font-t3-bold text-foreground">{node.label}</Text>
                <Text className="text-sm text-foreground-muted">
                  {node.reachability === "online" ? "Online" : "Offline"}
                </Text>
              </View>
              <Text className="mt-1 text-sm text-foreground-muted">
                {catalog.projects.filter((project) => project.ref.nodeId === node.nodeId).length}{" "}
                projects
              </Text>
              {hasVoiceCompute(node) ? (
                <ControlPill
                  label={
                    voiceSelection.status === "selected" &&
                    voiceSelection.node.nodeId === node.nodeId
                      ? "Preferred voice node"
                      : "Use for voice"
                  }
                  variant={
                    voiceSelection.status === "selected" &&
                    voiceSelection.node.nodeId === node.nodeId
                      ? "primary"
                      : "pill"
                  }
                  onPress={() => setPreferredVoiceNode(node.nodeId)}
                  disabled={targetsLocked || node.reachability !== "online"}
                  className="mt-3 self-start"
                />
              ) : null}
            </Pressable>
          )) ?? <Text className="text-base text-foreground-muted">No connected nodes yet.</Text>}
        </View>

        <View className="gap-2">
          <Text className="text-lg font-t3-bold text-foreground">Project</Text>
          {catalog?.projects.map((project) => (
            <Pressable
              key={projectKey(project)}
              accessibilityRole="button"
              onPress={() => {
                setSelectedProjectKey(projectKey(project));
                selectNodeId(project.ref.nodeId);
              }}
              disabled={targetsLocked}
              className={`rounded-2xl border border-separator bg-card p-4 ${selectedProjectKey === projectKey(project) ? "border-primary" : ""}`}
            >
              <Text className="text-base font-t3-bold text-foreground">{project.title}</Text>
              <Text className="mt-1 text-sm text-foreground-muted">
                {project.nodeLabel} · {project.workspaceRoot}
              </Text>
            </Pressable>
          )) ?? <Text className="text-base text-foreground-muted">Refresh to load projects.</Text>}
        </View>

        <View className="gap-3">
          <Text className="text-lg font-t3-bold text-foreground">Command</Text>
          <TextInput
            accessibilityLabel="Jarvis command"
            className="min-h-24 rounded-2xl border border-separator bg-card px-4 py-3 text-base text-foreground"
            multiline
            onChangeText={setUtterance}
            placeholder="Ask Jarvis to start or steer work…"
            placeholderTextColor="#8b8b93"
            textAlignVertical="top"
            value={utterance}
          />
          <ControlPill
            label={submitting ? "Sending" : "Send command"}
            variant="primary"
            onPress={() => void submit()}
            disabled={
              submitting ||
              voicePhase !== "idle" ||
              selectedProject === undefined ||
              utterance.trim() === ""
            }
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Hold to talk to Jarvis"
            onPressIn={() => {
              pushToTalkHeld.current = true;
              void startVoiceCapture();
            }}
            onPressOut={() => {
              pushToTalkHeld.current = false;
              void finishVoiceCapture();
            }}
            disabled={
              selectedProject === undefined ||
              voiceSelection.status !== "selected" ||
              (voicePhase !== "idle" && voicePhase !== "recording")
            }
            className={`items-center rounded-full px-5 py-4 ${voicePhase === "recording" ? "bg-destructive" : "bg-primary"}`}
          >
            <Text className="font-t3-bold text-primary-foreground">
              {voicePhase === "idle" ? "Hold to talk" : voicePhase}
            </Text>
          </Pressable>
          {voiceSelection.status === "preferred-unavailable" ? (
            <View className="gap-2 rounded-2xl border border-separator bg-card p-3">
              <Text className="text-sm text-foreground-muted">
                Your preferred voice node is offline. Choose another online node explicitly.
              </Text>
              {voiceSelection.fallbackCandidates.map((candidate) => (
                <ControlPill
                  key={candidate.nodeId}
                  label={`Use ${candidate.label}`}
                  variant="pill"
                  onPress={() => setPreferredVoiceNode(candidate.nodeId)}
                  disabled={targetsLocked}
                />
              ))}
            </View>
          ) : voiceSelection.status === "needs-selection" ? (
            <Text className="text-sm text-foreground-muted">
              Select “Use for voice” on an online voice-capable node.
            </Text>
          ) : voiceSelection.status === "no-voice-node" ? (
            <Text className="text-sm text-foreground-muted">
              No connected node currently advertises voice compute.
            </Text>
          ) : null}
          {message ? <Text className="text-sm text-foreground-muted">{message}</Text> : null}
        </View>

        <View className="gap-3">
          <Text className="text-lg font-t3-bold text-foreground">Task desk</Text>
          {focusedTask ? (
            <TaskDeskCard
              task={focusedTask}
              focused
              onFocus={undefined}
              onOpen={() =>
                navigation.navigate("Thread", {
                  environmentId: focusedTask.taskRef.executionNodeId,
                  threadId: focusedTask.threadId,
                })
              }
            />
          ) : (
            <Text className="text-base text-foreground-muted">
              Select an online node to load its focused task.
            </Text>
          )}
          {desk?.recentTasks.map((task) => (
            <TaskDeskCard
              key={`${task.taskRef.executionNodeId}:${task.threadId}`}
              task={task}
              onFocus={() => void focusTaskOnDesk(task)}
              onOpen={() =>
                navigation.navigate("Thread", {
                  environmentId: task.taskRef.executionNodeId,
                  threadId: task.threadId,
                })
              }
            />
          ))}
        </View>

        {presentationSubscriptions.map((subscription) => (
          <JarvisPresentationListener
            key={subscription.originInteractionId}
            environmentId={subscription.environmentId}
            originInteractionId={subscription.originInteractionId}
            onPresentation={(event) => {
              setMessage(event.text);
              if (selectedNodeId === subscription.environmentId) {
                void refreshTaskDesk(subscription.environmentId);
              }
              if (voiceOrigins.current.has(subscription.originInteractionId)) {
                void playSpeech(event.text);
              }
              if (event.kind === "completed" || event.kind === "failed") {
                voiceOrigins.current.delete(subscription.originInteractionId);
                setActivePresentationSubscriptions((current) =>
                  current.filter(
                    (candidate) =>
                      candidate.originInteractionId !== subscription.originInteractionId,
                  ),
                );
              }
            }}
            onOpen={(event) => {
              const taskRef = event.taskRef;
              navigation.navigate("Thread", {
                environmentId: taskRef?.executionNodeId ?? subscription.environmentId,
                threadId: event.threadId,
              });
            }}
          />
        ))}
      </ScrollView>
    </View>
  );
}

function TaskDeskCard(props: {
  readonly task: NonNullable<JarvisTaskDeskView["focusedTask"]>;
  readonly focused?: boolean;
  readonly onFocus: (() => void) | undefined;
  readonly onOpen: () => void;
}) {
  return (
    <View className="gap-2 rounded-2xl border border-separator bg-card p-4">
      <Pressable accessibilityRole="button" onPress={props.onOpen}>
        <Text className="text-base font-t3-bold text-foreground">{props.task.title}</Text>
        <Text className="mt-1 text-sm text-foreground-muted">
          {props.task.state} · {props.task.objective}
        </Text>
      </Pressable>
      {props.focused ? null : props.onFocus ? (
        <ControlPill label="Focus" variant="pill" onPress={props.onFocus} />
      ) : null}
    </View>
  );
}

function JarvisPresentationListener(props: {
  readonly environmentId: EnvironmentId;
  readonly originInteractionId: string;
  readonly onPresentation: (event: JarvisPresentationEvent) => void;
  readonly onOpen: (event: JarvisPresentationEvent) => void;
}) {
  const result = useAtomValue(
    jarvisEnvironment.presentations({
      environmentId: props.environmentId,
      input: { originInteractionId: props.originInteractionId },
    }),
  );
  const lastPresentationId = useRef<string | null>(null);
  useEffect(() => {
    if (
      !AsyncResult.isSuccess(result) ||
      lastPresentationId.current === result.value.presentationId
    ) {
      return;
    }
    lastPresentationId.current = result.value.presentationId;
    props.onPresentation(result.value);
  }, [props, result]);
  if (!AsyncResult.isSuccess(result)) return null;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => props.onOpen(result.value)}
      className="rounded-2xl border border-primary bg-card p-4"
    >
      <Text className="text-sm font-t3-bold text-primary">{result.value.kind}</Text>
      <Text className="mt-1 text-base font-t3-bold text-foreground">
        {result.value.threadTitle}
      </Text>
      <Text className="mt-1 text-sm text-foreground-muted">{result.value.text}</Text>
    </Pressable>
  );
}
