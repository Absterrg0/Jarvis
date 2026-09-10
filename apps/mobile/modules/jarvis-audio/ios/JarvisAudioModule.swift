import AVFoundation
import ExpoModulesCore

public class JarvisAudioModule: Module {
  private let engine = AVAudioEngine()
  private let player = AVAudioPlayerNode()
  private var current: String?
  private var sequence = 0
  private var queuedFrames = 0
  private var totalFrames = 0
  private var waiters: [Promise] = []
  private var ending: Promise?
  private var endingTimer: DispatchWorkItem?

  public func definition() -> ModuleDefinition {
    Name("JarvisAudio")
    AsyncFunction("begin") { (id: String) in
      self.stopCurrent()
      let session = AVAudioSession.sharedInstance()
      try session.setCategory(.playback, mode: .spokenAudio)
      try session.setActive(true)
      if self.player.engine == nil { self.engine.attach(self.player) }
      let format = AVAudioFormat(standardFormatWithSampleRate: 24000, channels: 1)!
      self.engine.connect(self.player, to: self.engine.mainMixerNode, format: format)
      try self.engine.start()
      self.current = id
      self.player.play()
    }.runOnQueue(.main)
    AsyncFunction("write") { (id: String, sequence: Int, base64: String, promise: Promise) in
      guard self.current == id, self.ending == nil, sequence == self.sequence,
        base64.count <= 60000, let data = Data(base64Encoded: base64),
        !data.isEmpty, data.count % 2 == 0, self.totalFrames + data.count / 2 <= 4_000_000 else {
        promise.reject("AUDIO_WRITE", "Stale, out-of-order or invalid audio.")
        return
      }
      let frames = data.count / 2
      let format = AVAudioFormat(standardFormatWithSampleRate: 24000, channels: 1)!
      let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames))!
      buffer.frameLength = AVAudioFrameCount(frames)
      data.withUnsafeBytes { (bytes: UnsafeRawBufferPointer) in
        for i in 0..<frames {
          let raw = UInt16(bytes[i * 2]) | UInt16(bytes[i * 2 + 1]) << 8
          buffer.floatChannelData![0][i] = Float(Int16(bitPattern: raw)) / 32768
        }
      }
      self.sequence += 1
      self.totalFrames += frames
      self.queuedFrames += frames
      self.player.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { _ in
        DispatchQueue.main.async {
          guard self.current == id else { return }
          self.queuedFrames -= frames
          if self.queuedFrames < 12000 {
            let pending = self.waiters; self.waiters.removeAll()
            pending.forEach { $0.resolve(nil) }
          }
          if self.queuedFrames == 0, let ending = self.ending {
            self.ending = nil
            self.endingTimer?.cancel()
            self.endingTimer = nil
            self.stopCurrent()
            ending.resolve(nil)
          }
        }
      }
      if self.queuedFrames >= 12000 { self.waiters.append(promise) }
      else { promise.resolve(nil) }
    }.runOnQueue(.main)
    AsyncFunction("end") { (id: String, promise: Promise) in
      guard self.current == id, self.totalFrames > 0 else {
        promise.reject("AUDIO_END", "No active speech to finish."); return
      }
      if self.queuedFrames == 0 { self.stopCurrent(); promise.resolve(nil) }
      else {
        self.ending = promise
        // Deadline tracks the audio still queued at 24 kHz (plus drain
        // margin) instead of a fixed delay, so utterances longer than a few
        // seconds play fully. The ceiling keeps a backstop for a stalled
        // player that never drains.
        let drainSeconds = Double(self.queuedFrames) / 24000.0 + 0.5
        let timeout = DispatchWorkItem { [weak self] in
          guard let self, self.current == id else { return }
          self.stopCurrent()
        }
        self.endingTimer?.cancel()
        self.endingTimer = timeout
        DispatchQueue.main.asyncAfter(deadline: .now() + min(drainSeconds, 30), execute: timeout)
      }
    }.runOnQueue(.main)
    Function("stop") { (id: String) in
      DispatchQueue.main.async { if self.current == id { self.stopCurrent() } }
    }
    OnAppEntersBackground { DispatchQueue.main.async { self.stopCurrent() } }
    OnDestroy { DispatchQueue.main.async { self.stopCurrent() } }
  }

  private func stopCurrent() {
    current = nil
    player.stop()
    engine.stop()
    sequence = 0
    queuedFrames = 0
    totalFrames = 0
    waiters.forEach { $0.reject("AUDIO_CANCELLED", "Speech was cancelled.") }
    waiters.removeAll()
    ending?.reject("AUDIO_CANCELLED", "Speech was cancelled.")
    ending = nil
    endingTimer?.cancel()
    endingTimer = nil
    // Hand routing back when our playback ends so a lingering active session
    // does not keep ducking music, calls, or other apps' audio.
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
  }
}
