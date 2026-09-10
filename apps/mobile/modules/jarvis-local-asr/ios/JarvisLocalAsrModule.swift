import ExpoModulesCore

/**
 * iOS stub. Jarvis uses `@react-native-ai/apple` (SpeechAnalyzer /
 * SpeechTranscriber, iOS 26+) for real on-device transcription. This module
 * exists so the shared `jarvisLocalAsr` wrapper resolves on both platforms
 * and honestly reports that it owns no iOS recognition path.
 *
 * Physical-device verification of the Apple path is pending (no device in
 * CI). See `voiceTranscription.ios.ts` and its static tests.
 */
public class JarvisLocalAsrModule: Module {
  public func definition() -> ModuleDefinition {
    Name("JarvisLocalAsr")

    Function("isRecognitionAvailable") { () -> Bool in
      false
    }

    Function("isOnDeviceRecognitionAvailable") { () -> Bool in
      false
    }

    Function("getSupport") { () -> [String: Bool] in
      ["recognitionAvailable": false, "onDeviceAvailable": false]
    }
  }
}
