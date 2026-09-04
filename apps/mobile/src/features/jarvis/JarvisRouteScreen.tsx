import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, TextInput, View } from "react-native";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { JarvisPresentationEvent, JarvisTaskDeskView } from "@t3tools/contracts";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { ControlPill } from "../../components/ControlPill";
import { useThemeColor } from "../../lib/useThemeColor";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useJarvisController } from "./JarvisMobileProvider";
import { isPushToTalkDisabled, type MobileVoicePhase } from "./mobilePushToTalk";
import { useJarvisVoice } from "./useJarvisVoice";

const PHASE_COPY: Record<MobileVoicePhase, { readonly title: string; readonly detail: string }> = {
  idle: { title: "What do you need?", detail: "Hold the button, speak naturally, then release" },
  preparing: { title: "Starting microphone", detail: "Keep holding" },
  recording: { title: "I’m listening", detail: "Release when you’re finished" },
  transcribing: { title: "Working it out", detail: "Understanding your request" },
  speaking: { title: "Here’s what I found", detail: "Your work keeps running in the background" },
};

export function JarvisRouteScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const controller = useJarvisController();
  const catalog = controller.catalog;
  const [utterance, setUtterance] = useState("");
  const primaryForeground = useThemeColor("--color-primary-foreground");
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
        // Navigating away aborts a live capture but lets the current
        // utterance finish playing instead of cutting it off mid-sentence.
        voice.cancelCapture();
      };
    }, [controller.attachSpeechSink, voice.cancelCapture, voice.enqueueSpeech]),
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
  const phaseCopy =
    projects.length === 0
      ? { title: "Connect your desktop", detail: "Jarvis needs a connected computer to work" }
      : voice.selection.status === "no-voice-node"
        ? { title: "Voice is unavailable", detail: "Your connected desktop is not offering speech" }
        : PHASE_COPY[voice.phase];
  const pushToTalkDisabled = isPushToTalkDisabled({
    submitting: controller.submitting,
    hasProject: projects.length > 0,
    hasVoiceNode: voice.selection.status === "selected",
    phase: voice.phase,
  });
  const focusedTask = controller.desk?.focusedTask;
  const recentTasks = useMemo(
    () =>
      (controller.desk?.recentTasks ?? [])
        .filter((task) => task.threadId !== focusedTask?.threadId)
        .slice(0, 4),
    [controller.desk?.recentTasks, focusedTask?.threadId],
  );
  return (
    <View className="flex-1 bg-screen">
      <NativeStackScreenOptions options={{ headerBackVisible: false, title: "Jarvis" }} />

      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{
          gap: 24,
          paddingHorizontal: 20,
          paddingTop: 10,
          paddingBottom: Math.max(insets.bottom, 18) + 28,
        }}
        showsVerticalScrollIndicator={false}
      >
        <View className="gap-5">
          <View className="flex-row items-center justify-between gap-3">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Open workspace"
              onPress={() => navigation.navigate("Home")}
              className="h-11 flex-row items-center gap-1.5 rounded-full bg-subtle px-4 active:opacity-70"
            >
              <Text className="text-sm font-t3-bold text-foreground">Workspace</Text>
              <SymbolView name="chevron.right" size={14} tintColor={iconForeground} />
            </Pressable>
            <View className="flex-row gap-2">
              <ControlPill
                accessibilityLabel="Start a new task"
                icon="square.and.pencil"
                onPress={() => navigation.navigate("NewTaskSheet", { screen: "NewTask" })}
              />
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
            </View>
          </View>

          <View className="gap-1 px-1">
            <Text className="text-3xl font-t3-bold tracking-tight text-foreground">
              How can I help?
            </Text>
            <Text className="text-base leading-relaxed text-foreground-muted">
              Tell Jarvis what you need. The right context is handled for you.
            </Text>
          </View>
        </View>

        <View className="items-center overflow-hidden rounded-[32px] border border-border-subtle bg-card px-6 py-8">
          <View
            className={`mb-5 h-36 w-36 items-center justify-center rounded-full ${
              voice.phase === "recording" ? "bg-danger" : "bg-subtle"
            }`}
          >
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Hold to talk to Jarvis"
              accessibilityHint="Keep holding while you speak, then release to send"
              accessibilityState={{ disabled: pushToTalkDisabled }}
              onPressIn={() => {
                void voice.startCapture({
                  originInteractionId: controller.preparedOriginInteractionId,
                });
              }}
              onPressOut={() => void voice.finishCapture()}
              disabled={pushToTalkDisabled}
              className={`h-28 w-28 items-center justify-center rounded-full ${
                voice.phase === "recording"
                  ? "bg-danger"
                  : pushToTalkDisabled
                    ? "bg-subtle-strong"
                    : "bg-primary"
              }`}
            >
              <SymbolView
                name="mic.fill"
                size={36}
                tintColor={
                  voice.phase === "recording"
                    ? dangerForeground
                    : pushToTalkDisabled
                      ? mutedForeground
                      : primaryForeground
                }
                type="monochrome"
              />
            </Pressable>
          </View>
          <Text className="text-center text-2xl font-t3-bold text-foreground">
            {phaseCopy.title}
          </Text>
          <Text className="mt-1.5 text-center text-sm leading-relaxed text-foreground-muted">
            {phaseCopy.detail}
          </Text>
        </View>

        {projects.length === 0 ? (
          <View className="gap-3 rounded-[24px] border border-border-subtle bg-card p-5">
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

        {controller.message ? (
          <View className="flex-row gap-3 rounded-[24px] bg-subtle px-4 py-4">
            <View className="mt-0.5 h-7 w-7 items-center justify-center rounded-full bg-card">
              <SymbolView name="bolt.circle" size={15} tintColor={iconForeground} />
            </View>
            <Text className="min-w-0 flex-1 text-sm leading-relaxed text-foreground">
              {controller.message}
            </Text>
          </View>
        ) : null}

        <View className="flex-row items-end gap-2 rounded-[26px] border border-border-subtle bg-card p-2 pl-4 shadow-sm shadow-black/5">
          <TextInput
            accessibilityLabel="Jarvis command"
            className="max-h-28 min-h-12 flex-1 py-3 text-base text-foreground"
            multiline
            onChangeText={setUtterance}
            placeholder="Type a command…"
            placeholderTextColor={mutedForeground}
            textAlignVertical="center"
            value={utterance}
          />
          <ControlPill
            accessibilityLabel="Send Jarvis command"
            icon="arrow.up"
            variant="primary"
            onPress={() => void submit()}
            disabled={controller.submitting || utterance.trim() === ""}
            className="mb-0.5"
          />
        </View>

        <View className="gap-3">
          <SectionHeader
            title="Current work"
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
              className="rounded-[22px] border border-primary bg-card p-4 active:opacity-70"
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
              className="flex-row items-center justify-between rounded-[24px] border border-border-subtle bg-card p-5 active:opacity-70"
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

        {controller.presentations.length > 0 ? (
          <View className="gap-3">
            <SectionHeader title="Latest from Jarvis" />
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
          </View>
        ) : null}

        {recentTasks.length > 0 ? (
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

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Open workspace"
          onPress={() => navigation.navigate("Home")}
          className="flex-row items-center justify-between rounded-[24px] bg-subtle px-5 py-4 active:opacity-70"
        >
          <View className="flex-row items-center gap-3">
            <View>
              <Text className="text-sm font-t3-bold text-foreground">Workspace</Text>
              <Text className="mt-0.5 text-xs text-foreground-muted">
                Threads, diffs and terminals
              </Text>
            </View>
          </View>
          <SymbolView name="chevron.right" size={16} tintColor={mutedForeground} />
        </Pressable>
      </ScrollView>
    </View>
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
      className={`flex-row items-center gap-3 rounded-[24px] border bg-card p-4 ${
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
      className="rounded-[24px] border border-primary bg-card p-4 active:opacity-70"
    >
      <Text className="text-xs font-t3-bold capitalize text-primary">
        {props.event.kind.replaceAll("-", " ")}
      </Text>
      <Text className="mt-1.5 text-base font-t3-bold text-foreground">
        {props.event.threadTitle}
      </Text>
      <Text className="mt-1 text-sm leading-relaxed text-foreground-muted">{props.event.text}</Text>
    </Pressable>
  );
}
