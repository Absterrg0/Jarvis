import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const native = vi.hoisted(() => ({
  platform: "android" as "ios" | "android",
  permissions: vi.fn<() => Promise<{ readonly granted: boolean; readonly canAskAgain?: boolean }>>(
    () => Promise.resolve({ granted: true }),
  ),
  requestPermissions: vi.fn<() => Promise<{ readonly granted: boolean }>>(() =>
    Promise.resolve({ granted: true }),
  ),
  channel: vi.fn(() => Promise.resolve()),
  token: vi.fn(() => Promise.resolve({ data: " ExponentPushToken[one] " })),
}));

vi.mock("expo-constants", () => ({
  default: {
    expoConfig: { extra: { eas: { projectId: "jarvis-eas-project" } } },
    easConfig: undefined,
  },
}));

vi.mock("expo-notifications", () => ({
  AndroidImportance: { DEFAULT: 3 },
  getPermissionsAsync: native.permissions,
  requestPermissionsAsync: native.requestPermissions,
  setNotificationChannelAsync: native.channel,
  getExpoPushTokenAsync: native.token,
  addPushTokenListener: vi.fn(() => ({ remove: vi.fn() })),
}));

vi.mock("../../persistence/imperative", () => ({
  loadOrCreateAgentAwarenessDeviceId: vi.fn(() => Promise.resolve("device-1")),
}));

vi.mock("react-native", () => ({
  Platform: {
    get OS() {
      return native.platform;
    },
  },
  AppState: { addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
}));

async function nativeModule() {
  return import("./expoPushRegistrationNative");
}

describe("readExpoPushToken", () => {
  beforeEach(() => {
    vi.stubGlobal("__DEV__", false);
  });

  it("uses the configured EAS project id and creates Android channel before token fetch", async () => {
    native.permissions.mockResolvedValueOnce({ granted: true });
    native.channel.mockClear();
    native.token.mockClear();

    const { readExpoPushToken, resolveExpoProjectId } = await nativeModule();
    await expect(readExpoPushToken()).resolves.toBe("ExponentPushToken[one]");
    expect(resolveExpoProjectId()).toBe("jarvis-eas-project");
    expect(native.channel).toHaveBeenCalledWith(
      "jarvis-tasks",
      expect.objectContaining({ name: "Jarvis tasks", importance: 3 }),
    );
    expect(native.channel.mock.invocationCallOrder[0]).toBeLessThan(
      native.token.mock.invocationCallOrder[0]!,
    );
    expect(native.token).toHaveBeenCalledWith({ projectId: "jarvis-eas-project" });
  });

  it("requests Android notification permission before fetching a token", async () => {
    native.permissions.mockResolvedValueOnce({ granted: false, canAskAgain: true });
    native.requestPermissions.mockResolvedValueOnce({ granted: true });
    native.channel.mockClear();
    native.requestPermissions.mockClear();
    native.token.mockClear();

    const { readExpoPushToken } = await nativeModule();
    await expect(readExpoPushToken()).resolves.toBe("ExponentPushToken[one]");
    expect(native.channel).toHaveBeenCalledOnce();
    expect(native.requestPermissions).toHaveBeenCalledOnce();
    expect(native.channel.mock.invocationCallOrder[0]).toBeLessThan(
      native.requestPermissions.mock.invocationCallOrder[0]!,
    );
    expect(native.requestPermissions.mock.invocationCallOrder[0]).toBeLessThan(
      native.token.mock.invocationCallOrder[0]!,
    );
  });

  it("does not fetch a token when Android notification permission is denied", async () => {
    native.permissions.mockResolvedValueOnce({ granted: false, canAskAgain: true });
    native.requestPermissions.mockResolvedValueOnce({ granted: false });
    native.channel.mockClear();
    native.requestPermissions.mockClear();
    native.token.mockClear();

    const { readExpoPushToken } = await nativeModule();
    await expect(readExpoPushToken()).resolves.toBeNull();
    expect(native.channel).toHaveBeenCalledOnce();
    expect(native.requestPermissions).toHaveBeenCalledOnce();
    expect(native.token).not.toHaveBeenCalled();
  });
});
