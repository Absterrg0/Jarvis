import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { AppState, Platform } from "react-native";
import { useEffect, useRef } from "react";

import { loadOrCreateAgentAwarenessDeviceId } from "../../persistence/imperative";
import {
  EXPO_PUSH_CHANNEL_ID,
  ExpoPushRegistrationCoordinator,
  type ExpoPushRegistrationNode,
  type ExpoPushRegistrationTrigger,
  type RegisterExpoPushToken,
} from "./expoPushRegistration";

export type { ExpoPushRegistrationNode } from "./expoPushRegistration";

export function resolveExpoProjectId(): string | null {
  const projectId = Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
  return typeof projectId === "string" && projectId.trim().length > 0 ? projectId.trim() : null;
}

export async function readExpoPushToken(
  projectId = resolveExpoProjectId(),
): Promise<string | null> {
  if (projectId === null) return null;

  const permission = await Notifications.getPermissionsAsync();
  if (!permission.granted) return null;

  // Android requires its channel before native token acquisition. This also
  // keeps notification presentation deterministic for the first push.
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync(EXPO_PUSH_CHANNEL_ID, {
      name: "Jarvis tasks",
      importance: Notifications.AndroidImportance.DEFAULT,
    });
  }

  const token = await Notifications.getExpoPushTokenAsync({ projectId });
  return typeof token.data === "string" && token.data.trim().length > 0 ? token.data.trim() : null;
}

export function useExpoPushRegistration(input: {
  readonly nodes: ReadonlyArray<ExpoPushRegistrationNode>;
  readonly register: RegisterExpoPushToken;
  readonly projectId?: string | null;
  readonly deviceId?: string;
}): void {
  const nodesRef = useRef(input.nodes);
  nodesRef.current = input.nodes;
  const coordinatorRef = useRef<ExpoPushRegistrationCoordinator | null>(null);

  useEffect(() => {
    void coordinatorRef.current?.registerConnectedNodes(input.nodes);
  }, [input.nodes]);

  useEffect(() => {
    let cancelled = false;
    const projectId = input.projectId === undefined ? resolveExpoProjectId() : input.projectId;
    let tokenSubscription: { remove: () => void } | null = null;
    let appStateSubscription: { remove: () => void } | null = null;

    const setup = async (): Promise<void> => {
      try {
        const deviceId = input.deviceId ?? (await loadOrCreateAgentAwarenessDeviceId());
        if (cancelled) return;
        const coordinator = new ExpoPushRegistrationCoordinator(input.register, deviceId);
        coordinatorRef.current = coordinator;
        await coordinator.registerConnectedNodes(nodesRef.current);

        const readAndRegister = async (trigger: ExpoPushRegistrationTrigger): Promise<void> => {
          try {
            const token = await readExpoPushToken(projectId);
            if (cancelled || token === null) return;
            if (trigger === "launch") {
              await coordinator.registerOnLaunch(token, nodesRef.current);
            } else if (trigger === "foreground") {
              await coordinator.registerOnForeground(token, nodesRef.current);
            } else {
              await coordinator.registerOnTokenRotation(token, nodesRef.current);
            }
          } catch (error) {
            if (typeof __DEV__ !== "undefined" && __DEV__)
              console.warn("[agent-awareness] Expo Push token lookup failed", error);
          }
        };

        void readAndRegister("launch");
        tokenSubscription = Notifications.addPushTokenListener(() => {
          void readAndRegister("token-rotation");
        });
        appStateSubscription = AppState.addEventListener("change", (state) => {
          if (state === "active") void readAndRegister("foreground");
        });
      } catch (error) {
        if (typeof __DEV__ !== "undefined" && __DEV__)
          console.warn("[agent-awareness] Expo Push registration setup failed", error);
      }
    };
    void setup();
    return () => {
      cancelled = true;
      tokenSubscription?.remove();
      appStateSubscription?.remove();
    };
  }, [input.deviceId, input.projectId, input.register]);
}
