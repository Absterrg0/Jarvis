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
import { useNavigation } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { CircePresentationEvent, CirceTaskDeskView } from "@t3tools/contracts";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { ControlPill } from "../../components/ControlPill";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { CirceNavigation } from "./CirceNavigation";
import { useCirceController } from "./CirceMobileProvider";
import { selectCurrentPresentations } from "./mobilePresentations";
import { describeCirceRouteNodeIssues } from "./mobileNodeReadiness";

const CIRCE_GRAPHITE = "#191a1d";
const CIRCE_GRAPHITE_DEEP = "#111214";
const CIRCE_WARM = "#f4f0e8";
const CIRCE_MUTED = "#92969f";
const CIRCE_STATUS_GREEN = "#90b78a";

export function CirceRouteScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const controller = useCirceController();
  const catalog = controller.catalog;
  const [utterance, setUtterance] = useState("");
  const [showDetails, setShowDetails] = useState(false);
  const [choosingProject, setChoosingProject] = useState(false);

  useEffect(() => {
    if (controller.catalog === null) void controller.refresh();
  }, [controller.catalog, controller.refresh]);

  const submit = useCallback(async () => {
    // A correction typed while the previous request still submits cancels
    // that request first through the pre-accept wire; the retained text stays
    // for resend or follow-up instead of being silently dropped.
    if (controller.submitting) {
      await controller.cancelInflightRequest();
      return;
    }
    const turn = controller.createTextTurn();
    await controller.runInstruction(turn, utterance);
    setUtterance("");
  }, [controller, utterance]);

  const projects = catalog?.projects ?? [];
  const hasOnlineNode = (catalog?.nodes ?? []).some((node) => node.reachability === "online");
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
  const nodeIssues = useMemo(() => describeCirceRouteNodeIssues(catalog), [catalog]);
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
          title: "Circe",
          headerRight: CirceSettingsButton,
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
        <CirceNavigation selected="assistant" />

        <View
          className="gap-4 overflow-hidden rounded-2xl border p-5"
          style={{
            backgroundColor: CIRCE_GRAPHITE,
            borderColor: "#34363b",
          }}
        >
          <View className="flex-row items-center justify-between gap-3">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Choose working project"
              onPress={() => setChoosingProject(true)}
              className="min-w-0 flex-1 gap-1"
            >
              <Text className="text-xs" style={{ color: CIRCE_STATUS_GREEN }}>
                Working project
              </Text>
              <Text
                numberOfLines={1}
                className="mt-1 text-xl font-t3-bold"
                style={{ color: CIRCE_WARM }}
              >
                {controller.selectedProject?.title ?? "Choose a project"}
              </Text>
              {controller.selectedProject ? (
                <Text numberOfLines={1} className="text-xs" style={{ color: CIRCE_MUTED }}>
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
              <Text
                className="text-xs font-t3-bold"
                style={{ color: hasOnlineNode ? CIRCE_STATUS_GREEN : CIRCE_MUTED }}
              >
                {hasOnlineNode ? "Connected" : "Offline"}
              </Text>
            </Pressable>
          </View>
          <TextInput
            accessibilityLabel="Circe command"
            className="max-h-36 min-h-24 rounded-xl border px-3.5 py-3 text-base"
            style={{
              backgroundColor: CIRCE_GRAPHITE_DEEP,
              borderColor: "rgba(255, 255, 255, 0.12)",
              color: CIRCE_WARM,
            }}
            multiline
            onChangeText={setUtterance}
            placeholder="Tell Circe what needs doing…"
            placeholderTextColorClassName="accent-placeholder"
            textAlignVertical="top"
            value={utterance}
          />
          <View className="flex-row items-center justify-between gap-3">
            <ControlPill
              accessibilityLabel={
                controller.submitting ? "Cancel in-flight request" : "Send Circe command"
              }
              icon={controller.submitting ? "stop.fill" : "arrow.up"}
              variant="primary"
              onPress={() => void submit()}
              disabled={utterance.trim() === "" && !controller.submitting}
            />
          </View>
        </View>

        {controller.unavailableProjectKey !== null ? (
          <View className="gap-3 rounded-2xl border border-danger bg-card p-5">
            <Text className="text-base font-t3-bold text-foreground">
              Selected project unavailable
            </Text>
            <Text className="text-sm leading-relaxed text-foreground-muted">
              The selected project is not in the current catalog. New instructions wait instead of
              borrowing a different target.
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
            <Text className="text-base font-t3-bold text-foreground">Bring Circe online</Text>
            <Text className="text-sm leading-relaxed text-foreground-muted">
              Connect this phone to a Circe desktop, then type from anywhere.
            </Text>
            <ControlPill
              label="Connect Circe"
              variant="primary"
              onPress={() =>
                navigation.navigate("SettingsSheet", {
                  screen: "SettingsContent",
                  params: { screen: "SettingsEnvironmentNew" },
                })
              }
            />
          </View>
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
              <SymbolView name="bolt.circle" size={15} tintColorClassName="accent-icon" />
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
              <Text className="text-sm font-t3-bold text-primary">Circe needs your answer</Text>
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
                  Ask Circe for something, or start a task in the workspace.
                </Text>
              </View>
              <SymbolView name="chevron.right" size={17} tintColorClassName="accent-icon-subtle" />
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
              tintColorClassName="accent-icon-subtle"
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

function formatTaskState(state: CirceTaskDeskView["recentTasks"][number]["state"]): string {
  return state.replaceAll("-", " ");
}

function TaskDeskCard(props: {
  readonly task: NonNullable<CirceTaskDeskView["focusedTask"]>;
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
  readonly event: CircePresentationEvent;
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

function CirceSettingsButton() {
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
