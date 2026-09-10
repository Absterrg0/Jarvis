import { describe, expect, it, vi } from "vite-plus/test";

import {
  ExpoPushRegistrationCoordinator,
  type ExpoPushRegistrationNode,
} from "./expoPushRegistration";

const node = (environmentId: string, supportsExpoPush = true): ExpoPushRegistrationNode => ({
  environmentId,
  supportsExpoPush,
});

describe("ExpoPushRegistrationCoordinator", () => {
  it("registers a launch token with every eligible connected node", async () => {
    const register = vi.fn<
      (
        target: ExpoPushRegistrationNode,
        request: { token: string; deviceId: string },
      ) => Promise<void>
    >(() => Promise.resolve());
    const coordinator = new ExpoPushRegistrationCoordinator(register, "device-1");

    await coordinator.registerOnLaunch("ExponentPushToken[one]", [
      node("node-a"),
      node("node-b", false),
      node("node-c"),
    ]);

    expect(register).toHaveBeenCalledTimes(2);
    expect(register).toHaveBeenCalledWith(
      node("node-a"),
      expect.objectContaining({ token: "ExponentPushToken[one]", deviceId: "device-1" }),
    );
    expect(register).toHaveBeenCalledWith(
      node("node-c"),
      expect.objectContaining({ token: "ExponentPushToken[one]", deviceId: "device-1" }),
    );
  });

  it("re-registers every eligible node on foreground and token rotation", async () => {
    const register = vi.fn<
      (
        target: ExpoPushRegistrationNode,
        request: { token: string; deviceId: string },
      ) => Promise<void>
    >(() => Promise.resolve());
    const coordinator = new ExpoPushRegistrationCoordinator(register, "device-1");
    const nodes = [node("node-a"), node("node-b")];

    await coordinator.registerOnLaunch("ExponentPushToken[one]", nodes);
    await coordinator.registerOnForeground("ExponentPushToken[one]", nodes);
    await coordinator.registerOnTokenRotation("ExponentPushToken[two]", nodes);

    expect(register).toHaveBeenCalledTimes(6);
    expect(register.mock.calls.at(-1)?.[1]).toMatchObject({
      token: "ExponentPushToken[two]",
    });

    await coordinator.registerOnForeground("ExponentPushToken[three]", nodes);
    expect(register.mock.calls.at(-1)?.[1]).toMatchObject({
      token: "ExponentPushToken[three]",
    });
  });

  it("registers only a newly connected node", async () => {
    const register = vi.fn<
      (
        target: ExpoPushRegistrationNode,
        request: { token: string; deviceId: string },
      ) => Promise<void>
    >(() => Promise.resolve());
    const coordinator = new ExpoPushRegistrationCoordinator(register, "device-1");
    const initialNodes = [node("node-a")];

    await coordinator.registerOnLaunch("ExponentPushToken[one]", initialNodes);
    await coordinator.registerConnectedNodes([...initialNodes, node("node-b")]);

    expect(register).toHaveBeenCalledTimes(2);
    expect(register.mock.calls.at(-1)?.[0]).toEqual(node("node-b"));
  });

  it("keeps fan-out independent when one node rejects", async () => {
    const register = vi.fn<
      (
        target: ExpoPushRegistrationNode,
        request: { token: string; deviceId: string },
      ) => Promise<void>
    >((target) =>
      target.environmentId === "node-a"
        ? Promise.reject(new Error("node unavailable"))
        : Promise.resolve(),
    );
    const coordinator = new ExpoPushRegistrationCoordinator(register, "device-1");

    await expect(
      coordinator.registerOnLaunch("ExponentPushToken[one]", [node("node-a"), node("node-b")]),
    ).resolves.toBeUndefined();
    expect(register).toHaveBeenCalledTimes(2);
  });

  it("does not register until a token is available", async () => {
    const register = vi.fn<
      (
        target: ExpoPushRegistrationNode,
        request: { token: string; deviceId: string },
      ) => Promise<void>
    >(() => Promise.resolve());
    const coordinator = new ExpoPushRegistrationCoordinator(register, "device-1");

    await coordinator.registerConnectedNodes([node("node-a")]);

    expect(register).not.toHaveBeenCalled();
  });
});
