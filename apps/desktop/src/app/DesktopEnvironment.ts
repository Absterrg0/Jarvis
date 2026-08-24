// @effect-diagnostics nodeBuiltinImport:off - the install-layout probes run synchronously because this layer builds before Electron's ready event.
import * as NodeFS from "node:fs";
import type {
  DesktopAppBranding,
  DesktopAppStageLabel,
  DesktopRuntimeArch,
  DesktopRuntimeInfo,
} from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopConfig from "./DesktopConfig.ts";
import { resolveDesktopBaseDir, resolveDesktopStateDir } from "./DesktopStatePaths.ts";
import { isNightlyDesktopVersion } from "../updates/updateChannels.ts";

export interface MakeDesktopEnvironmentInput {
  readonly dirname: string;
  readonly homeDirectory: string;
  readonly platform: NodeJS.Platform;
  readonly processArch: string;
  readonly appVersion: string;
  readonly appPath: string;
  /** The explicit Electron executable path; process.execPath is the safe fallback for tests. */
  readonly executablePath?: string;
  readonly isPackaged: boolean;
  readonly resourcesPath: string;
  readonly runningUnderArm64Translation: boolean;
}

export const DESKTOP_DISTRIBUTIONS = ["unified-jarvis", "official-jarvis", "standalone"] as const;
export type DesktopDistribution = (typeof DESKTOP_DISTRIBUTIONS)[number];
export const JARVIS_OFFICIAL_RELEASE_MARKER_FILE = "jarvis-official-release.json";

/**
 * A unified Windows install keeps the Electron desktop payload below the
 * setup-owned root. The executable path and both filesystem markers are
 * required so a standalone Desktop build cannot accidentally opt out of its
 * own updater just because it happens to be named Jarvis.exe. Official
 * Linux/macOS releases use an explicit packaged marker instead.
 */
export function resolveDesktopDistribution(input: {
  readonly isPackaged: boolean;
  readonly executablePath: string;
  readonly rootManifestExists: boolean;
  readonly desktopExecutableExists: boolean;
  readonly officialJarvisMarkerExists: boolean;
  readonly path: Pick<Path.Path, "resolve" | "dirname" | "basename">;
}): DesktopDistribution {
  if (input.isPackaged && input.rootManifestExists && input.desktopExecutableExists) {
    const executablePath = input.path.resolve(input.executablePath);
    const desktopDirectory = input.path.dirname(executablePath);
    if (input.path.basename(desktopDirectory).toLowerCase() === "desktop") {
      return "unified-jarvis";
    }
  }

  return input.isPackaged && input.officialJarvisMarkerExists ? "official-jarvis" : "standalone";
}

export class DesktopEnvironment extends Context.Service<
  DesktopEnvironment,
  {
    readonly path: Path.Path;
    readonly dirname: string;
    readonly platform: NodeJS.Platform;
    readonly processArch: string;
    readonly isPackaged: boolean;
    readonly isDevelopment: boolean;
    readonly appVersion: string;
    readonly appPath: string;
    readonly executablePath: string;
    readonly resourcesPath: string;
    readonly distribution: DesktopDistribution;
    readonly homeDirectory: string;
    readonly appDataDirectory: string;
    readonly baseDir: string;
    readonly stateDir: string;
    readonly desktopSettingsPath: string;
    readonly clientSettingsPath: string;
    readonly savedEnvironmentRegistryPath: string;
    readonly serverSettingsPath: string;
    readonly logDir: string;
    readonly browserArtifactsDir: string;
    readonly rootDir: string;
    readonly appRoot: string;
    // Root of the tree containing apps/server/dist and node_modules for the
    // backend. Equals appRoot everywhere except packaged Windows, where the
    // server tree ships as the resources/server.asar sidecar (see
    // scripts/build-desktop-artifact.ts) that the asar-aware
    // ELECTRON_RUN_AS_NODE primary reads in place and the WSL backend
    // extracts on demand (see DesktopWslServerTree).
    readonly serverRoot: string;
    readonly backendEntryPath: string;
    readonly backendCwd: string;
    readonly preloadPath: string;
    readonly appUpdateYmlPath: string;
    readonly devServerUrl: Option.Option<URL>;
    readonly devRemoteT3ServerEntryPath: Option.Option<string>;
    readonly configuredBackendPort: Option.Option<number>;
    readonly commitHashOverride: Option.Option<string>;
    readonly otlpTracesUrl: Option.Option<string>;
    readonly otlpExportIntervalMs: number;
    readonly branding: DesktopAppBranding;
    readonly displayName: string;
    readonly appUserModelId: string;
    readonly linuxDesktopEntryName: string;
    readonly linuxWmClass: string;
    readonly linuxApplicationsDir: string;
    readonly appImagePath: Option.Option<string>;
    readonly userDataDirName: string;
    readonly legacyUserDataDirName: string;
    readonly defaultDesktopSettings: DesktopAppSettings.DesktopSettings;
    readonly runtimeInfo: DesktopRuntimeInfo;
    readonly resolvePickFolderDefaultPath: (rawOptions: unknown) => Option.Option<string>;
    readonly resolveResourcePathCandidates: (fileName: string) => readonly string[];
  }
>()("@t3tools/desktop/app/DesktopEnvironment") {}

const APP_BASE_NAME = "Jarvis";
const APP_RELEASE_TAG_BASE_URL = "https://github.com/Absterrg0/Jarvis/releases/tag";

function resolveDesktopAppStageLabel(input: {
  readonly isDevelopment: boolean;
  readonly appVersion: string;
}): DesktopAppStageLabel {
  if (input.isDevelopment) {
    return "Dev";
  }

  return isNightlyDesktopVersion(input.appVersion) ? "Nightly" : "Alpha";
}

function resolveDesktopAppBranding(input: {
  readonly isDevelopment: boolean;
  readonly appVersion: string;
}): DesktopAppBranding {
  const stageLabel = resolveDesktopAppStageLabel(input);
  return {
    baseName: APP_BASE_NAME,
    stageLabel,
    displayName: stageLabel === "Alpha" ? APP_BASE_NAME : `${APP_BASE_NAME} (${stageLabel})`,
    releaseTagBaseUrl: APP_RELEASE_TAG_BASE_URL,
  };
}

function normalizeDesktopArch(arch: string): DesktopRuntimeArch {
  if (arch === "arm64") return "arm64";
  if (arch === "x64") return "x64";
  return "other";
}

function resolveDesktopRuntimeInfo(input: {
  readonly platform: NodeJS.Platform;
  readonly processArch: string;
  readonly runningUnderArm64Translation: boolean;
}): DesktopRuntimeInfo {
  const appArch = normalizeDesktopArch(input.processArch);

  if (input.platform !== "darwin") {
    return {
      hostArch: appArch,
      appArch,
      runningUnderArm64Translation: false,
    };
  }

  const hostArch = appArch === "arm64" || input.runningUnderArm64Translation ? "arm64" : appArch;

  return {
    hostArch,
    appArch,
    runningUnderArm64Translation: input.runningUnderArm64Translation,
  };
}

const make = Effect.fn("desktop.environment.make")(function* (
  input: MakeDesktopEnvironmentInput,
): Effect.fn.Return<DesktopEnvironment["Service"], Config.ConfigError, Path.Path> {
  const path = yield* Path.Path;
  const config = yield* DesktopConfig.DesktopConfig;
  const homeDirectory = input.homeDirectory;
  const devServerUrl = config.devServerUrl;
  const isDevelopment = Option.isSome(devServerUrl);
  const appDataDirectory =
    input.platform === "win32"
      ? Option.getOrElse(config.appDataDirectory, () =>
          path.join(homeDirectory, "AppData", "Roaming"),
        )
      : input.platform === "darwin"
        ? path.join(homeDirectory, "Library", "Application Support")
        : Option.getOrElse(config.xdgConfigHome, () => path.join(homeDirectory, ".config"));
  const baseDir = resolveDesktopBaseDir({
    homeDirectory,
    joinPath: path.join,
    t3Home: config.t3Home,
  });
  const rootDir = path.resolve(input.dirname, "../../..");
  const appRoot = input.isPackaged ? input.appPath : rootDir;
  const executablePath = input.executablePath ?? process.execPath;
  const installRoot = path.dirname(path.dirname(path.resolve(executablePath)));
  // fs.existsSync swallows access errors (returns false), matching the
  // previous orElseSucceed(false) semantics without yielding to the event loop.
  const rootManifestExists = yield* Effect.sync(() =>
    NodeFS.existsSync(path.join(installRoot, "payload-manifest.json")),
  );
  const desktopExecutableExists = yield* Effect.sync(() =>
    NodeFS.existsSync(path.join(installRoot, "desktop", path.basename(executablePath))),
  );
  const officialJarvisMarkerExists = yield* Effect.sync(
    () =>
      input.isPackaged &&
      NodeFS.existsSync(path.join(input.resourcesPath, JARVIS_OFFICIAL_RELEASE_MARKER_FILE)),
  );
  const distribution = resolveDesktopDistribution({
    isPackaged: input.isPackaged,
    executablePath,
    rootManifestExists,
    desktopExecutableExists,
    officialJarvisMarkerExists,
    path,
  });
  const serverRoot =
    input.isPackaged && input.platform === "win32"
      ? path.join(input.resourcesPath, "server.asar")
      : appRoot;
  const branding = resolveDesktopAppBranding({
    isDevelopment,
    appVersion: input.appVersion,
  });
  const displayName = branding.displayName;
  const stateDir = resolveDesktopStateDir({
    baseDir,
    isDevelopment,
    joinPath: path.join,
    t3Home: config.t3Home,
  });
  const userDataDirName = isDevelopment ? "jarvis-dev" : "jarvis";
  const legacyUserDataDirName = isDevelopment ? "Jarvis (Dev)" : "Jarvis";
  const linuxApplicationsDir = path.join(
    Option.getOrElse(config.xdgDataHome, () => path.join(homeDirectory, ".local", "share")),
    "applications",
  );
  const resourcesPath = input.resourcesPath;

  return DesktopEnvironment.of({
    path,
    dirname: input.dirname,
    platform: input.platform,
    processArch: input.processArch,
    isPackaged: input.isPackaged,
    isDevelopment,
    appVersion: input.appVersion,
    appPath: input.appPath,
    executablePath,
    resourcesPath,
    distribution,
    homeDirectory,
    appDataDirectory,
    baseDir,
    stateDir,
    desktopSettingsPath: path.join(stateDir, "desktop-settings.json"),
    clientSettingsPath: path.join(stateDir, "client-settings.json"),
    savedEnvironmentRegistryPath: path.join(stateDir, "saved-environments.json"),
    serverSettingsPath: path.join(stateDir, "settings.json"),
    logDir: path.join(stateDir, "logs"),
    browserArtifactsDir: path.join(stateDir, "browser-artifacts"),
    rootDir,
    appRoot,
    serverRoot,
    backendEntryPath: path.join(serverRoot, "apps/server/dist/bin.mjs"),
    backendCwd: input.isPackaged ? homeDirectory : appRoot,
    preloadPath: path.join(input.dirname, "preload.cjs"),
    appUpdateYmlPath: input.isPackaged
      ? path.join(resourcesPath, "app-update.yml")
      : path.join(input.appPath, "dev-app-update.yml"),
    devServerUrl,
    devRemoteT3ServerEntryPath: config.devRemoteT3ServerEntryPath,
    configuredBackendPort: config.configuredBackendPort,
    commitHashOverride: config.commitHashOverride,
    otlpTracesUrl: config.otlpTracesUrl,
    otlpExportIntervalMs: config.otlpExportIntervalMs,
    branding,
    displayName,
    appUserModelId: Option.getOrElse(config.appUserModelIdOverride, () =>
      isDevelopment ? "com.abstergo.jarvis.dev" : "com.abstergo.jarvis",
    ),
    linuxDesktopEntryName: isDevelopment ? "jarvis-dev.desktop" : "jarvis.desktop",
    linuxWmClass: isDevelopment ? "jarvis-dev" : "jarvis",
    linuxApplicationsDir,
    appImagePath: config.appImagePath,
    userDataDirName,
    legacyUserDataDirName,
    defaultDesktopSettings: DesktopAppSettings.resolveDefaultDesktopSettings(input.appVersion),
    runtimeInfo: resolveDesktopRuntimeInfo({
      platform: input.platform,
      processArch: input.processArch,
      runningUnderArm64Translation: input.runningUnderArm64Translation,
    }),
    resolvePickFolderDefaultPath: (rawOptions) => {
      if (typeof rawOptions !== "object" || rawOptions === null) {
        return Option.none();
      }

      const { initialPath } = rawOptions as { initialPath?: unknown };
      if (typeof initialPath !== "string") {
        return Option.none();
      }

      const trimmedPath = initialPath.trim();
      if (trimmedPath.length === 0) {
        return Option.none();
      }

      if (trimmedPath === "~") {
        return Option.some(homeDirectory);
      }

      if (trimmedPath.startsWith("~/") || trimmedPath.startsWith("~\\")) {
        return Option.some(path.join(homeDirectory, trimmedPath.slice(2)));
      }

      return Option.some(path.resolve(trimmedPath));
    },
    resolveResourcePathCandidates: (fileName) => [
      path.join(input.dirname, "../resources", fileName),
      path.join(input.dirname, "../prod-resources", fileName),
      path.join(resourcesPath, "resources", fileName),
      path.join(resourcesPath, fileName),
    ],
  });
});

export const layer = (input: MakeDesktopEnvironmentInput) =>
  Layer.effect(DesktopEnvironment, make(input));
