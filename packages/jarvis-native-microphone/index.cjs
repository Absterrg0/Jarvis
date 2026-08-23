const { resolveNativeBinaryPath } = require("./loader.cjs");

function loadNativeMicrophoneBinding() {
  const binaryPath = resolveNativeBinaryPath(__dirname);
  try {
    return require(binaryPath);
  } catch (cause) {
    throw new Error(`[jarvis-native-microphone] Failed to load ${binaryPath}.`, { cause });
  }
}

module.exports = loadNativeMicrophoneBinding();
