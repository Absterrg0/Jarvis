// @effect-diagnostics nodeBuiltinImport:off - this opt-in CI receipt is deliberately
// written synchronously and atomically.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export const COMPANION_STARTUP_PROBE_SCHEMA_VERSION = 1;
export const COMPANION_STARTUP_PROBE_PHASE = "tray-ready";

export interface CompanionStartupProbeInput {
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface CompanionStartupReceipt {
  readonly schemaVersion: typeof COMPANION_STARTUP_PROBE_SCHEMA_VERSION;
  readonly product: "Jarvis Companion";
  readonly version: string;
  readonly platform: NodeJS.Platform;
  readonly phase: typeof COMPANION_STARTUP_PROBE_PHASE;
}

function nonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

export function resolveCompanionStartupProbePath(
  input: CompanionStartupProbeInput = {},
): string | null {
  const env = input.env ?? process.env;
  return nonEmpty(env.JARVIS_COMPANION_STARTUP_PROBE_FILE);
}

export function writeCompanionStartupReceipt(
  path: string,
  input: Pick<CompanionStartupReceipt, "version" | "platform">,
  fs: Pick<typeof NodeFS, "mkdirSync" | "writeFileSync" | "renameSync" | "unlinkSync"> = NodeFS,
): CompanionStartupReceipt {
  const receipt: CompanionStartupReceipt = {
    schemaVersion: COMPANION_STARTUP_PROBE_SCHEMA_VERSION,
    product: "Jarvis Companion",
    version: input.version,
    platform: input.platform,
    phase: COMPANION_STARTUP_PROBE_PHASE,
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
