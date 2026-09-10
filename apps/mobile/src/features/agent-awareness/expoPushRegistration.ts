export const EXPO_PUSH_CHANNEL_ID = "jarvis-tasks";

export interface ExpoPushRegistrationNode {
  readonly environmentId: string;
  readonly supportsExpoPush: boolean;
}

export interface ExpoPushRegistrationRequest {
  readonly token: string;
  readonly deviceId: string;
}

export type RegisterExpoPushToken = (
  node: ExpoPushRegistrationNode,
  request: ExpoPushRegistrationRequest,
) => Promise<void>;

export type ExpoPushRegistrationTrigger =
  | "launch"
  | "foreground"
  | "token-rotation"
  | "new-connection";

function eligibleNodes(nodes: ReadonlyArray<ExpoPushRegistrationNode>) {
  const seen = new Set<string>();
  return nodes.filter((node) => {
    if (!node.supportsExpoPush || seen.has(node.environmentId)) {
      return false;
    }
    seen.add(node.environmentId);
    return true;
  });
}

/**
 * Fans out one device token to nodes directly. A node failure is isolated so
 * one disconnected pairing cannot suppress registration on another node.
 */
export class ExpoPushRegistrationCoordinator {
  private readonly register: RegisterExpoPushToken;
  private readonly deviceId: string;
  private token: string | null = null;
  private connectedNodeIds = new Set<string>();

  constructor(register: RegisterExpoPushToken, deviceId: string) {
    this.register = register;
    this.deviceId = deviceId;
  }

  async registerOnLaunch(
    token: string | null,
    nodes: ReadonlyArray<ExpoPushRegistrationNode>,
  ): Promise<void> {
    this.token = token;
    this.connectedNodeIds = new Set(eligibleNodes(nodes).map((node) => node.environmentId));
    await this.send(nodes);
  }

  async registerOnForeground(
    token: string,
    nodes: ReadonlyArray<ExpoPushRegistrationNode>,
  ): Promise<void> {
    this.token = token;
    await this.send(nodes);
  }

  async registerOnTokenRotation(
    token: string,
    nodes: ReadonlyArray<ExpoPushRegistrationNode>,
  ): Promise<void> {
    this.token = token;
    await this.send(nodes);
  }

  async registerConnectedNodes(nodes: ReadonlyArray<ExpoPushRegistrationNode>): Promise<void> {
    const current = eligibleNodes(nodes);
    const currentIds = new Set(current.map((node) => node.environmentId));
    const newlyConnected = current.filter((node) => !this.connectedNodeIds.has(node.environmentId));
    this.connectedNodeIds = currentIds;
    if (this.token === null) {
      return;
    }
    await this.send(newlyConnected);
  }

  private async send(nodes: ReadonlyArray<ExpoPushRegistrationNode>): Promise<void> {
    if (this.token === null) {
      return;
    }
    const request = { token: this.token, deviceId: this.deviceId };
    await Promise.all(
      eligibleNodes(nodes).map(async (node) => {
        try {
          await this.register(node, request);
        } catch (error) {
          if (typeof __DEV__ !== "undefined" && __DEV__) {
            console.warn("[agent-awareness] Expo Push registration failed", {
              environmentId: node.environmentId,
              error,
            });
          }
        }
      }),
    );
  }
}
