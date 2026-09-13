import { NodeServices } from "@effect/platform-node";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type DesktopUseFrame,
  type DesktopUseStatus,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer } from "effect/unstable/ai";

import * as ServerConfig from "../config.ts";
import * as DesktopUse from "../jarvis/desktopUse/DesktopUse.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";

const environmentId = EnvironmentId.make("environment-desktop-mcp");
const threadId = ThreadId.make("thread-desktop-mcp");

const status: DesktopUseStatus = {
  available: true,
  platform: "linux",
  backend: "linux-x11",
  displays: [{ id: "primary", x: 0, y: 0, width: 4, height: 2, scale: 1, primary: true }],
  supports: { capture: true, pointer: true, keyboard: true, windows: true },
};

const png = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 4,
  0, 0, 0, 2,
]);

const frame: DesktopUseFrame = {
  displayId: "primary",
  width: 4,
  height: 2,
  scale: 1,
  mimeType: "image/png",
  data: Buffer.from(png).toString("base64"),
  capturedAt: 1,
  cursor: { x: 3, y: 1 },
};

const desktopUseService = Layer.succeed(DesktopUse.DesktopUse, {
  getStatus: () => Effect.succeed(status),
  capture: () => Effect.succeed(frame),
  input: () => Effect.succeed({}),
  listWindows: () => Effect.succeed([]),
  subscribeFrames: () => Stream.empty,
});

const TestLayer = McpHttpServer.DesktopUseToolkitRegistration.pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provideMerge(desktopUseService),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-desktop-mcp-" })),
  Layer.provideMerge(NodeServices.layer),
);

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "desktop-mcp-test", version: "1.0.0" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "desktop-mcp-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

const invocation = (
  capabilities: ReadonlyArray<McpInvocationContext.McpCapability>,
): McpInvocationContext.McpInvocationScope => ({
  environmentId,
  threadId,
  providerSessionId: "provider-session-desktop-mcp",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(capabilities),
  issuedAt: 1,
});

const callTool = (
  name: string,
  args: Record<string, unknown>,
  capabilities: ReadonlyArray<McpInvocationContext.McpCapability> = ["desktop-use"],
) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    return yield* server
      .callTool({ name, arguments: args })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation(capabilities)),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
  });

it.layer(TestLayer)("desktop use MCP registration", (it) => {
  it.effect("returns a screenshot as text plus image content", () =>
    Effect.gen(function* () {
      const result = yield* callTool("desktop_screenshot", {});
      expect(result.isError).toBe(false);
      expect(result.content[0]).toEqual({
        type: "text",
        text: "Desktop screenshot 4x2 on display primary; pointer at 3,1.",
      });
      const image = result.content[1] as { type: "image"; mimeType: string; data: Uint8Array };
      expect(image.type).toBe("image");
      expect(image.mimeType).toBe("image/png");
      expect(Buffer.from(image.data)).toEqual(Buffer.from(png));
    }),
  );

  it.effect("exposes the capability-gated status and input tools", () =>
    Effect.gen(function* () {
      const statusResult = yield* callTool("desktop_status", {});
      expect(statusResult.isError).toBe(false);
      expect(statusResult.structuredContent).toMatchObject({ backend: "linux-x11" });
      const inputResult = yield* callTool("desktop_click", { x: 1, y: 1 });
      expect(inputResult.isError).toBe(false);
    }),
  );

  it.effect("refuses a credential without the desktop-use capability", () =>
    Effect.gen(function* () {
      const result = yield* callTool("desktop_status", {}, ["preview"]);
      expect(result.isError).toBe(true);
      const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join(" ");
      expect(text).toContain("desktop-use");
    }),
  );
});
