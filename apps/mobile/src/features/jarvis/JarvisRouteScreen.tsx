import { useCallback, useEffect, useMemo, useState } from "react";
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  TextInput,
  View,
} from "react-native";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { JarvisPresentationEvent, JarvisTaskDeskView } from "@t3tools/contracts";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { ControlPill } from "../../components/ControlPill";
import { useThemeColor } from "../../lib/useThemeColor";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { JarvisNavigation } from "./JarvisNavigation";
import { useJarvisController } from "./JarvisMobileProvider";
import { isPushToTalkDisabled, type MobileVoicePhase } from "./mobilePushToTalk";
import { selectCurrentPresentations } from "./mobilePresentations";
import { useJarvisVoice } from "./useJarvisVoice";
import { describeJarvisRouteNodeIssues } from "./mobileNodeReadiness";

const PHASE_COPY: Record<MobileVoicePhase, { readonly title: string; readonly detail: string }> = {
  idle: { title: "Hold to talk", detail: "Release to send" },
  preparing: { title: "Starting microphone", detail: "Keep holding" },
  recording: { title: "I’m listening", detail: "Release when you’re finished" },
  transcribing: { title: "Working it out", detail: "Understanding your request" },
  synthesizing: { title: "Preparing speech", detail: "Waiting for audio from your computer" },
  speaking: { title: "Here’s what I found", detail: "Your work keeps running in the background" },
};

export function JarvisRouteScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const controller = useJarvisController();
  const catalog = controller.catalog;
  const [utterance, setUtterance] = useState("");
  const [showDetails, setShowDetails] = useState(false);
  const [choosingProject, setChoosingProject] = useState(false);
  const dangerForeground = useThemeColor("--color-danger-foreground");
  const mutedForeground = useThemeColor("--color-foreground-muted");
  const iconForeground = useThemeColor("--color-icon");
  const voice = useJarvisVoice({
    nodes: catalog?.nodes ?? [],
    onMessage: controller.setMessage,
    onTranscript: async (turn, transcript) => {
      setUtterance(transcript);
      controller.setMessage(`Heard: “${transcript}”`);
      await controller.runInstruction(turn, transcript);
      setUtterance("");
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

  const submit = useCallback(async () => {
    // Sending takes the floor: stop any playback before the new turn runs.
    voice.stopSpeech();
    const turn = controller.createTextTurn();
    await controller.runInstruction(turn, utterance);
    setUtterance("");
  }, [controller, utterance, voice.stopSpeech]);

  const projects = catalog?.projects ?? [];
  const hasOnlineNode = (catalog?.nodes ?? []).some((node) => node.reachability === "online");
  const phaseCopy =
    projects.length === 0 && !hasOnlineNode
      ? { title: "Connect your desktop", detail: "Jarvis needs a connected computer to work" }
      : voice.selection.status === "no-voice-node"
        ? { title: "Voice is unavailable", detail: "Your connected desktop is not offering speech" }
        : PHASE_COPY[voice.phase];
  const pushToTalkDisabled = isPushToTalkDisabled({
    submitting: controller.submitting,
    hasProject: projects.length > 0,
    hasVoiceNode: voice.selection.status === "selected",
    hasOnlineNode,
    phase: voice.phase,
  });
  const focusedTask = controller.desk?.focusedTask;
  const recentTasks = useMemo(
    () =>
      (controller.desk?.recentTasks ?? [])
        .filter(
          (task) =>
            task.threadId !== focusedTask?.threadId ||
            task.taskRef.executionNodeId !== focusedTask.taskRef.executionNodeId,
        )
        .slice(0, 4),
    [controller.desk?.recentTasks, focusedTask],
  );
  // One current presentation per thread: terminal outcomes supersede
  // their thread's earlier blockers instead of stacking beside them.
  const visiblePresentations = useMemo(
    () => selectCurrentPresentations(controller.presentations, 8),
    [controller.presentations],
  );
  const nodeIssues = useMemo(() => describeJarvisRouteNodeIssues(catalog), [catalog]);
  const openConnections = useCallback(() => {
    navigation.navigate("Connections");
  }, [navigation]);
  const retryRefresh = useCallback(() => {
    void controller.refresh();
  }, [controller]);
  return (
    <KeyboardAvoidingView
      className="flex-1 bg-screen"
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={100}
    >
      <NativeStackScreenOptions
        options={{
          headerBackVisible: false,
          title: "Jarvis",
          headerRight: JarvisSettingsButton,
        }}
      />

      <Modal
        visible={choosingProject}
        animationType="slide"
        onRequestClose={() => setChoosingProject(false)}
      >
        <View
          className="flex-1 bg-screen"
          style={{ paddingTop: insets.top + 16, paddingBottom: insets.bottom }}
        >
          <View className="flex-row items-center justify-between px-5 pb-4">
            <Text className="text-xl font-t3-bold text-foreground">Working project</Text>
            <ControlPill label="Done" onPress={() => setChoosingProject(false)} />
          </View>
          <ScrollView contentContainerStyle={{ padding: 20, gap: 12 }}>
            {projects.length === 0 ? (
              <Text className="text-foreground-muted">
                Connect a computer with a project to get started.
              </Text>
            ) : (
              projects.map((project) => (
                <Pressable
                  key={`${project.ref.nodeId}:${project.ref.projectId}`}
                  accessibilityRole="button"
                  accessibilityState={{
                    selected:
                      controller.selectedProject?.ref.nodeId === project.ref.nodeId &&
                      controller.selectedProject?.ref.projectId === project.ref.projectId,
                  }}
                  onPress={() => {
                    controller.selectProject(project);
                    setChoosingProject(false);
                  }}
                  className="gap-1 rounded-2xl border border-border-subtle bg-card p-4 active:opacity-70"
                >
                  <Text className="text-base font-t3-bold text-foreground">{project.title}</Text>
                  <Text className="text-sm text-foreground-muted">{project.nodeLabel}</Text>
                </Pressable>
              ))
            )}
          </ScrollView>
        </View>
      </Modal>

      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{
          gap: 16,
          paddingHorizontal: 20,
          paddingTop: 10,
          paddingBottom: Math.max(insets.bottom, 18) + 28,
        }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        showsVerticalScrollIndicator={false}
      >
        <JarvisNavigation selected="assistant" />

        <View className="gap-3 rounded-2xl border border-border-subtle bg-card p-4">
          <View className="flex-row items-center justify-between gap-3">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Choose working project"
              onPress={() => setChoosingProject(true)}
              className="min-w-0 flex-1 gap-1"
            >
              <Text className="text-xs text-foreground-muted">WORKING IN · CHANGE</Text>
              <Text numberOfLines={1} className="text-base font-t3-bold text-foreground">
                {controller.selectedProject?.title ?? "Choose a project"}
              </Text>
              {controller.selectedProject ? (
                <Text numberOfLines={1} className="text-xs text-foreground-muted">
                  {controller.selectedProject.nodeLabel}
                </Text>
              ) : null}
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Open connections"
              onPress={openConnections}
              className="min-h-11 justify-center px-2"
            >
              <Text className="text-xs text-foreground-muted">
                {hasOnlineNode ? "Connected" : "Offline"}
              </Text>
            </Pressable>
          </View>
          <TextInput
            accessibilityLabel="Jarvis command"
            className="max-h-36 min-h-20 text-base text-foreground"
            multiline
            onChangeText={setUtterance}
            placeholder="What would you like to do?"
            placeholderTextColor={mutedForeground}
            textAlignVertical="top"
            value={utterance}
          />
          <View className="flex-row items-center justify-between gap-3">
            {voice.phase === "speaking" || voice.phase === "synthesizing" ? (
              <ControlPill label="Stop speaking" icon="stop.fill" onPress={voice.stopSpeech} />
            ) : (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Hold to talk to Jarvis"
                accessibilityHint="Keep holding while you speak, then release to send"
                accessibilityState={{ disabled: pushToTalkDisabled }}
                onPressIn={() =>
                  void voice.startCapture({
                    originInteractionId: controller.preparedOriginInteractionId,
                  })
                }
                onPressOut={() => void voice.finishCapture()}
                disabled={pushToTalkDisabled}
                className={`min-h-12 flex-row items-center gap-2 rounded-xl px-3 ${voice.phase === "recording" ? "bg-danger" : "bg-subtle"}`}
              >
                <SymbolView
                  name="mic.fill"
                  size={20}
                  tintColor={voice.phase === "recording" ? dangerForeground : iconForeground}
                />
                <Text className="text-sm font-t3-bold text-foreground">{phaseCopy.title}</Text>
              </Pressable>
            )}
            <ControlPill
              accessibilityLabel="Send Jarvis command"
              icon="arrow.up"
              variant="primary"
              onPress={() => void submit()}
              disabled={controller.submitting || utterance.trim() === ""}
            />
          </View>
          {voice.phase !== "idle" ? (
            <Text accessibilityLiveRegion="polite" className="text-xs text-foreground-muted">
              {phaseCopy.detail}
            </Text>
          ) : null}
        </View>

        {controller.unavailableProjectKey !== null ? (
          <View className="gap-3 rounded-2xl border border-danger bg-card p-5">
            <Text className="text-base font-t3-bold text-foreground">
              Selected project unavailable
            </Text>
            <Text className="text-sm leading-relaxed text-foreground-muted">
              {controller.unavailableProjectKey} is not in the current catalog. New instructions
              wait instead of borrowing a different target.
            </Text>
            {projects.length > 0 ? (
              <View className="gap-2">
                {projects.map((project) => (
                  <Pressable
                    key={`${project.ref.nodeId}:${project.ref.projectId}`}
                    accessibilityRole="button"
                    accessibilityLabel={`Select ${project.title}`}
                    onPress={() => controller.selectProject(project)}
                    className="rounded-xl border border-border-subtle bg-subtle px-4 py-3 active:opacity-70"
                  >
                    <Text className="text-sm font-t3-bold text-foreground">
                      {project.title} — {project.nodeLabel}
                    </Text>
                  </Pressable>
                ))}
              </View>
            ) : null}
            <View className="flex-row">
              <ControlPill
                label={controller.refreshing ? "Retrying…" : "Retry connection"}
                variant="primary"
                onPress={retryRefresh}
                disabled={controller.refreshing}
              />
            </View>
          </View>
        ) : null}

        {projects.length === 0 && !hasOnlineNode ? (
          <View className="gap-3 rounded-2xl border border-border-subtle bg-card p-5">
            <Text className="text-base font-t3-bold text-foreground">Bring Jarvis online</Text>
            <Text className="text-sm leading-relaxed text-foreground-muted">
              Connect this phone to a Jarvis desktop, then speak or type from anywhere.
            </Text>
            <ControlPill
              label="Connect Jarvis"
              variant="primary"
              onPress={() =>
                navigation.navigate("SettingsSheet", {
                  screen: "SettingsContent",
                  params: { screen: "SettingsEnvironmentNew" },
                })
              }
            />
          </View>
        ) : voice.selection.status === "no-voice-node" ? (
          <Text className="text-center text-sm text-foreground-muted">
            No connected Jarvis desktop currently offers voice.
          </Text>
        ) : null}

        {nodeIssues.length > 0 ? (
          <View className="gap-3">
            <SectionHeader title="Node status" />
            {nodeIssues.map((issue) => (
              <View
                key={String(issue.nodeId)}
                className="gap-2 rounded-2xl border border-border-subtle bg-card p-5"
              >
                <Text className="text-base font-t3-bold text-foreground">{issue.label}</Text>
                {issue.loading ? (
                  <Text className="text-sm leading-relaxed text-foreground-muted">
                    Loading projects and providers…
                  </Text>
                ) : (
                  <Text className="text-sm leading-relaxed text-foreground-muted">
                    {issue.message}
                  </Text>
                )}
                {!issue.loading && issue.recovery !== null ? (
                  <View className="flex-row">
                    {issue.recovery === "retry" || issue.recovery === "update" ? (
                      <ControlPill
                        label={controller.refreshing ? "Retrying…" : "Retry"}
                        variant="primary"
                        onPress={retryRefresh}
                        disabled={controller.refreshing}
                      />
                    ) : (
                      <ControlPill
                        label="Open Connections"
                        variant="primary"
                        onPress={openConnections}
                      />
                    )}
                  </View>
                ) : null}
              </View>
            ))}
          </View>
        ) : null}

        {controller.message ? (
          <View className="flex-row gap-3 rounded-2xl bg-subtle px-4 py-4">
            <View className="mt-0.5 h-7 w-7 items-center justify-center rounded-full bg-card">
              <SymbolView name="bolt.circle" size={15} tintColor={iconForeground} />
            </View>
            <Text className="min-w-0 flex-1 text-sm leading-relaxed text-foreground">
              {controller.message}
            </Text>
          </View>
        ) : null}

        <View className="gap-3">
          <SectionHeader
            title="Current task"
            actionLabel="Refresh"
            onAction={() => void controller.refresh()}
          />
          {controller.desk?.pendingInteraction && focusedTask ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                navigation.navigate("Thread", {
                  environmentId: focusedTask.taskRef.executionNodeId,
                  threadId: focusedTask.threadId,
                });
              }}
              className="rounded-2xl border border-primary bg-card p-4 active:opacity-70"
            >
              <Text className="text-sm font-t3-bold text-primary">Jarvis needs your answer</Text>
              <Text className="mt-1 text-sm leading-relaxed text-foreground-muted">
                Open the current task to keep things moving.
              </Text>
            </Pressable>
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
            <Pressable
              accessibilityRole="button"
              onPress={() => navigation.navigate("NewTaskSheet", { screen: "NewTask" })}
              className="flex-row items-center justify-between rounded-2xl border border-border-subtle bg-card p-5 active:opacity-70"
            >
              <View className="min-w-0 flex-1 gap-1">
                <Text className="text-base font-t3-bold text-foreground">Nothing active yet</Text>
                <Text className="text-sm leading-relaxed text-foreground-muted">
                  Ask Jarvis for something, or start a task in the workspace.
                </Text>
              </View>
              <SymbolView name="chevron.right" size={17} tintColor={mutedForeground} />
            </Pressable>
          )}
        </View>

        {visiblePresentations.length > 0 ? (
          <View className="gap-3">
            <SectionHeader title="Updates" />
            {visiblePresentations.slice(0, showDetails ? 8 : 2).map((presentation) => (
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
          </View>
        ) : null}

        {recentTasks.length > 0 || visiblePresentations.length > 2 ? (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: showDetails }}
            onPress={() => setShowDetails((value) => !value)}
            className="min-h-12 flex-row items-center justify-between border-t border-border-subtle px-1"
          >
            <Text className="text-sm text-foreground-muted">
              {showDetails ? "Show less" : "Show more"}
            </Text>
            <SymbolView
              name={showDetails ? "chevron.up" : "chevron.down"}
              size={14}
              tintColor={mutedForeground}
            />
          </Pressable>
        ) : null}
        {showDetails && recentTasks.length > 0 ? (
          <View className="gap-3">
            <SectionHeader title="Recent work" />
            {recentTasks.map((task) => (
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
        ) : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function SectionHeader(props: {
  readonly title: string;
  readonly actionLabel?: string;
  readonly onAction?: () => void;
}) {
  return (
    <View className="flex-row items-center justify-between px-1">
      <Text className="text-lg font-t3-bold text-foreground">{props.title}</Text>
      {props.actionLabel && props.onAction ? (
        <Pressable accessibilityRole="button" onPress={props.onAction} className="px-2 py-1">
          <Text className="text-sm font-t3-bold text-foreground-muted">{props.actionLabel}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function formatTaskState(state: JarvisTaskDeskView["recentTasks"][number]["state"]): string {
  return state.replaceAll("-", " ");
}

function TaskDeskCard(props: {
  readonly task: NonNullable<JarvisTaskDeskView["focusedTask"]>;
  readonly focused?: boolean;
  readonly onFocus: (() => void) | undefined;
  readonly onOpen: () => void;
}) {
  return (
    <View
      className={`flex-row items-center gap-3 rounded-2xl border bg-card p-4 ${
        props.focused ? "border-primary" : "border-border-subtle"
      }`}
    >
      <Pressable
        accessibilityRole="button"
        onPress={props.onOpen}
        className="min-w-0 flex-1 flex-row items-center gap-3"
      >
        <View className="min-w-0 flex-1 gap-1.5">
          <View className="flex-row items-center gap-2">
            <View
              className={`h-2 w-2 rounded-full ${
                props.task.state === "failed" || props.task.state === "interrupted"
                  ? "bg-danger-foreground"
                  : props.task.state === "running"
                    ? "bg-primary"
                    : "bg-foreground-muted"
              }`}
            />
            <Text className="text-xs capitalize text-foreground-muted">
              {formatTaskState(props.task.state)}
            </Text>
          </View>
          <Text className="text-base font-t3-bold text-foreground" numberOfLines={1}>
            {props.task.title}
          </Text>
          <Text className="text-sm leading-relaxed text-foreground-muted" numberOfLines={2}>
            {props.task.objective}
          </Text>
        </View>
        <SymbolView name="chevron.right" size={16} tintColor="#8b8b93" />
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
      className="rounded-2xl border border-primary bg-card p-4 active:opacity-70"
    >
      <Text className="text-xs font-t3-bold capitalize text-primary">
        {props.event.kind.replaceAll("-", " ")}
      </Text>
      <Text className="mt-1.5 text-base font-t3-bold text-foreground">
        {props.event.threadTitle}
      </Text>
      <Text className="mt-1 text-sm leading-relaxed text-foreground-muted" numberOfLines={3}>
        {props.event.text}
      </Text>
    </Pressable>
  );
}

function JarvisSettingsButton() {
  const navigation = useNavigation();
  return (
    <ControlPill
      accessibilityLabel="Open settings"
      icon="gearshape"
      onPress={() =>
        navigation.navigate("SettingsSheet", {
          screen: "SettingsContent",
          params: { screen: "Settings" },
        })
      }
    />
  );
}
