const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const supportedPlatforms = new Set(["darwin", "linux", "win32"]);
const supportedArchitectures = new Set(["arm64", "x64"]);

function resolveNativeBinaryPath(
  packageRoot,
  platform = os.platform(),
  arch = os.arch(),
  fileExists = fs.existsSync,
  isFile = (filePath) => fs.statSync(filePath).isFile(),
) {
  if (!supportedPlatforms.has(platform)) {
    throw new Error(`[jarvis-native-microphone] Unsupported platform ${platform}.`);
  }
  if (!supportedArchitectures.has(arch)) {
    throw new Error(`[jarvis-native-microphone] Unsupported architecture ${arch}.`);
  }
  const binaryPath = path.join(packageRoot, "bin", `${platform}-${arch}`, "index.node");
  if (!fileExists(binaryPath)) {
    throw new Error(
      `[jarvis-native-microphone] Missing native binary for ${platform}-${arch}: ${binaryPath}.`,
    );
  }
  if (!isFile(binaryPath)) {
    throw new Error(
      `[jarvis-native-microphone] Native binary is not a regular file: ${binaryPath}.`,
    );
  }
  return binaryPath;
}

module.exports = { resolveNativeBinaryPath };
