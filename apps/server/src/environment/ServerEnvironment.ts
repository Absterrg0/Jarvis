import {
  EnvironmentId,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  jarvisNodeCapabilitiesForPreset,
  type ExecutionEnvironmentDescriptor,
} from "@t3tools/contracts";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import packageJson from "../../package.json" with { type: "json" };
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { readAgentActivityPublishingActive } from "../cloud/config.ts";
import { resolveServerSelfUpdateCapability } from "../cloud/selfUpdate.ts";
import { resolveServiceLauncherMode } from "../cloud/serviceLauncherClient.ts";
import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import {
  normalizeServerEnvironmentLabel,
  persistServerEnvironmentLabel,
  readPersistedServerEnvironmentLabel,
  resolveServerEnvironmentLabel,
  ServerEnvironmentLabelFileError,
} from "./ServerEnvironmentLabel.ts";
import { detectServerEnvironmentMachineKind } from "./ServerEnvironmentMachine.ts";

export class ServerEnvironmentIdPersistenceError extends Schema.TaggedError<ServerEnvironmentIdPersistenceError>()(
  "ServerEnvironmentIdPersistenceError",
  {
    operation: Schema.Literals(["check", "read", "write", "initialize"]),
    environmentIdPath: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    if (this.operation === "initialize") {
      return `Server environment ID file is missing or empty after initialization at '${this.environmentIdPath}'.`;
    }
    return `Server environment ID ${this.operation} failed at '${this.environmentIdPath}'.`;
  }
}

export class ServerEnvironmentLabelValidationError extends Schema.TaggedError<ServerEnvironmentLabelValidationError>()(
  "ServerEnvironmentLabelValidationError",
  { label: Schema.String },
) {
  override get message(): string {
    return "Environment label must be 1–80 characters after trimming.";
  }
}

export class ServerEnvironment extends Context.Service<
  ServerEnvironment,
  {
    readonly getEnvironmentId: Effect.Effect<EnvironmentId>;
    readonly getDescriptor: Effect.Effect<ExecutionEnvironmentDescriptor>;
    readonly setLabel: (
      label: string,
    ) => Effect.Effect<
      ExecutionEnvironmentDescriptor,
      ServerEnvironmentLabelFileError | ServerEnvironmentLabelValidationError
    >;
  }
>()("t3/environment/ServerEnvironment") {}

export class ServerEnvironmentIdentity extends Context.Service<
  ServerEnvironmentIdentity,
  {
    readonly getEnvironmentId: Effect.Effect<EnvironmentId>;
  }
>()("t3/environment/ServerEnvironment/ServerEnvironmentIdentity") {}

function platformOs(platform: NodeJS.Platform): ExecutionEnvironmentDescriptor["platform"]["os"] {
  switch (platform) {
    case "darwin":
      return "darwin";
    case "linux":
      return "linux";
    case "win32":
      return "windows";
    default:
      return "unknown";
  }
}

function platformArch(
  architecture: NodeJS.Architecture,
): ExecutionEnvironmentDescriptor["platform"]["arch"] {
  switch (architecture) {
    case "arm64":
      return "arm64";
    case "x64":
      return "x64";
    default:
      return "other";
  }
}

const makeIdentity = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const crypto = yield* Crypto.Crypto;

  const readPersistedEnvironmentId = Effect.gen(function* () {
    const exists = yield* fileSystem.exists(serverConfig.environmentIdPath).pipe(
      Effect.mapError(
        (cause) =>
          new ServerEnvironmentIdPersistenceError({
            operation: "check",
            environmentIdPath: serverConfig.environmentIdPath,
            cause,
          }),
      ),
    );
    if (!exists) {
      return null;
    }

    const raw = yield* fileSystem.readFileString(serverConfig.environmentIdPath).pipe(
      Effect.map((value) => value.trim()),
      Effect.mapError(
        (cause) =>
          new ServerEnvironmentIdPersistenceError({
            operation: "read",
            environmentIdPath: serverConfig.environmentIdPath,
            cause,
          }),
      ),
    );

    return raw.length > 0 ? raw : null;
  });

  const persistEnvironmentId = Effect.fn("ServerEnvironmentIdentity.persistEnvironmentId")(
    function* (value: string, mode: "create" | "recover") {
      const destinationPath =
        mode === "recover"
          ? `${serverConfig.environmentIdPath}.recovery`
          : serverConfig.environmentIdPath;
      const tempPath = yield* fileSystem.makeTempFileScoped({
        directory: serverConfig.stateDir,
        prefix: ".environment-id-",
      });
      yield* fileSystem.writeFileString(tempPath, `${value}\n`);
      // Publish the completed file without replacing an ID created by another process.
      yield* fileSystem
        .link(tempPath, destinationPath)
        .pipe(
          Effect.catch((cause) =>
            cause.reason._tag === "AlreadyExists" ? Effect.void : Effect.fail(cause),
          ),
        );
      if (mode === "recover") {
        // Keep the recovery ID so delayed initializers also publish the same winner.
        yield* fileSystem.remove(tempPath);
        yield* fileSystem.copyFile(destinationPath, tempPath);
        yield* fileSystem.rename(tempPath, serverConfig.environmentIdPath);
      }
    },
    Effect.scoped,
    Effect.mapError(
      (cause) =>
        new ServerEnvironmentIdPersistenceError({
          operation: "write",
          environmentIdPath: serverConfig.environmentIdPath,
          cause,
        }),
    ),
  );

  const environmentIdRaw = yield* Effect.gen(function* () {
    const persisted = yield* readPersistedEnvironmentId;
    if (persisted) {
      return persisted;
    }

    const generated = yield* crypto.randomUUIDv4;
    yield* persistEnvironmentId(generated, "create");
    let winner = yield* readPersistedEnvironmentId;
    if (winner === null) {
      yield* persistEnvironmentId(generated, "recover");
      winner = yield* readPersistedEnvironmentId;
    }
    if (winner === null) {
      return yield* new ServerEnvironmentIdPersistenceError({
        operation: "initialize",
        environmentIdPath: serverConfig.environmentIdPath,
      });
    }
    return winner;
  });

  const environmentId = EnvironmentId.make(environmentIdRaw);
  return ServerEnvironmentIdentity.of({
    getEnvironmentId: Effect.succeed(environmentId),
  });
});

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const path = yield* Path.Path;
  const fileSystem = yield* FileSystem.FileSystem;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const identity = yield* ServerEnvironmentIdentity;
  const hostPlatform = yield* HostProcessPlatform;
  const hostArchitecture = yield* HostProcessArchitecture;
  const environmentId = yield* identity.getEnvironmentId;
  const cwdBaseName = path.basename(serverConfig.cwd).trim();
  const labelPath =
    serverConfig.nodeLabelPath ?? path.join(serverConfig.baseDir, "config", "node-label.txt");
  const persistedLabel = yield* readPersistedServerEnvironmentLabel(labelPath).pipe(
    Effect.catchTag("ServerEnvironmentLabelFileError", (error) =>
      Effect.logDebug(error.message).pipe(Effect.as(null)),
    ),
  );
  const label = persistedLabel ?? (yield* resolveServerEnvironmentLabel({ cwdBaseName }));
  const machine = yield* detectServerEnvironmentMachineKind();
  const launcher = yield* resolveServiceLauncherMode();
  const serverSelfUpdate = resolveServerSelfUpdateCapability({
    desktopManaged: serverConfig.mode === "desktop",
    launcherManaged: launcher.managed,
  });
  // Static is correct: the control fd is known at bootstrap, and the desktop
  // app and its bundled server ship in one artifact, so a present fd means
  // the app speaks the requestDesktopUpdate protocol. WSL backends never get
  // the fd and correctly do not advertise.
  const desktopAppUpdate =
    serverSelfUpdate === "desktop-managed" && serverConfig.desktopTelemetryControlFd !== undefined;
  const presetCapabilities = jarvisNodeCapabilitiesForPreset(
    serverConfig.jarvisNodePreset ?? "full",
  );

  const descriptor: ExecutionEnvironmentDescriptor = {
    environmentId,
    label,
    platform: {
      os: platformOs(hostPlatform),
      arch: platformArch(hostArchitecture),
      ...(machine === null ? {} : { machine }),
    },
    serverVersion: packageJson.version,
    capabilities: {
      repositoryIdentity: true,
      jarvisNode: {
        ...presetCapabilities,
      },
      connectionProbe: true,
      attachmentUploads: true,
      questionAttachments: true,
      fileAttachments: { maxUploadBytes: PROVIDER_SEND_TURN_MAX_FILE_BYTES },
      pullRequests: true,
      threadSettlement: true,
      threadAutoSettlement: true,
      threadRestartContinuation: true,
      threadSnooze: true,
      environmentThemes: true,
      usageLimitSources: true,
      usagePriceOverrides: true,
      threadPinning: true,
      threadPinReorder: true,
      threadActiveReorder: true,
      threadTitleRegeneration: true,
      threadPullRequests: true,
      pullRequestStackActions: true,
      threadPullRequestLinking: true,
      environmentIcon: true,
      ...(serverSelfUpdate === null ? {} : { serverSelfUpdate }),
      ...(serverSelfUpdate === "boot-service" || desktopAppUpdate
        ? {
            serverSelfUpdateProgress: true,
            serverUpdateThreadContinuation: true,
          }
        : {}),
      ...(desktopAppUpdate ? { desktopAppUpdate: true } : {}),
      ...(presetCapabilities.preset !== "headless" &&
      (hostPlatform === "linux" || hostPlatform === "darwin" || hostPlatform === "win32")
        ? { desktopUse: true }
        : {}),
    },
  };

  const descriptorRef = yield* Ref.make(descriptor);
  // The publish opt-in and relay link change at runtime (`t3 connect
  // publish`, the client settings toggle), so the capability is read per
  // descriptor request rather than baked in at startup.
  const readCurrentDescriptor = Effect.gen(function* () {
    const current = yield* Ref.get(descriptorRef);
    const agentActivityPublishing = yield* readAgentActivityPublishingActive(secrets);
    return {
      ...current,
      capabilities: { ...current.capabilities, agentActivityPublishing },
    };
  });
  const setLabel = Effect.fn("ServerEnvironment.setLabel")(function* (nextLabel: string) {
    const normalized = normalizeServerEnvironmentLabel(nextLabel);
    if (normalized === null) {
      return yield* new ServerEnvironmentLabelValidationError({ label: nextLabel });
    }
    yield* persistServerEnvironmentLabel(labelPath, normalized).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
    );
    yield* Ref.update(descriptorRef, (current) => ({
      ...current,
      label: normalized,
    }));
    // Return through the same capability-refresh path as getDescriptor so a
    // relabeled descriptor never drops the live publishing capability.
    return yield* readCurrentDescriptor;
  });

  return ServerEnvironment.of({
    getEnvironmentId: Effect.succeed(environmentId),
    getDescriptor: readCurrentDescriptor,
    setLabel,
  });
});

export const identityLayer = Layer.effect(ServerEnvironmentIdentity, makeIdentity);

/**
 * ServerEnvironment is acquired from persisted filesystem and host-process
 * state. It intentionally has no fallback Layer.succeed value: callers must
 * provide the external platform services, a ServerConfig, and the
 * ServerSecretStore backing the descriptor's publishing capability.
 */
export const layer = Layer.effect(ServerEnvironment, make).pipe(
  Layer.provideMerge(identityLayer),
  Layer.provide(ProcessRunner.layer),
);
