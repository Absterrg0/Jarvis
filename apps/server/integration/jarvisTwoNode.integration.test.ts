// @effect-diagnostics nodeBuiltinImport:off - This test intentionally starts real local child processes.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";

import * as NodeSocket from "@effect/platform-node/NodeSocket";
import {
  AuthStandardClientScopes,
  type EnvironmentId,
  type JarvisMeshProject,
  type JarvisVoiceReportDelivery,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Socket from "effect/unstable/socket/Socket";
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
import * as JarvisMeshModule from "../../../packages/client-runtime/src/jarvis/mesh.ts";
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

type ServerChild = {
  readonly process: NodeChildProcess.ChildProcess;
  readonly pid: number;
  readonly baseDir: string;
  readonly projectDir: string;
  readonly port: number;
  readonly preset: "full" | "headless";
  readonly pairingUrl: string;
  readonly output: () => string;
};

const waitForChildExit = (
  child: NodeChildProcess.ChildProcess,
  timeoutMs: number,
): Promise<boolean> =>
  new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(true);
      return;
    }
    let settled = false;
    const finish = (exited: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(exited);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", () => finish(true));
  });

const stopServer = async (server: ServerChild): Promise<void> => {
  if (server.process.exitCode !== null || server.process.signalCode !== null) return;
  server.process.kill("SIGTERM");
  if (await waitForChildExit(server.process, 5_000)) return;
  // This is still the PID captured at spawn; never search-and-kill by name.
  server.process.kill("SIGKILL");
  await waitForChildExit(server.process, 5_000);
};

const findFreePort = async (): Promise<number> => {
  const socket = NodeNet.createServer();
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", () => resolve());
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
  readonly projectDir: string;
  readonly port: number;
  readonly preset: "full" | "headless";
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
      "debug",
      input.projectDir,
    ],
    {
      cwd: REPO_ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (child.pid === undefined) throw new Error("Production server child did not expose a PID.");

  let output = "";
  const append = (chunk: Buffer) => {
    output = `${output}${chunk.toString()}`.slice(-100_000);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  const pairingUrl = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Timed out waiting for server ${input.preset} to start:\n${output}`)),
      45_000,
    );
    const inspect = () => {
      const match = output.match(/Pairing URL:\s*(\S+)/u);
      if (match?.[1] !== undefined) {
        clearTimeout(timeout);
        resolve(match[1]);
      }
    };
    child.stdout?.on("data", inspect);
    child.stderr?.on("data", inspect);
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`Production server exited before startup (${code ?? signal}):\n${output}`));
    });
  });

  return {
    process: child,
    pid: child.pid,
    baseDir: input.baseDir,
    projectDir: input.projectDir,
    port: input.port,
    preset: input.preset,
    pairingUrl,
    output: () => output,
  };
};

const runProjectAdd = async (input: {
  readonly baseDir: string;
  readonly projectDir: string;
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
      "Two Node Proof",
      input.projectDir,
    ],
    { cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  if (child.pid === undefined) throw new Error("Project CLI child did not expose a PID.");
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString()));
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Timed out adding the project:\n${output}`));
    }, 30_000);
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(`Project CLI failed (${code ?? signal}):\n${output}`));
    });
  });
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
  const http = remoteHttpClientLayer((input, init) => globalThis.fetch(input, init));
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
  Effect.gen(function* () {
    const current = yield* registry.state(environmentId);
    if (current.phase === "connected") return;
    yield* registry.stateChanges(environmentId).pipe(
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
  });

const nextReport = (
  registry: EnvironmentRegistry.EnvironmentRegistry["Service"],
  nodeId: EnvironmentId,
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
          return session.value.client[WS_METHODS.subscribeJarvisReportInbox]({
            originInteractionId: "two-node-proof-origin",
          });
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

const projectForNode = (projects: ReadonlyArray<JarvisMeshProject>, nodeId: EnvironmentId) => {
  const project = projects.find((candidate) => candidate.ref.nodeId === nodeId);
  if (project === undefined) throw new Error(`No project was catalogued for node ${nodeId}.`);
  return project;
};

describe("Jarvis two-node production transport", () => {
  it("routes a real Full-origin task to a Headless execution node and keeps its thread", async () => {
    const root = await NodeFSP.mkdtemp(
      NodePath.join(process.env.TMPDIR ?? "/tmp", "t3-two-node-proof-"),
    );
    const servers: ServerChild[] = [];
    try {
      const wire = JSON.parse(await NodeFSP.readFile(CODEX_WIRE, "utf8")) as {
        readonly rootThreadId: string;
      };
      const scriptPath = NodePath.join(root, "codex-script.json");
      await NodeFSP.writeFile(
        scriptPath,
        JSON.stringify({
          rootThreadId: wire.rootThreadId,
          notifications: [],
          persistTurnStartCount: true,
          resultText: "two-node fake provider result",
          turnIds: ["019fcfd6-1806-7de1-8564-de69fd55bffb", "019fcfd6-1806-7de1-8564-de69fd55bffc"],
        }),
      );

      const nodes = await Promise.all(
        (["full", "headless"] as const).map(async (preset, index) => {
          const baseDir = NodePath.join(root, `node-${preset}`);
          const projectDir = NodePath.join(root, `project-${preset}`);
          const codexHome = NodePath.join(root, `codex-home-${preset}`);
          await NodeFSP.mkdir(NodePath.join(baseDir, "userdata"), { recursive: true });
          await NodeFSP.mkdir(projectDir, { recursive: true });
          await NodeFSP.writeFile(NodePath.join(projectDir, "README.md"), `two-node ${preset}\n`);
          await NodeFSP.writeFile(
            NodePath.join(baseDir, "userdata", "settings.json"),
            JSON.stringify({
              providers: {
                codex: {
                  enabled: true,
                  binaryPath: CODEX_PEER,
                  homePath: codexHome,
                  customModels: ["gpt-5.6-sol"],
                },
              },
            }),
          );
          await runProjectAdd({ baseDir, projectDir });
          return spawnServer({
            baseDir,
            projectDir,
            port: await findFreePort(),
            preset,
            scriptPath,
          }).then((server) => {
            servers[index] = server;
            return server;
          });
        }),
      );
      expect(nodes.map((server) => server.port)).toHaveLength(2);
      expect(nodes[0]?.port).not.toBe(nodes[1]?.port);

      const clientLayer = makeClientLayer();
      const proof = Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        const mesh = yield* JarvisMeshModule.JarvisMesh;
        yield* registry.start;
        const http = remoteHttpClientLayer((input, init) => globalThis.fetch(input, init));
        const presentation = Layer.succeed(
          ClientCapabilities.ClientPresentation,
          ClientCapabilities.ClientPresentation.of({
            metadata: { label: "Jarvis two-node proof", deviceType: "desktop", os: "linux" },
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
        const originNodeId = yield* register(nodes[0]!.pairingUrl);
        const executionNodeId = yield* register(nodes[1]!.pairingUrl);
        yield* connected(registry, originNodeId);
        yield* connected(registry, executionNodeId);

        const catalog = yield* mesh.refresh;
        expect(catalog.nodes).toHaveLength(2);
        expect(catalog.nodes.find((node) => node.capabilities?.preset === "full")?.nodeId).toBe(
          originNodeId,
        );
        expect(catalog.nodes.find((node) => node.capabilities?.preset === "headless")?.nodeId).toBe(
          executionNodeId,
        );
        expect(yield* mesh.resolveProject("Two Node Proof")).toEqual({
          status: "needs-clarification",
          candidates: expect.arrayContaining([
            expect.objectContaining({ ref: expect.objectContaining({ nodeId: originNodeId }) }),
            expect.objectContaining({ ref: expect.objectContaining({ nodeId: executionNodeId }) }),
          ]),
        });

        const executionProject = projectForNode(catalog.projects, executionNodeId);
        const reportFiber = yield* nextReport(registry, executionNodeId).pipe(Effect.forkScoped);
        const first = yield* mesh.execute({
          projectRef: executionProject.ref,
          utterance: "Use Codex to report the real two-node result",
          requestMetadata: {
            requestId: "two-node-proof-first",
            origin: { originNodeId, originInteractionId: "two-node-proof-origin" },
          },
        });
        expect(first.status).toBe("started");
        if (first.status !== "started" || first.taskRef === undefined) {
          return yield* Effect.fail(
            new Error(`Expected a started routed task: ${JSON.stringify(first)}`),
          );
        }
        expect(first.taskRef.executionNodeId).toBe(executionNodeId);
        expect(first.requestMetadata?.origin?.originNodeId).toBe(originNodeId);
        const firstDelivery = yield* Fiber.join(reportFiber) as JarvisVoiceReportDelivery;
        const firstReport = firstDelivery.report;
        expect(firstReport.kind).toBe("completed");
        expect(firstReport.taskRef?.executionNodeId).toBe(executionNodeId);
        expect(firstReport.origin?.originNodeId).toBe(originNodeId);
        expect(firstReport.text).toContain("two-node fake provider result");
        yield* mesh.acknowledgeReport({
          nodeId: executionNodeId,
          input: {
            throughSequence: firstDelivery.sequence,
            originInteractionId: "two-node-proof-origin",
          },
        });

        const secondReportFiber = yield* nextReport(registry, executionNodeId).pipe(
          Effect.forkScoped,
        );
        const second = yield* mesh.execute({
          projectRef: executionProject.ref,
          contextThreadId: first.threadId,
          referenceThreadId: first.threadId,
          continueContext: true,
          utterance: "Continue with the same remote task",
          requestMetadata: {
            requestId: "two-node-proof-follow-up",
            origin: { originNodeId, originInteractionId: "two-node-proof-origin" },
          },
        });
        expect(second.status).toBe("started");
        if (second.status !== "started") {
          return yield* Effect.fail(
            new Error(`Expected a started follow-up: ${JSON.stringify(second)}`),
          );
        }
        expect(second.threadId).toBe(first.threadId);
        expect(second.taskRef?.remoteThreadId).toBe(first.taskRef.remoteThreadId);
        const secondDelivery = yield* Fiber.join(secondReportFiber) as JarvisVoiceReportDelivery;
        const secondReport = secondDelivery.report;
        expect(secondReport.taskRef?.remoteThreadId).toBe(first.taskRef.remoteThreadId);
        expect(secondReport.origin?.originNodeId).toBe(originNodeId);
      }).pipe(Effect.scoped, Effect.provide(clientLayer));

      // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- The outer async scope owns real child-process startup and guaranteed teardown; it.effect cannot safely bracket that lifecycle.
      await Effect.runPromise(proof).catch((error) => {
        console.error(
          "two-node server output",
          servers.map((server) => ({
            preset: server.preset,
            output: server
              .output()
              .replaceAll(/(Pairing URL:\s*)\S+/gu, "$1[redacted]")
              .replaceAll(/([#?&]token=)[^\s&]+/gu, "$1[redacted]")
              .slice(-4_000),
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
