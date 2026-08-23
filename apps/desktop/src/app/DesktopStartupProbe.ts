// @effect-diagnostics nodeBuiltinImport:off - this opt-in CI receipt is deliberately written synchronously and atomically.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Electron from "electron";

export const STARTUP_PROBE_SCHEMA_VERSION = 1;
export const STARTUP_PROBE_PHASE = "main-window-revealed";

export interface DesktopStartupProbeInput {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly argv?: ReadonlyArray<string>;
  readonly commandLine?: DesktopStartupProbeCommandLine;
}

export interface DesktopStartupProbeCommandLine {
  readonly hasSwitch: (switchName: string) => boolean;
  readonly getSwitchValue: (switchName: string) => string;
}

export interface DesktopStartupReceipt {
  readonly schemaVersion: typeof STARTUP_PROBE_SCHEMA_VERSION;
  readonly product: "Jarvis";
  readonly version: string;
  readonly platform: NodeJS.Platform;
  readonly phase: typeof STARTUP_PROBE_PHASE;
}

const PROBE_SWITCH = "jarvis-startup-probe";

function nonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

export function resolveStartupProbePath(input: DesktopStartupProbeInput = {}): string | null {
  const envPath = nonEmpty(
    input.env?.JARVIS_STARTUP_PROBE_FILE ?? process.env.JARVIS_STARTUP_PROBE_FILE,
  );
  if (envPath !== null) return envPath;

  const argv = input.argv ?? process.argv;
  const argument = argv.find((value) => value.startsWith(`--${PROBE_SWITCH}=`));
  const argvPath = nonEmpty(argument?.slice(PROBE_SWITCH.length + 3));
  if (argvPath !== null) return argvPath;

  const commandLine = input.commandLine;
  if (commandLine?.hasSwitch(PROBE_SWITCH) === true) {
    return nonEmpty(commandLine.getSwitchValue(PROBE_SWITCH));
  }
  return null;
}

export function resolveRuntimeStartupProbePath(): string | null {
  try {
    return resolveStartupProbePath({
      commandLine: Electron.app.commandLine,
    });
  } catch {
    // Unit tests and non-Electron tooling may intentionally provide a partial
    // Electron mock. Environment/argv probing remains fully functional there.
    return resolveStartupProbePath();
  }
}

export function writeStartupReceipt(
  path: string,
  input: Pick<DesktopStartupReceipt, "version" | "platform">,
  fs: Pick<typeof NodeFS, "mkdirSync" | "writeFileSync" | "renameSync" | "unlinkSync"> = NodeFS,
): DesktopStartupReceipt {
  const receipt: DesktopStartupReceipt = {
    schemaVersion: STARTUP_PROBE_SCHEMA_VERSION,
    product: "Jarvis",
    version: input.version,
    platform: input.platform,
    phase: STARTUP_PROBE_PHASE,
  };
  const directory = NodePath.dirname(path);
  const temporaryPath = `${path}.${process.pid}.tmp`;
  fs.mkdirSync(directory, { recursive: true });
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(receipt)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    fs.renameSync(temporaryPath, path);
  } finally {
    try {
      fs.unlinkSync(temporaryPath);
    } catch {
      // The temporary file was renamed successfully, or never created.
    }
  }
  return receipt;
}
