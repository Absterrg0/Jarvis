/**
 * Chromium flags baked into Linux Jarvis packaging: electron-builder
 * `executableArgs`, the URL-handler `.desktop` Exec line, and the pre-ready
 * XWayland ozone fallback. Keep these three surfaces on one list so they
 * cannot drift.
 */
export const JARVIS_LINUX_ELECTRON_ARGS = [
  "--no-sandbox",
  "--ozone-platform=x11",
  "--disable-gpu-compositing",
] as const;

const OZONE_PLATFORM_PREFIX = "--ozone-platform=";

export function jarvisLinuxElectronArgSwitch(arg: (typeof JARVIS_LINUX_ELECTRON_ARGS)[number]): {
  readonly name: string;
  readonly value?: string;
} {
  if (arg.startsWith(OZONE_PLATFORM_PREFIX)) {
    return { name: "ozone-platform", value: arg.slice(OZONE_PLATFORM_PREFIX.length) };
  }
  return { name: arg.slice(2) };
}

/**
 * Apply the graphics flags from {@link JARVIS_LINUX_ELECTRON_ARGS} (not
 * `--no-sandbox`, which is a packaging concern) when the process has chosen
 * an Ozone platform at runtime.
 */
export function applyJarvisLinuxOzoneCommandLineSwitches(
  commandLine: {
    readonly appendSwitch: (switchName: string, value?: string) => void;
  },
  ozonePlatform: string,
): void {
  for (const arg of JARVIS_LINUX_ELECTRON_ARGS) {
    if (arg === "--no-sandbox") continue;
    const parsed = jarvisLinuxElectronArgSwitch(arg);
    if (parsed.name === "ozone-platform") {
      commandLine.appendSwitch(parsed.name, ozonePlatform);
      continue;
    }
    if (parsed.value === undefined) {
      commandLine.appendSwitch(parsed.name);
      continue;
    }
    commandLine.appendSwitch(parsed.name, parsed.value);
  }
}
