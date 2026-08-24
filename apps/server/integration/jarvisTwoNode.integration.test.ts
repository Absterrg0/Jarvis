// @effect-diagnostics nodeBuiltinImport:off - This test intentionally starts real local child processes.
// @effect-diagnostics globalTimers:off - Bounded timers supervise real child-process deadlines.
// @effect-diagnostics globalFetch:off - Pairing uses the real local HTTP transport.
// @effect-diagnostics globalErrorInEffectFailure:off - Test failures use ordinary diagnostics.
// @effect-diagnostics preferSchemaOverJson:off - The harness reads fixed fixture JSON.
// @effect-diagnostics globalConsole:off - Child diagnostics are emitted on failed runs.
// @effect-diagnostics anyUnknownInErrorContext:off - The client-runtime integration layer is dynamic.
// @effect-diagnostics missingEffectContext:off - The client-runtime integration layer is dynamic.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";

import * as NodeSocket from "@effect/platform-node/NodeSocket";
import {
  AuthStandardClientScopes,
  type EnvironmentId,
  type JarvisVoiceReportDelivery,
  ProjectId,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Socket from "effect/unstable/socket/Socket";
import * as Deferred from "effect/Deferred";
import { expect, it, describe } from "vite-plus/test";

import * as ClientCapabilities from "../../../packages/client-runtime/src/platform/capabilities.ts";
import * as Persistence from "../../../packages/client-runtime/src/platform/persistence.ts";
import * as TokenStore from "../../../packages/client-runtime/src/authorization/tokenStore.ts";
import * as RemoteAuthorization from "../../../packages/client-runtime/src/authorization/service.ts";
import * as ConnectionCredentialStore from "../../../packages/client-runtime/src/connection/credentialStore.ts";
import * as ConnectionDriver from "../../../packages/client-runtime/src/connection/driver.ts";
import * as ConnectionProfileStore from "../../../packages/client-runtime/src/connection/profileStore.ts";
import * as ConnectionResolver from "../../../packages/client-runtime/src/connection/resolver.ts";
import * as EnvironmentRegistry from "../../../packages/client-runtime/src/connection/registry.ts";
import * as Connectivity from "../../../packages/client-runtime/src/connection/connectivity.ts";
import * as ConnectionWakeups from "../../../packages/client-runtime/src/connection/wakeups.ts";
import * as EnvironmentSupervisor from "../../../packages/client-runtime/src/connection/supervisor.ts";
import * as SubscriptionRef from "effect/SubscriptionRef";
import {
  type ConnectionCredential,
  type ConnectionProfile,
  type ConnectionRegistration,
} from "../../../packages/client-runtime/src/connection/catalog.ts";
import { preparePairingRegistration } from "../../../packages/client-runtime/src/connection/onboarding.ts";
import { type ConnectionTarget } from "../../../packages/client-runtime/src/connection/model.ts";
import * as RpcSession from "../../../packages/client-runtime/src/rpc/session.ts";
import { remoteHttpClientLayer } from "../../../packages/client-runtime/src/rpc/http.ts";
import * as JarvisMeshModule from "@t3tools/jarvis-client-runtime/jarvis/mesh";
import * as ManagedRelay from "../../../packages/client-runtime/src/relay/managedRelay.ts";

const REPO_ROOT = NodePath.resolve(import.meta.dirname, "../../..");
const CODEX_PEER = NodePath.join(
  REPO_ROOT,
  "apps/server/src/provider/testFixtures/codexCollabMockPeer.sh",
);
const CODEX_WIRE = NodePath.join(
  REPO_ROOT,
  "apps/server/src/provider/testFixtures/codexMultiAgentWire.json",
);
const localFetch = globalThis.fetch.bind(globalThis) as unknown as typeof globalThis.fetch;

type ServerChild = {
  readonly process: NodeChildProcess.ChildProcess;
  readonly pid: number;
  readonly baseDir: string;
  readonly projectDir: string;
  readonly port: number;
  readonly preset: "full" | "controller" | "headless";
  readonly pairingUrl: string;
  readonly output: () => string;
};

const redactOutput = (output: string): string =>
  output
    .replaceAll(/(Pairing URL:\s*\S*?token=)[^\s&]+/giu, "$1[redacted]")
    .replaceAll(/(Token:\s*)\S+/gu, "$1[redacted]")
    .replaceAll(/([#?&]token=)[^\s&]+/giu, "$1[redacted]");

const waitForChildExit = (
  child: NodeChildProcess.ChildProcess,
  timeoutMs: number,
): Promise<boolean> =>
  new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (exited: boolean) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(exited);
    };
    child.once("exit", () => finish(true));
    if (child.exitCode !== null || child.signalCode !== null) {
      finish(true);
      return;
    }
    timer = setTimeout(() => finish(false), timeoutMs);
  });

const stopCapturedChild = async (child: NodeChildProcess.ChildProcess): Promise<void> => {
  const kill = (signal: NodeJS.Signals) => {
    try {
      child.kill(signal);
    } catch {
      // The captured child may have exited between the state check and kill.
    }
  };
  if (child.exitCode === null && child.signalCode === null) {
    kill("SIGTERM");
  }
  if (await waitForChildExit(child, 5_000)) return;
  // This is still the PID captured at spawn; never search-and-kill by name.
  if (child.exitCode === null && child.signalCode === null) {
    kill("SIGKILL");
  }
  if (!(await waitForChildExit(child, 5_000))) {
    throw new Error("Captured child did not exit after SIGKILL.");
  }
};

const stopServer = async (server: ServerChild): Promise<void> => stopCapturedChild(server.process);

const findFreePort = async (): Promise<number> => {
  const socket = NodeNet.createServer();
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      socket.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      socket.removeListener("error", onError);
      resolve();
    };
    socket.once("error", onError);
    socket.once("listening", onListening);
    socket.listen(0, "127.0.0.1");
  });
  const address = socket.address();
  if (address === null || typeof address === "string") {
    socket.close();
    throw new Error("Could not reserve a local test port.");
  }
  const port = address.port;
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  return port;
};

const spawnServer = async (input: {
  readonly baseDir: string;
  readonly projectDir?: string;
  readonly port: number;
  readonly preset: "full" | "controller" | "headless";
  readonly scriptPath: string;
}): Promise<ServerChild> => {
  const env = { ...process.env };
  delete env.T3CODE_HOME;
  env.T3_CODEX_COLLAB_SCRIPT = input.scriptPath;
  const child = NodeChildProcess.spawn(
    "node",
    [
      "apps/server/src/bin.ts",
      "serve",
      "--host",
      "127.0.0.1",
      "--port",
      String(input.port),
      "--base-dir",
      input.baseDir,
      "--jarvis-node-preset",
      input.preset,
      "--no-browser",
      "--log-level",
      "error",
      ...(input.projectDir === undefined ? [] : [input.projectDir]),
    ],
    {
      cwd: REPO_ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const pid = child.pid;
  if (pid === undefined) {
    await stopCapturedChild(child);
    throw new Error("Production server child did not expose a PID.");
  }

  let output = "";
  const append = (chunk: Buffer) => {
    output = `${output}${chunk.toString()}`.slice(-100_000);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  const pairingUrl = await new Promise<string>((resolve, reject) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout>;
    const finishFailure = (detail: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      void stopCapturedChild(child).then(
        () => reject(new Error(redactOutput(detail))),
        (cleanupError) =>
          reject(
            new Error(
              redactOutput(
                `${detail}\nCleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
              ),
            ),
          ),
      );
    };
    timeout = setTimeout(
      () => finishFailure(`Timed out waiting for server ${input.preset} to start:\n${output}`),
      45_000,
    );
    const inspect = () => {
      if (settled) return;
      const match = output.match(/Pairing URL:\s*(\S+)/u);
      if (match?.[1] !== undefined) {
        settled = true;
        clearTimeout(timeout);
        resolve(match[1]);
      }
    };
    child.stdout?.on("data", inspect);
    child.stderr?.on("data", inspect);
    child.once("exit", (code, signal) => {
      finishFailure(`Production server exited before startup (${code ?? signal}):\n${output}`);
    });
    child.once("error", (error) =>
      finishFailure(`Production server failed before startup: ${error.message}\n${output}`),
    );
  });

  return {
    process: child,
    pid,
    baseDir: input.baseDir,
    projectDir: input.projectDir ?? input.baseDir,
    port: input.port,
    preset: input.preset,
    pairingUrl,
    output: () => output,
  };
};

const spawnServerWithRetry = async (input: {
  readonly baseDir: string;
  readonly projectDir?: string;
  readonly preset: "full" | "controller" | "headless";
  readonly scriptPath: string;
}): Promise<ServerChild> => {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const port = await findFreePort();
    try {
      return await spawnServer({ ...input, port });
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (!/EADDRINUSE|address already in use/iu.test(message) || attempt === 2) {
        throw error;
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
};

const runProjectAdd = async (input: {
  readonly baseDir: string;
  readonly projectDir: string;
  readonly title?: string;
}): Promise<void> => {
  const env = { ...process.env };
  delete env.T3CODE_HOME;
  const child = NodeChildProcess.spawn(
    "node",
    [
      "apps/server/src/bin.ts",
      "project",
      "add",
      "--base-dir",
      input.baseDir,
      "--title",
      input.title ?? "Two Node Proof",
      input.projectDir,
    ],
    { cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  if (child.pid === undefined) {
    await stopCapturedChild(child);
    throw new Error("Project CLI child did not expose a PID.");
  }
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString()));
  const outcome = await new Promise<
    | {
        readonly _tag: "exit";
        readonly code: number | null;
        readonly signal: NodeJS.Signals | null;
      }
    | { readonly _tag: "error"; readonly error: Error }
    | { readonly _tag: "timeout" }
  >((resolve) => {
    let settled = false;
    const finish = (
      value:
        | {
            readonly _tag: "exit";
            readonly code: number | null;
            readonly signal: NodeJS.Signals | null;
          }
        | { readonly _tag: "error"; readonly error: Error }
        | { readonly _tag: "timeout" },
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(value);
    };
    const timeout = setTimeout(() => finish({ _tag: "timeout" }), 30_000);
    child.once("exit", (code, signal) => finish({ _tag: "exit", code, signal }));
    child.once("error", (error) => finish({ _tag: "error", error }));
  });
  if (outcome._tag !== "exit" || outcome.code !== 0) {
    const detail =
      outcome._tag === "timeout"
        ? `Timed out adding the project:\n${output}`
        : outcome._tag === "error"
          ? `Project CLI failed to start: ${outcome.error.message}\n${output}`
          : `Project CLI failed (${outcome.code ?? outcome.signal}):\n${output}`;
    try {
      await stopCapturedChild(child);
    } catch (cleanupError) {
      throw new Error(
        redactOutput(
          `${detail}\nCleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
        ),
        { cause: cleanupError },
      );
    }
    throw new Error(redactOutput(detail));
  }
};

const makeClientLayer = () => {
  const targets = new Map<EnvironmentId, ConnectionTarget>();
  const profiles = new Map<string, ConnectionProfile>();
  const credentials = new Map<string, ConnectionCredential>();
  const remoteTokens = new Map<EnvironmentId, TokenStore.RemoteDpopAccessToken>();

  const targetStore = Persistence.ConnectionTargetStore.of({
    list: Effect.sync(() => [...targets.values()]),
  });
  const registrationStore = Persistence.ConnectionRegistrationStore.of({
    register: (registration: ConnectionRegistration) =>
      Effect.sync(() => {
        targets.set(registration.target.environmentId, registration.target);
        if (registration._tag === "BearerConnectionRegistration") {
          profiles.set(registration.profile.connectionId, registration.profile);
          credentials.set(registration.target.connectionId, registration.credential);
        }
      }),
    remove: (target) =>
      Effect.sync(() => {
        targets.delete(target.environmentId);
        if (target._tag === "BearerConnectionTarget") {
          profiles.delete(target.connectionId);
          credentials.delete(target.connectionId);
        }
      }),
  });
  const profileStore = ConnectionProfileStore.ConnectionProfileStore.of({
    get: (connectionId) => Effect.succeed(Option.fromUndefinedOr(profiles.get(connectionId))),
    put: (profile) => Effect.sync(() => void profiles.set(profile.connectionId, profile)),
    remove: (connectionId) => Effect.sync(() => void profiles.delete(connectionId)),
  });
  const credentialStore = ConnectionCredentialStore.ConnectionCredentialStore.of({
    get: (connectionId) => Effect.succeed(Option.fromUndefinedOr(credentials.get(connectionId))),
    put: (connectionId, credential) =>
      Effect.sync(() => void credentials.set(connectionId, credential)),
    remove: (connectionId) => Effect.sync(() => void credentials.delete(connectionId)),
  });
  const cache = Persistence.EnvironmentCacheStore.of({
    loadShell: () => Effect.succeed(Option.none()),
    saveShell: () => Effect.void,
    loadThread: () => Effect.succeed(Option.none()),
    saveThread: () => Effect.void,
    removeThread: () => Effect.void,
    loadServerConfig: () => Effect.succeed(Option.none()),
    saveServerConfig: () => Effect.void,
    loadVcsRefs: () => Effect.succeed(Option.none()),
    saveVcsRefs: () => Effect.void,
    removeVcsRefs: () => Effect.void,
    clearVcsRefs: () => Effect.void,
    clear: () => Effect.void,
  });
  const connectivity = Connectivity.Connectivity.of({
    status: Effect.succeed("online" as const),
    changes: Stream.never,
  });
  const wakeups = ConnectionWakeups.ConnectionWakeups.of({ changes: Stream.never });
  const ssh = ClientCapabilities.SshEnvironmentGateway.of({
    provision: () => Effect.die("SSH is outside this proof."),
    prepare: () => Effect.die("SSH is outside this proof."),
    disconnect: () => Effect.void,
  });
  const presentation = ClientCapabilities.ClientPresentation.of({
    metadata: { label: "Jarvis two-node proof", deviceType: "desktop", os: "linux" },
    scopes: AuthStandardClientScopes,
  });
  const primaryAuth = ClientCapabilities.PrimaryEnvironmentAuth.of({
    bearerToken: Effect.succeed(Option.none()),
  });
  const cloudSession = ClientCapabilities.CloudSession.of({
    clerkToken: Effect.succeed("unused"),
  });
  const relayIdentity = ClientCapabilities.RelayDeviceIdentity.of({
    deviceId: Effect.succeed(Option.none()),
  });
  const tokenStore = TokenStore.RemoteDpopAccessTokenStore.of({
    get: (environmentId) => Effect.succeed(Option.fromUndefinedOr(remoteTokens.get(environmentId))),
    put: (token) => Effect.sync(() => void remoteTokens.set(token.environmentId, token)),
    remove: (environmentId) => Effect.sync(() => void remoteTokens.delete(environmentId)),
  });
  const signer = ManagedRelay.ManagedRelayDpopSigner.of({
    thumbprint: Effect.succeed("unused"),
    createProof: () => Effect.succeed("unused"),
  });
  const unavailable = () => Effect.die("Relay is outside this proof.");
  const relay = ManagedRelay.ManagedRelayClient.of({
    relayUrl: "https://relay.invalid",
    listEnvironments: unavailable,
    listDevices: unavailable,
    createEnvironmentLinkChallenge: unavailable,
    linkEnvironment: unavailable,
    unlinkEnvironment: unavailable,
    getEnvironmentStatus: unavailable,
    connectEnvironment: unavailable,
    registerDevice: unavailable,
    unregisterDevice: unavailable,
    registerLiveActivity: unavailable,
    getAgentActivitySnapshot: unavailable,
    resetTokenCache: Effect.void,
  });
  const http = remoteHttpClientLayer(localFetch);
  const remoteAuthorization = RemoteAuthorization.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        http,
        Layer.succeed(ClientCapabilities.ClientPresentation, presentation),
        Layer.succeed(TokenStore.RemoteDpopAccessTokenStore, tokenStore),
        Layer.succeed(ManagedRelay.ManagedRelayDpopSigner, signer),
      ),
    ),
  );
  const resolver = ConnectionResolver.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        remoteAuthorization,
        Layer.succeed(ClientCapabilities.ClientPresentation, presentation),
        Layer.succeed(ConnectionProfileStore.ConnectionProfileStore, profileStore),
        Layer.succeed(ConnectionCredentialStore.ConnectionCredentialStore, credentialStore),
        Layer.succeed(ManagedRelay.ManagedRelayClient, relay),
        Layer.succeed(ClientCapabilities.CloudSession, cloudSession),
        Layer.succeed(ClientCapabilities.RelayDeviceIdentity, relayIdentity),
        Layer.succeed(ClientCapabilities.PrimaryEnvironmentAuth, primaryAuth),
        Layer.succeed(ClientCapabilities.SshEnvironmentGateway, ssh),
      ),
    ),
  );
  const webSocketConstructor = Layer.succeed(
    Socket.WebSocketConstructor,
    (url: string, protocols?: string | string[]) =>
      new NodeSocket.NodeWS.WebSocket(url, protocols) as unknown as globalThis.WebSocket,
  );
  const rpcSession = RpcSession.layer.pipe(Layer.provide(webSocketConstructor));
  const driver = ConnectionDriver.layer.pipe(Layer.provide(Layer.mergeAll(resolver, rpcSession)));
  const registry = EnvironmentRegistry.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        driver,
        Layer.succeed(Persistence.ConnectionTargetStore, targetStore),
        Layer.succeed(Persistence.ConnectionRegistrationStore, registrationStore),
        Layer.succeed(Persistence.EnvironmentCacheStore, cache),
        Layer.succeed(Persistence.EnvironmentOwnedDataCleanup, {
          clear: () => Effect.void,
        }),
        Layer.succeed(ConnectionProfileStore.ConnectionProfileStore, profileStore),
        Layer.succeed(ConnectionCredentialStore.ConnectionCredentialStore, credentialStore),
        Layer.succeed(Connectivity.Connectivity, connectivity),
        Layer.succeed(ConnectionWakeups.ConnectionWakeups, wakeups),
        Layer.succeed(ClientCapabilities.SshEnvironmentGateway, ssh),
      ),
    ),
  );
  return JarvisMeshModule.layer.pipe(Layer.provideMerge(registry));
};

const connected = (
  registry: EnvironmentRegistry.EnvironmentRegistry["Service"],
  environmentId: EnvironmentId,
) =>
  registry
    .runStream(
      environmentId,
      Stream.unwrap(
        EnvironmentSupervisor.EnvironmentSupervisor.pipe(
          Effect.map((supervisor) => SubscriptionRef.changes(supervisor.state)),
        ),
      ),
    )
    .pipe(
      Stream.filter((state) => state.phase === "connected"),
      Stream.runHead,
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(new Error("Connection ended.")),
          onSome: Effect.succeed,
        }),
      ),
      Effect.timeout("45 seconds"),
    );

const nextReport = (
  registry: EnvironmentRegistry.EnvironmentRegistry["Service"],
  nodeId: EnvironmentId,
  ready: Deferred.Deferred<void>,
  originInteractionId: string,
) =>
  registry
    .runStream(
      nodeId,
      Stream.unwrap(
        Effect.gen(function* () {
          const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
          const session = yield* SubscriptionRef.get(supervisor.session);
          if (Option.isNone(session)) {
            return yield* Effect.fail(new Error("Connection has no active RPC session."));
          }
          const subscription = session.value.client[WS_METHODS.subscribeJarvisReportInbox]({
            originInteractionId,
          });
          yield* Deferred.succeed(ready, undefined);
          return subscription;
        }),
      ),
    )
    .pipe(
      Stream.filter((batch) => batch.deliveries.length > 0),
      Stream.map((batch) => batch.deliveries[0]!),
      Stream.runHead,
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(new Error("Jarvis report stream ended before a report.")),
          onSome: Effect.succeed,
        }),
      ),
      Effect.timeout("10 seconds"),
    );

const projectForNode = (
  projects: ReadonlyArray<JarvisMeshModule.JarvisMeshProject>,
  nodeId: EnvironmentId,
) => {
  const project = projects.find((candidate) => candidate.ref.nodeId === nodeId);
  if (project === undefined) throw new Error(`No project was catalogued for node ${nodeId}.`);
  return project;
};

describe("Jarvis multi-node client mesh", () => {
  it("routes every remote direction through real nodes and returns origin-scoped reports", async () => {
    const root = await NodeFSP.mkdtemp(
      NodePath.join(process.env.TMPDIR ?? "/tmp", "t3-three-node-proof-"),
    );
    const servers: ServerChild[] = [];
    try {
      const wire = JSON.parse(await NodeFSP.readFile(CODEX_WIRE, "utf8")) as {
        readonly rootThreadId: string;
      };
      const nodeSpecs = [
        { key: "desktop", preset: "full" as const, hasProject: true },
        // Laptop remains Full so the proof keeps its existing bidirectional
        // Full coverage while Controller gets its own explicit origin path.
        { key: "laptop", preset: "full" as const, hasProject: true },
        { key: "vps", preset: "headless" as const, hasProject: true },
        // Controller owns the interaction origin but deliberately has no
        // project/provider state; execution must remain on a qualified node.
        { key: "controller", preset: "controller" as const, hasProject: false },
      ];
      const nodes = new Map<string, ServerChild>();
      for (const spec of nodeSpecs) {
        const baseDir = NodePath.join(root, `node-${spec.key}`);
        const projectDir = NodePath.join(root, `project-${spec.key}`);
        const codexHome = NodePath.join(root, `codex-home-${spec.key}`);
        const scriptPath = NodePath.join(root, `codex-script-${spec.key}.json`);
        await NodeFSP.mkdir(NodePath.join(baseDir, "userdata"), { recursive: true });
        await NodeFSP.mkdir(projectDir, { recursive: true });
        await NodeFSP.writeFile(NodePath.join(projectDir, "README.md"), `three-node ${spec.key}\n`);
        await NodeFSP.writeFile(
          scriptPath,
          JSON.stringify({
            rootThreadId: wire.rootThreadId,
            resumeThreadId: wire.rootThreadId,
            notifications: [],
            persistTurnStartCount: true,
            resultText: `three-node fake provider result from ${spec.key}`,
            writeFileOnTurn: {
              turnIndex: 0,
              path: "REMOTE_MUTATION.md",
              contents: `written by deterministic ${spec.key} provider\n`,
            },
            turnIds: [
              "019fcfd6-1806-7de1-8564-de69fd55bffb",
              "019fcfd6-1806-7de1-8564-de69fd55bffc",
              "019fcfd6-1806-7de1-8564-de69fd55bffd",
              "019fcfd6-1806-7de1-8564-de69fd55bffe",
            ],
          }),
        );
        if (spec.hasProject) {
          await NodeFSP.writeFile(
            NodePath.join(baseDir, "userdata", "settings.json"),
            JSON.stringify({
              providers: {
                codex: {
                  enabled: true,
                  binaryPath: CODEX_PEER,
                  homePath: codexHome,
                  customModels: ["gpt-5.6-luna"],
                },
              },
            }),
          );
        }
        if (spec.hasProject) {
          await runProjectAdd({
            baseDir,
            projectDir,
            title: `Three Node ${spec.key}`,
          });
        }
        const server = await spawnServerWithRetry({
          baseDir,
          ...(spec.hasProject ? { projectDir } : {}),
          preset: spec.preset,
          scriptPath,
        });
        servers.push(server);
        nodes.set(spec.key, server);
      }
      expect(nodes).toHaveLength(4);
      expect(new Set([...nodes.values()].map((server) => server.port)).size).toBe(4);

      const clientLayer = makeClientLayer();
      const proof = Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        const mesh = yield* JarvisMeshModule.JarvisMesh;
        yield* registry.start;
        const http = remoteHttpClientLayer(localFetch);
        const presentation = Layer.succeed(
          ClientCapabilities.ClientPresentation,
          ClientCapabilities.ClientPresentation.of({
            metadata: { label: "Jarvis multi-node proof", deviceType: "desktop", os: "linux" },
            scopes: AuthStandardClientScopes,
          }),
        );
        const register = (pairingUrl: string) =>
          preparePairingRegistration({ pairingUrl }).pipe(
            Effect.provide(Layer.mergeAll(http, presentation)),
            Effect.flatMap((registration) =>
              registry.register(registration).pipe(Effect.as(registration.target.environmentId)),
            ),
          );
        const nodeIds = new Map<string, EnvironmentId>();
        for (const spec of nodeSpecs) {
          nodeIds.set(spec.key, yield* register(nodes.get(spec.key)!.pairingUrl));
        }
        for (const nodeId of nodeIds.values()) {
          yield* connected(registry, nodeId);
        }

        const catalog = yield* mesh.refresh;
        expect(catalog.nodes).toHaveLength(4);
        expect(catalog.nodes.filter((node) => node.capabilities?.preset === "full")).toHaveLength(
          2,
        );
        expect(catalog.nodes.find((node) => node.capabilities?.preset === "headless")?.nodeId).toBe(
          nodeIds.get("vps"),
        );
        expect(
          catalog.nodes.find((node) => node.capabilities?.preset === "controller")?.nodeId,
        ).toBe(nodeIds.get("controller"));

        const controllerNodeId = nodeIds.get("controller")!;
        const controllerExecutionError = yield* mesh
          .execute({
            projectRef: {
              nodeId: controllerNodeId,
              projectId: ProjectId.make("controller-project"),
            },
            requestMetadata: { requestId: "controller-local-execution" },
            utterance: "Run this locally on the controller.",
          })
          .pipe(Effect.flip);
        expect(controllerExecutionError).toMatchObject({
          nodeId: controllerNodeId,
          preset: "controller",
        });

        const runDirection = (input: {
          readonly name: string;
          readonly origin: string;
          readonly execution: string;
          readonly followUp?: boolean;
        }) =>
          Effect.gen(function* () {
            const originNodeId = nodeIds.get(input.origin)!;
            const executionNodeId = nodeIds.get(input.execution)!;
            const executionProject = projectForNode(catalog.projects, executionNodeId);
            const originInteractionId = `three-node-proof-${input.name}`;
            const reportReady = yield* Deferred.make<void>();
            const reportFiber = yield* nextReport(
              registry,
              executionNodeId,
              reportReady,
              originInteractionId,
            ).pipe(Effect.forkScoped);
            yield* Deferred.await(reportReady).pipe(Effect.timeout("5 seconds"));
            const first = yield* mesh.execute({
              projectRef: executionProject.ref,
              utterance: `Use Codex to complete the ${input.name} remote task`,
              requestMetadata: {
                requestId: `${originInteractionId}-first`,
                origin: { originNodeId, originInteractionId },
              },
            });
            expect(first.status).toBe("started");
            if (first.status !== "started" || first.taskRef === undefined) {
              return yield* Effect.fail(
                new Error(`Expected a started routed task: ${JSON.stringify(first)}`),
              );
            }
            expect(first.taskRef.executionNodeId).toBe(executionNodeId);
            expect(first.taskRef.projectId).toBe(executionProject.ref.projectId);
            expect(first.taskRef.providerId).toBe("codex");
            expect(first.requestMetadata?.origin?.originNodeId).toBe(originNodeId);
            const firstDelivery = (yield* Fiber.join(reportFiber)) as JarvisVoiceReportDelivery;
            const firstReport = firstDelivery.report;
            expect(firstReport.kind).toBe("completed");
            expect(firstReport.taskRef?.executionNodeId).toBe(executionNodeId);
            expect(firstReport.taskRef?.projectId).toBe(executionProject.ref.projectId);
            expect(firstReport.taskRef?.providerId).toBe("codex");
            expect(firstReport.origin?.originNodeId).toBe(originNodeId);
            expect(firstReport.text).toContain(
              `three-node fake provider result from ${input.execution}`,
            );
            yield* mesh.acknowledgeReport({
              nodeId: executionNodeId,
              input: { throughSequence: firstDelivery.sequence, originInteractionId },
            });
            const mutation = yield* Effect.promise(() =>
              NodeFSP.readFile(
                NodePath.join(nodes.get(input.execution)!.projectDir, "REMOTE_MUTATION.md"),
                "utf8",
              ),
            );
            expect(mutation).toBe(`written by deterministic ${input.execution} provider\n`);

            if (input.followUp === true) {
              const followUpReady = yield* Deferred.make<void>();
              const followUpFiber = yield* nextReport(
                registry,
                executionNodeId,
                followUpReady,
                originInteractionId,
              ).pipe(Effect.forkScoped);
              yield* Deferred.await(followUpReady).pipe(Effect.timeout("5 seconds"));
              const followUp = yield* mesh.execute({
                projectRef: executionProject.ref,
                contextThreadId: first.threadId,
                referenceThreadId: first.threadId,
                continueContext: true,
                utterance: "Continue with the same remote task",
                requestMetadata: {
                  requestId: `${originInteractionId}-follow-up`,
                  origin: { originNodeId, originInteractionId },
                },
              });
              expect(followUp.status).toBe("started");
              if (followUp.status !== "started") {
                return yield* Effect.fail(
                  new Error(`Expected a started follow-up: ${JSON.stringify(followUp)}`),
                );
              }
              expect(followUp.threadId).toBe(first.threadId);
              expect(followUp.taskRef?.executionNodeId).toBe(executionNodeId);
              expect(followUp.taskRef?.remoteThreadId).toBe(first.taskRef.remoteThreadId);
              const followUpReport = (yield* Fiber.join(
                followUpFiber,
              )) as JarvisVoiceReportDelivery;
              expect(followUpReport.report.kind).toBe("completed");
              expect(followUpReport.report.taskRef?.remoteThreadId).toBe(
                first.taskRef.remoteThreadId,
              );
              expect(followUpReport.report.origin?.originNodeId).toBe(originNodeId);
              yield* mesh.acknowledgeReport({
                nodeId: executionNodeId,
                input: { throughSequence: followUpReport.sequence, originInteractionId },
              });
            }
          });

        yield* runDirection({
          name: "laptop-to-desktop",
          origin: "laptop",
          execution: "desktop",
          followUp: true,
        });
        yield* runDirection({ name: "desktop-to-laptop", origin: "desktop", execution: "laptop" });
        yield* runDirection({ name: "laptop-to-vps", origin: "laptop", execution: "vps" });
        yield* runDirection({ name: "desktop-to-vps", origin: "desktop", execution: "vps" });
        yield* runDirection({
          name: "controller-to-desktop",
          origin: "controller",
          execution: "desktop",
        });
        yield* runDirection({ name: "controller-to-vps", origin: "controller", execution: "vps" });
      }).pipe(Effect.scoped, Effect.provide(clientLayer));

      // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- The outer async scope owns real child-process startup and guaranteed teardown; it.effect cannot safely bracket that lifecycle.
      await Effect.runPromise(proof).catch((error) => {
        console.error(
          "multi-node server output",
          servers.map((server) => ({
            preset: server.preset,
            output: redactOutput(server.output()).slice(-4_000),
          })),
        );
        throw error;
      });
    } finally {
      for (const server of servers
        .filter((value): value is ServerChild => value !== undefined)
        .toReversed()) {
        await stopServer(server);
      }
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  }, 120_000);
});
