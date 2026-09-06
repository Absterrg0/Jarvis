package expo.modules.jarvisaudio

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.os.Handler
import android.os.Looper
import android.util.Base64
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.concurrent.Executors

/** One bounded native output queue. JS feeds it off the render path. */
class JarvisAudioModule : Module() {
  private class Session(val id: String, val track: AudioTrack) {
    var frames = 0
    var sequence = 0
    var ending: Promise? = null
    var deadline: Runnable? = null
  }
  private val writer = Executors.newSingleThreadExecutor()
  private val main = Handler(Looper.getMainLooper())
  @Volatile private var session: Session? = null

  override fun definition() = ModuleDefinition {
    Name("JarvisAudio")
    AsyncFunction("begin") { id: String ->
      stopCurrent()
      val minimum = AudioTrack.getMinBufferSize(24000, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT)
      require(minimum > 0) { "PCM output is unavailable." }
      val track = AudioTrack.Builder()
        .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ASSISTANCE_ACCESSIBILITY)
          .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
        .setAudioFormat(AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_16BIT)
          .setSampleRate(24000).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
        .setBufferSizeInBytes(maxOf(minimum, 4800)).setTransferMode(AudioTrack.MODE_STREAM).build()
      val current = Session(id, track)
      session = current
      track.setPlaybackPositionUpdateListener(object : AudioTrack.OnPlaybackPositionUpdateListener {
        override fun onPeriodicNotification(t: AudioTrack) {}
        override fun onMarkerReached(t: AudioTrack) {
          if (session === current) finish(current)
        }
      }, main)
      track.play()
    }
    AsyncFunction("write") { id: String, sequence: Int, base64: String, promise: Promise ->
      val current = session
      if (current == null || current.id != id) {
        promise.reject("STALE_AUDIO", "Speech was cancelled.", null)
      } else {
        writer.execute {
          try {
            check(session === current && current.ending == null) { "Speech was cancelled." }
            require(sequence == current.sequence) { "Audio arrived out of order." }
            require(base64.length <= 60000) { "Audio chunk is too large." }
            val bytes = Base64.decode(base64, Base64.NO_WRAP)
            require(bytes.isNotEmpty() && bytes.size % 2 == 0) { "Invalid PCM audio." }
            require(current.frames + bytes.size / 2 <= 4_000_000) { "Speech exceeded its limit." }
            var offset = 0
            while (offset < bytes.size) {
              check(session === current) { "Speech was cancelled." }
              val count = current.track.write(bytes, offset, bytes.size - offset, AudioTrack.WRITE_BLOCKING)
              check(count > 0) { "Audio output stopped." }
              offset += count
            }
            current.frames += bytes.size / 2
            current.sequence += 1
            promise.resolve(null)
          } catch (error: Exception) {
            promise.reject("AUDIO_WRITE", error.message, error)
          }
        }
      }
    }
    AsyncFunction("end") { id: String, promise: Promise ->
      val current = session
      if (current == null || current.id != id || current.frames == 0) {
        promise.reject("STALE_AUDIO", "No active speech to finish.", null)
      } else {
        current.ending = promise
        val deadline = Runnable {
          if (session === current) {
            current.ending = null
            stopCurrent()
            promise.reject("AUDIO_TIMEOUT", "Audio output did not drain.", null)
          }
        }
        current.deadline = deadline
        main.postDelayed(deadline, 5000)
        current.track.notificationMarkerPosition = current.frames
        if (current.track.playbackHeadPosition >= current.frames) finish(current)
      }
    }
    Function("stop") { id: String -> if (session?.id == id) stopCurrent() }
    OnActivityEntersBackground { stopCurrent() }
    OnDestroy { stopCurrent(); writer.shutdownNow() }
  }

  @Synchronized private fun finish(current: Session) {
    if (session !== current) return
    val promise = current.ending ?: return
    current.ending = null
    stopCurrent()
    promise.resolve(null)
  }

  @Synchronized private fun stopCurrent() {
    val old = session ?: return
    session = null
    old.deadline?.let { main.removeCallbacks(it) }
    old.ending?.reject("AUDIO_CANCELLED", "Speech was cancelled.", null)
    old.ending = null
    try { old.track.pause(); old.track.flush(); old.track.release() } catch (_: Exception) {}
  }
}
