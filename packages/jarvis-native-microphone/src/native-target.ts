export const nativeMicrophoneTargets = {
  "darwin-arm64": { platform: "darwin", arch: "arm64", rustTarget: "aarch64-apple-darwin" },
  "darwin-x64": { platform: "darwin", arch: "x64", rustTarget: "x86_64-apple-darwin" },
  "linux-arm64": { platform: "linux", arch: "arm64", rustTarget: "aarch64-unknown-linux-gnu" },
  "linux-x64": { platform: "linux", arch: "x64", rustTarget: "x86_64-unknown-linux-gnu" },
  "win32-arm64": { platform: "win32", arch: "arm64", rustTarget: "aarch64-pc-windows-msvc" },
  "win32-x64": { platform: "win32", arch: "x64", rustTarget: "x86_64-pc-windows-msvc" },
} as const;

export type NativeMicrophoneTarget = keyof typeof nativeMicrophoneTargets;

export function nativeMicrophoneTargetFor(platform: string, arch: string): NativeMicrophoneTarget {
  const target = `${platform}-${arch}` as NativeMicrophoneTarget;
  if (!(target in nativeMicrophoneTargets)) {
    throw new Error(`[jarvis-native-microphone] Unsupported native target ${platform}-${arch}.`);
  }
  return target;
}
