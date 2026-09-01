import { useCallback, useEffect, useState } from "react";
import { Pressable, ScrollView, TextInput, View } from "react-native";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type {
  EnvironmentId,
  JarvisPresentationEvent,
  JarvisTaskDeskView,
} from "@t3tools/contracts";
import type { JarvisMeshNode } from "@t3tools/jarvis-client-runtime/jarvis/mesh";

import { AppText as Text } from "../../components/AppText";
import { ControlPill } from "../../components/ControlPill";
import { mobileJarvisProjectKey, useJarvisController } from "./JarvisMobileProvider";
import { useJarvisVoice } from "./useJarvisVoice";

function hasVoiceCompute(node: JarvisMeshNode): boolean {
  return node.capabilities?.voiceCompute === true;
}

export function JarvisRouteScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const controller = useJarvisController();
  const catalog = controller.catalog;
  const [utterance, setUtterance] = useState("");
  const voice = useJarvisVoice({
    nodes: catalog?.nodes ?? [],
    onMessage: controller.setMessage,
    onTranscript: async (turn, transcript) => {
      setUtterance(transcript);
      controller.setMessage(`Transcript: ${transcript}`);
      await controller.runInstruction(turn, transcript);
    },
  });

  useFocusEffect(
    useCallback(() => {
      const detachSpeech = controller.attachSpeechSink(voice.enqueueSpeech);
      return () => {
        detachSpeech();
        voice.cancelSurface();
      };
    }, [controller.attachSpeechSink, voice.cancelSurface, voice.enqueueSpeech]),
  );

  useEffect(() => {
    if (controller.catalog === null) void controller.refresh();
  }, [controller.catalog, controller.refresh]);

  useEffect(() => {
    if (controller.selectedProject !== undefined) return;
    voice.cancelSurface();
  }, [controller.selectedProject, voice.cancelSurface]);

  const submit = useCallback(async () => {
    const turn = controller.createTextTurn();
    if (turn === null) return;
    await controller.runInstruction(turn, utterance);
    setUtterance("");
  }, [controller, utterance]);

  const focusedTask = controller.desk?.focusedTask;

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
            Choose where work runs, which task desk to inspect, and which online node handles
            speech.
          </Text>
        </View>

        <View className="flex-row items-center justify-between">
          <Text className="text-lg font-t3-bold text-foreground">Task desk node</Text>
          <ControlPill
            label={controller.refreshing ? "Refreshing" : "Refresh"}
            variant="pill"
            onPress={() => void controller.refresh()}
            disabled={controller.refreshing}
          />
        </View>
        <View className="gap-2">
          {catalog?.nodes.map((node) => (
            <Pressable
              key={node.nodeId}
              accessibilityRole="button"
              onPress={() => controller.selectTaskDeskNode(node.nodeId)}
              className={`rounded-2xl border border-separator bg-card p-4 ${controller.taskDeskNodeId === node.nodeId ? "border-primary" : ""}`}
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
                    voice.selection.status === "selected" &&
                    voice.selection.node.nodeId === node.nodeId
                      ? "Voice node"
                      : "Use for voice"
                  }
                  variant={
                    voice.selection.status === "selected" &&
                    voice.selection.node.nodeId === node.nodeId
                      ? "primary"
                      : "pill"
                  }
                  onPress={() => voice.setPreferredVoiceNode(node.nodeId)}
                  disabled={node.reachability !== "online"}
                  className="mt-3 self-start"
                />
              ) : null}
            </Pressable>
          )) ?? <Text className="text-base text-foreground-muted">No connected nodes yet.</Text>}
        </View>

        <View className="gap-2">
          <Text className="text-lg font-t3-bold text-foreground">Execution project</Text>
          {catalog?.projects.map((project) => (
            <Pressable
              key={mobileJarvisProjectKey(project)}
              accessibilityRole="button"
              onPress={() => controller.selectProject(project)}
              className={`rounded-2xl border border-separator bg-card p-4 ${controller.selectedProjectKey === mobileJarvisProjectKey(project) ? "border-primary" : ""}`}
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
            label={controller.submitting ? "Sending" : "Send command"}
            variant="primary"
            onPress={() => void submit()}
            disabled={
              controller.submitting ||
              controller.selectedProject === undefined ||
              utterance.trim() === ""
            }
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Hold to talk to Jarvis"
            onPressIn={() => {
              const project = controller.selectedProject;
              if (project === undefined) return;
              void voice.startCapture({
                projectRef: project.ref,
                originInteractionId: controller.preparedOriginInteractionId,
              });
            }}
            onPressOut={() => void voice.finishCapture()}
            disabled={
              controller.submitting ||
              controller.selectedProject === undefined ||
              voice.selection.status !== "selected" ||
              (voice.phase !== "idle" && voice.phase !== "recording")
            }
            className={`items-center rounded-full px-5 py-4 ${voice.phase === "recording" ? "bg-destructive" : "bg-primary"}`}
          >
            <Text className="font-t3-bold text-primary-foreground">
              {voice.phase === "idle" ? "Hold to talk" : voice.phase}
            </Text>
          </Pressable>
          <VoiceSelectionMessage
            selection={voice.selection}
            onSelect={voice.setPreferredVoiceNode}
          />
          {controller.message ? (
            <Text className="text-sm text-foreground-muted">{controller.message}</Text>
          ) : null}
        </View>

        <View className="gap-3">
          <Text className="text-lg font-t3-bold text-foreground">Task desk</Text>
          {controller.desk?.pendingInteraction ? (
            <View className="rounded-2xl border border-primary bg-card p-4">
              <Text className="text-sm font-t3-bold text-primary">Needs clarification</Text>
              <Text className="mt-1 text-sm text-foreground-muted">
                Open the focused task to answer from the existing thread screen.
              </Text>
            </View>
          ) : null}
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
              Select an online task desk node to inspect its focused task.
            </Text>
          )}
          {controller.desk?.recentTasks.map((task) => (
            <TaskDeskCard
              key={`${task.taskRef.executionNodeId}:${task.threadId}`}
              task={task}
              onFocus={() => void controller.focusTask(task)}
              onOpen={() =>
                navigation.navigate("Thread", {
                  environmentId: task.taskRef.executionNodeId,
                  threadId: task.threadId,
                })
              }
            />
          ))}
        </View>

        {controller.presentations.map((presentation) => (
          <PresentationCard
            key={presentation.event.presentationId}
            event={presentation.event}
            onOpen={() =>
              navigation.navigate("Thread", {
                environmentId:
                  presentation.event.taskRef?.executionNodeId ?? presentation.executionNodeId,
                threadId: presentation.event.threadId,
              })
            }
          />
        ))}
      </ScrollView>
    </View>
  );
}

function VoiceSelectionMessage(props: {
  readonly selection: ReturnType<typeof useJarvisVoice>["selection"];
  readonly onSelect: (nodeId: EnvironmentId) => void;
}) {
  if (props.selection.status === "preferred-unavailable") {
    return (
      <View className="gap-2 rounded-2xl border border-separator bg-card p-3">
        <Text className="text-sm text-foreground-muted">
          Your preferred voice node is offline. Choose another online node explicitly.
        </Text>
        {props.selection.fallbackCandidates.map((candidate) => (
          <ControlPill
            key={candidate.nodeId}
            label={`Use ${candidate.label}`}
            variant="pill"
            onPress={() => props.onSelect(candidate.nodeId)}
          />
        ))}
      </View>
    );
  }
  if (props.selection.status === "needs-selection") {
    return (
      <Text className="text-sm text-foreground-muted">
        Select “Use for voice” on an online voice-capable node.
      </Text>
    );
  }
  if (props.selection.status === "no-voice-node") {
    return (
      <Text className="text-sm text-foreground-muted">
        No connected node currently advertises voice compute.
      </Text>
    );
  }
  return null;
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
      {props.focused || props.onFocus === undefined ? null : (
        <ControlPill label="Focus" variant="pill" onPress={props.onFocus} />
      )}
    </View>
  );
}

function PresentationCard(props: {
  readonly event: JarvisPresentationEvent;
  readonly onOpen: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={props.onOpen}
      className="rounded-2xl border border-primary bg-card p-4"
    >
      <Text className="text-sm font-t3-bold text-primary">{props.event.kind}</Text>
      <Text className="mt-1 text-base font-t3-bold text-foreground">{props.event.threadTitle}</Text>
      <Text className="mt-1 text-sm text-foreground-muted">{props.event.text}</Text>
    </Pressable>
  );
}
