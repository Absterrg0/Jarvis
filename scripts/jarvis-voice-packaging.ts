import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import * as Schema from "effect/Schema";

import nativeVoicePackageJson from "../packages/jarvis-native-voice/package.json" with { type: "json" };

import type { BuildArch, BuildPlatform } from "./lib/build-target-arch.ts";
import { resolveCatalogDependencies } from "./lib/resolve-catalog.ts";

/**
 * Jarvis voice packaging policy.
 *
 * Everything the Desktop artifact needs to know about Jarvis speech payloads
 * lives here: model filenames, the Pipecat runtime layout, the native device
 * binding pin, and the validation rules that reject wrong payloads. The
 * shared desktop builder owns mechanics (asar IO, manifests, installs) and
 * calls this module through one explicit seam per phase, so voice changes
 * and upstream packaging changes stop touching the same implementation.
 */

export const JARVIS_VOICE_RESOURCE_ENTRIES = [
  "parakeet",
  "kokoro",
  "listening.wav",
  "THIRD_PARTY_NOTICES.md",
] as const;
export const JARVIS_VOICE_REQUIRED_FILES = [
  "parakeet/encoder.int8.onnx",
  "parakeet/decoder.int8.onnx",
  "parakeet/joiner.int8.onnx",
  "parakeet/tokens.txt",
  "kokoro/model.int8.onnx",
  "kokoro/voices.bin",
  "listening.wav",
  "THIRD_PARTY_NOTICES.md",
] as const;
export const JARVIS_VOICE_RESOURCE_SOURCE_DIR = "packages/jarvis-native-voice/resources";
export const JARVIS_VOICE_RESOURCE_DESTINATION_DIR = "jarvis-resources";
export const JARVIS_PIPECAT_RUNTIME_SOURCE_DIR = "apps/desktop/pipecat/dist/jarvis-pipecat-voice";
export const JARVIS_PIPECAT_RUNTIME_DESTINATION_DIR = "pipecat";
export const DESKTOP_VOICE_EXTRA_RESOURCE = {
  from: `apps/desktop/prod-resources/${JARVIS_VOICE_RESOURCE_DESTINATION_DIR}`,
  to: JARVIS_VOICE_RESOURCE_DESTINATION_DIR,
} as const;
export const JARVIS_NATIVE_VOICE_WORKER_FILES = ["desktopVoiceWorker.cjs"] as const;

/** Build inputs and commands the voice pipeline owns; the shared builder spreads these into its registries. */
export const JARVIS_VOICE_BUILD_ARTIFACTS = [
  "native-voice-resources",
  "pipecat-voice-runtime",
] as const;
export const JARVIS_VOICE_BUILD_COMMANDS = [
  "vp run build:desktop",
  "vp run --filter @t3tools/jarvis-native-voice prepare:voice",
  "uv run --project apps/desktop/pipecat --group build python apps/desktop/pipecat/scripts/build_runtime.py",
  "vp install --prod",
] as const;

/** Display names for the voice-owned build inputs in shared reports. */
export const JARVIS_VOICE_ARTIFACT_DISPLAY_NAMES = {
  "native-voice-resources": "native voice resources",
  "pipecat-voice-runtime": "Pipecat voice runtime",
} as const satisfies Record<(typeof JARVIS_VOICE_BUILD_ARTIFACTS)[number], string>;

export const NODE_CPAL_VERSION = "0.1.1" as const;
export const NODE_CPAL_PLATFORM_BINARIES = [
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
  "win32-x64",
] as const;

export const NODE_CPAL_APP_UNPACKED_PREFIX = "resources/app.asar.unpacked/node_modules/node-cpal/";
// node-cpal's published loader is required at runtime alongside its selected
// native binary. Electron-builder can place these two small package files in
// app.asar.unpacked; they are not native payloads and are intentionally the
// only loose files allowed at the package root.
export const NODE_CPAL_RUNTIME_FILES = new Set([
  `${NODE_CPAL_APP_UNPACKED_PREFIX}index.js`,
  `${NODE_CPAL_APP_UNPACKED_PREFIX}package.json`,
]);
export const RETIRED_MICROPHONE_APP_UNPACKED_PREFIX =
  "resources/app.asar.unpacked/node_modules/@t3tools/jarvis-native-microphone/";

export function nodeCpalTargetDirectory(
  platform: BuildPlatform,
  arch: BuildArch,
): (typeof NODE_CPAL_PLATFORM_BINARIES)[number] | undefined {
  if (platform === "mac") {
    if (arch === "arm64") return "darwin-arm64";
    if (arch === "x64") return "darwin-x64";
    return undefined;
  }
  if (arch !== "x64") return undefined;
  if (platform === "linux") return "linux-x64";
  if (platform === "win") return "win32-x64";
  return undefined;
}

export function nodeCpalTargetDirectories(
  platform: BuildPlatform,
  arch: BuildArch,
): ReadonlyArray<(typeof NODE_CPAL_PLATFORM_BINARIES)[number]> {
  if (platform === "mac" && arch === "universal") return ["darwin-arm64", "darwin-x64"];
  const target = nodeCpalTargetDirectory(platform, arch);
  return target === undefined ? [] : [target];
}

export function nodeCpalFileExclusions(
  platform: BuildPlatform,
  arch: BuildArch,
): ReadonlyArray<string> {
  const targets = new Set(nodeCpalTargetDirectories(platform, arch));
  const excludedDirectories =
    targets.size === 0
      ? NODE_CPAL_PLATFORM_BINARIES
      : NODE_CPAL_PLATFORM_BINARIES.filter((directory) => !targets.has(directory));
  return excludedDirectories.flatMap((directory) => [
    `!**/node_modules/node-cpal/bin/${directory}`,
    `!**/node_modules/node-cpal/bin/${directory}/**`,
  ]);
}

/**
 * The native voice package is bundled into Desktop's main process, but its
 * native loaders must remain real production dependencies beside app.asar.
 * Keep only the native device binding in staged Desktop builds. The active
 * Desktop voice worker delegates recognition and speech to the bundled
 * Pipecat runtime.
 */
export function resolveJarvisNativeVoiceDependencies(
  platform: BuildPlatform,
  arch: BuildArch,
  catalog: Record<string, string>,
): Record<string, string> {
  if (platform === "mac") {
    const dependencies: Record<string, string> = nativeVoicePackageJson.dependencies;
    const runtimeDependencies = Object.fromEntries(
      ["node-cpal"].map((name) => {
        const version = dependencies[name];
        if (name === "node-cpal") return [name, NODE_CPAL_VERSION];
        if (typeof version !== "string") {
          throw new Error(`@t3tools/jarvis-native-voice is missing ${name}.`);
        }
        return [name, version];
      }),
    );
    return resolveCatalogDependencies(runtimeDependencies, catalog, "packages/jarvis-native-voice");
  }

  if ((platform !== "linux" && platform !== "win") || arch !== "x64") return {};

  const dependencies: Record<string, string> = nativeVoicePackageJson.dependencies;
  const runtimeDependencies = Object.fromEntries(
    ["node-cpal"].map((name) => {
      const version = dependencies[name];
      if (name === "node-cpal") return [name, NODE_CPAL_VERSION];
      if (typeof version !== "string") {
        throw new Error(`@t3tools/jarvis-native-voice is missing ${name}.`);
      }
      return [name, version];
    }),
  );
  return resolveCatalogDependencies(runtimeDependencies, catalog, "packages/jarvis-native-voice");
}

/** Voice models must ship loose in jarvis-resources, never duplicated in app.asar. */
export function jarvisVoiceWorkerViolations(
  appAsarEntries: ReadonlySet<string>,
): ReadonlyArray<string> {
  return JARVIS_NATIVE_VOICE_WORKER_FILES.filter(
    (workerFile) => !appAsarEntries.has(`apps/desktop/dist-electron/${workerFile}`),
  );
}

export function jarvisVoiceModelDuplicateViolations(
  appAsarEntries: ReadonlySet<string>,
): ReadonlyArray<string> {
  return [...appAsarEntries].filter(
    (entry) =>
      entry.startsWith("jarvis-resources/parakeet/") ||
      entry.startsWith("jarvis-resources/kokoro/") ||
      entry.includes("/jarvis-resources/parakeet/") ||
      entry.includes("/jarvis-resources/kokoro/"),
  );
}

export interface JarvisNativeBinaryViolations {
  readonly expectedNodeCpalFile: string | undefined;
  readonly missingNodeCpal: ReadonlyArray<string>;
  readonly unexpectedNodeCpal: ReadonlyArray<string>;
  readonly retiredMicrophoneFiles: ReadonlyArray<string>;
}

/** Exactly the registry-pinned binary may ship; the retired microphone package must not. */
export function jarvisNativeBinaryViolations(input: {
  readonly appUnpackedFiles: ReadonlyArray<string>;
  readonly platform: BuildPlatform;
  readonly arch: BuildArch;
}): JarvisNativeBinaryViolations {
  const nodeCpalTarget = nodeCpalTargetDirectory(input.platform, input.arch);
  const expectedNodeCpalFile =
    nodeCpalTarget === undefined
      ? undefined
      : `${NODE_CPAL_APP_UNPACKED_PREFIX}bin/${nodeCpalTarget}/index.node`;
  const nodeCpalFiles = input.appUnpackedFiles.filter((file) =>
    file.startsWith(NODE_CPAL_APP_UNPACKED_PREFIX),
  );
  const retiredMicrophoneFiles = input.appUnpackedFiles.filter((file) =>
    file.startsWith(RETIRED_MICROPHONE_APP_UNPACKED_PREFIX),
  );
  const allowedNodeCpalFiles = new Set(NODE_CPAL_RUNTIME_FILES);
  if (expectedNodeCpalFile !== undefined) allowedNodeCpalFiles.add(expectedNodeCpalFile);
  return {
    expectedNodeCpalFile,
    missingNodeCpal:
      expectedNodeCpalFile === undefined || nodeCpalFiles.includes(expectedNodeCpalFile)
        ? []
        : [expectedNodeCpalFile],
    unexpectedNodeCpal: nodeCpalFiles.filter((file) => !allowedNodeCpalFiles.has(file)),
    retiredMicrophoneFiles,
  };
}

export interface JarvisVoicePayloadViolations {
  readonly missingVoiceFiles: ReadonlyArray<string>;
  readonly unexpectedVoiceFiles: ReadonlyArray<string>;
}

/** The staged voice payload must contain exactly the required model files. */
export function jarvisVoicePayloadViolations(input: {
  readonly manifestPaths: ReadonlySet<string>;
  readonly voiceResourceFiles: ReadonlyArray<string>;
  readonly voiceResourcePrefix: string;
}): JarvisVoicePayloadViolations {
  const expectedVoiceFiles = new Set(
    input.voiceResourceFiles.map((file) => `${input.voiceResourcePrefix}/${file}`),
  );
  const requiredVoiceFiles = JARVIS_VOICE_REQUIRED_FILES.map(
    (file) => `${input.voiceResourcePrefix}/${file}`,
  );
  return {
    missingVoiceFiles: [...new Set([...requiredVoiceFiles, ...expectedVoiceFiles])].filter(
      (file) => !input.manifestPaths.has(file),
    ),
    unexpectedVoiceFiles: [...input.manifestPaths].filter(
      (path) => path.startsWith(`${input.voiceResourcePrefix}/`) && !expectedVoiceFiles.has(path),
    ),
  };
}

export const JarvisVoiceStagingErrorReason = Schema.Literals([
  "unsupported-platform",
  "missing-input",
]);
export type JarvisVoiceStagingErrorReason = typeof JarvisVoiceStagingErrorReason.Type;

export class JarvisVoiceStagingError extends Schema.TaggedErrorClass<JarvisVoiceStagingError>()(
  "JarvisVoiceStagingError",
  {
    reason: JarvisVoiceStagingErrorReason,
    platform: Schema.optional(Schema.String),
    artifact: Schema.optional(Schema.Literals(["desktop-dist", ...JARVIS_VOICE_BUILD_ARTIFACTS])),
    artifactPath: Schema.optional(Schema.String),
    buildCommand: Schema.optional(Schema.Literals([...JARVIS_VOICE_BUILD_COMMANDS])),
  },
) {}

/** Integrity message for a rejected native payload; kept with the rule. */
export function jarvisNativeBinaryCause(expectedNodeCpalFile: string | undefined): string {
  return expectedNodeCpalFile === undefined
    ? "Packaged Desktop must not contain node-cpal binaries for this Windows architecture."
    : "Packaged Desktop must contain only the exact registry node-cpal win32-x64 binary.";
}

/**
 * Verify the registry-pinned native binaries after the staged install, before
 * packaging. Raises a staging error naming the rebuild for a missing binary.
 */
export const verifyJarvisNativeBinaries = Effect.fn("jarvisVoicePackaging.verifyNativeBinaries")(
  function* (input: {
    readonly stageAppDir: string;
    readonly platform: BuildPlatform;
    readonly arch: BuildArch;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    for (const target of nodeCpalTargetDirectories(input.platform, input.arch)) {
      const binary = path.join(
        input.stageAppDir,
        "node_modules",
        "node-cpal",
        "bin",
        target,
        "index.node",
      );
      if (!(yield* fs.exists(binary).pipe(Effect.orElseSucceed(() => false)))) {
        return yield* new JarvisVoiceStagingError({
          reason: "missing-input",
          artifact: "desktop-dist",
          artifactPath: binary,
          buildCommand: "vp install --prod",
        });
      }
      yield* Effect.log(
        `[desktop-artifact] Verified registry node-cpal@${NODE_CPAL_VERSION} ${target} payload before packaging.`,
      );
    }
  },
);

/**
 * Stage voice models, the Pipecat runtime, and the worker contract into the
 * desktop prod-resources tree. Returns normalized staged resource paths for
 * payload validation. Mechanics (filesystem, manifest walk, entry
 * normalization) arrive as explicit inputs from the shared builder.
 */
export const stageJarvisVoiceResources = Effect.fn("jarvisVoicePackaging.stageVoiceResources")(
  function* (input: {
    readonly repoRoot: string;
    readonly stageProdResourcesDir: string;
    readonly desktopDistDir: string;
    readonly platform: BuildPlatform;
    readonly voiceResourcesDir: string;
    readonly collectStagedPaths: (
      directory: string,
    ) => Effect.Effect<ReadonlyArray<string>, PlatformError, FileSystem.FileSystem | Path.Path>;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if (input.platform !== "linux" && input.platform !== "win" && input.platform !== "mac") {
      return yield* new JarvisVoiceStagingError({
        reason: "unsupported-platform",
        platform: input.platform,
      });
    }
    const voiceSourceDir = path.resolve(input.repoRoot, input.voiceResourcesDir);
    const voiceDestinationDir = path.join(
      input.stageProdResourcesDir,
      JARVIS_VOICE_RESOURCE_DESTINATION_DIR,
    );
    for (const entry of JARVIS_VOICE_RESOURCE_ENTRIES) {
      const sourcePath = path.join(voiceSourceDir, entry);
      if (!(yield* fs.exists(sourcePath))) {
        return yield* new JarvisVoiceStagingError({
          reason: "missing-input",
          artifact: "native-voice-resources",
          artifactPath: sourcePath,
          buildCommand: "vp run --filter @t3tools/jarvis-native-voice prepare:voice",
        });
      }
      yield* fs.copy(sourcePath, path.join(voiceDestinationDir, entry));
    }
    const pipecatRuntimeSource = path.join(input.repoRoot, JARVIS_PIPECAT_RUNTIME_SOURCE_DIR);
    const pipecatExecutable = path.join(
      pipecatRuntimeSource,
      input.platform === "win" ? "jarvis-pipecat-voice.exe" : "jarvis-pipecat-voice",
    );
    if (!(yield* fs.exists(pipecatExecutable))) {
      return yield* new JarvisVoiceStagingError({
        reason: "missing-input",
        artifact: "pipecat-voice-runtime",
        artifactPath: pipecatExecutable,
        buildCommand:
          "uv run --project apps/desktop/pipecat --group build python apps/desktop/pipecat/scripts/build_runtime.py",
      });
    }
    yield* fs.copy(
      pipecatRuntimeSource,
      path.join(voiceDestinationDir, JARVIS_PIPECAT_RUNTIME_DESTINATION_DIR),
    );
    const voiceResourceFiles = yield* input.collectStagedPaths(voiceDestinationDir);
    for (const workerFile of JARVIS_NATIVE_VOICE_WORKER_FILES) {
      const workerPath = path.join(input.desktopDistDir, workerFile);
      if (!(yield* fs.exists(workerPath))) {
        return yield* new JarvisVoiceStagingError({
          reason: "missing-input",
          artifact: "desktop-dist",
          artifactPath: workerPath,
          buildCommand: "vp run build:desktop",
        });
      }
    }
    yield* Effect.log("[desktop-artifact] Staged native voice models and notices.");
    return voiceResourceFiles;
  },
);
