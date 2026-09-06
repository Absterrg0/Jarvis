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
import java.util.concurrent.RejectedExecutionException

/** One bounded native output queue. JS feeds it off the render path. */
class JarvisAudioModule : Module() {
  private class Session(
    val id: String,
    val track: AudioTrack
  ) {
    var frames = 0
    var sequence = 0
    var ending: Promise? = null
    var deadline: Runnable? = null
  }

  private val writer = Executors.newSingleThreadExecutor()
  private val main = Handler(Looper.getMainLooper())

  // Guards session install, the end handshake, and promise settlement across
  // the writer thread, the main thread (marker/deadline callbacks), and the
  // bridge threads. Never hold it across blocking AudioTrack writes.
  private val stateLock = Any()

  @Volatile private var session: Session? = null

  // Set once in OnDestroy. Queued writer tasks drain and self-reject against
  // the cleared session; later submissions are rejected without enqueueing.
  @Volatile private var destroyed = false

  override fun definition() = ModuleDefinition {
    Name("JarvisAudio")
    AsyncFunction("begin") { id: String ->
      // Publish the session, listener, and playback atomically: background or
      // destroy cannot release the track between install and play, and begin
      // cannot publish after destruction.
      synchronized(stateLock) {
        if (!destroyed) {
          stopCurrent()
          val track = buildOutputTrack()
          val current = Session(id, track)
          try {
            track.setPlaybackPositionUpdateListener(
              object : AudioTrack.OnPlaybackPositionUpdateListener {
                // Periodic progress is unused; the end marker drives completion.
                @Suppress("EmptyFunctionBlock")
                override fun onPeriodicNotification(t: AudioTrack) {}

                override fun onMarkerReached(t: AudioTrack) {
                  if (session === current) finish(current)
                }
              },
              main
            )
            track.play()
          } catch (error: IllegalStateException) {
            try {
              track.release()
            } catch (_: Exception) {
            }
            throw error
          }
          session = current
        }
      }
    }
    AsyncFunction("write") { id: String, sequence: Int, base64: String, promise: Promise ->
      val current = session
      if (destroyed || current == null || current.id != id) {
        promise.reject("STALE_AUDIO", "Speech was cancelled.", null)
      } else {
        try {
          writer.execute {
            handleWrite(current, sequence, base64, promise)
          }
        } catch (error: RejectedExecutionException) {
          promise.reject("STALE_AUDIO", "Speech was cancelled.", error)
        }
      }
    }
    AsyncFunction("end") { id: String, promise: Promise ->
      val current = session
      if (destroyed || current == null || current.id != id) {
        promise.reject("STALE_AUDIO", "No active speech to finish.", null)
      } else {
        // Serialize after queued writes so frames reflects all delivered PCM.
        try {
          writer.execute {
            handleEnd(current, promise)
          }
        } catch (error: RejectedExecutionException) {
          promise.reject("STALE_AUDIO", "No active speech to finish.", error)
        }
      }
    }
    Function("stop") { id: String ->
      stopById(id)
    }
    OnActivityEntersBackground { stopCurrent() }
    OnDestroy {
      synchronized(stateLock) {
        stopCurrent()
        destroyed = true
      }
      // Drain, don't drop: queued tasks run against the cleared session and
      // reject their own promises instead of leaking them.
      writer.shutdown()
    }
  }

  private fun buildOutputTrack(): AudioTrack {
    val minimum =
      AudioTrack.getMinBufferSize(
        24000,
        AudioFormat.CHANNEL_OUT_MONO,
        AudioFormat.ENCODING_PCM_16BIT
      )
    require(minimum > 0) { "PCM output is unavailable." }
    return AudioTrack.Builder()
      .setAudioAttributes(
        AudioAttributes.Builder()
          .setUsage(AudioAttributes.USAGE_ASSISTANCE_ACCESSIBILITY)
          .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
          .build()
      )
      .setAudioFormat(
        AudioFormat.Builder()
          .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
          .setSampleRate(24000)
          .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
          .build()
      )
      .setBufferSizeInBytes(maxOf(minimum, 4800))
      .setTransferMode(AudioTrack.MODE_STREAM)
      .build()
  }

  // Any decode, validation, or playback failure must settle the write promise.
  // Letting it escape would kill the single writer and leak every later task.
  @Suppress("TooGenericExceptionCaught")
  private fun handleWrite(
    current: Session,
    sequence: Int,
    base64: String,
    promise: Promise
  ) {
    try {
      require(base64.length <= 60000) { "Audio chunk is too large." }
      val bytes = Base64.decode(base64, Base64.NO_WRAP)
      require(bytes.isNotEmpty() && bytes.size % 2 == 0) { "Invalid PCM audio." }
      synchronized(stateLock) {
        check(session === current && current.ending == null) {
          "Speech was cancelled."
        }
        check(sequence == current.sequence) {
          "Audio arrived out of order."
        }
        require(current.frames + bytes.size / 2 <= 4_000_000) {
          "Speech exceeded its limit."
        }
      }
      var offset = 0
      while (offset < bytes.size) {
        check(session === current) { "Speech was cancelled." }
        val count =
          current.track.write(
            bytes,
            offset,
            bytes.size - offset,
            AudioTrack.WRITE_BLOCKING
          )
        check(count > 0) { "Audio output stopped." }
        offset += count
      }
      synchronized(stateLock) {
        // Re-check after blocking I/O: end or stop may have claimed the session.
        check(session === current && current.ending == null) {
          "Speech was cancelled."
        }
        current.frames += bytes.size / 2
        current.sequence += 1
      }
      promise.resolve(null)
    } catch (error: Exception) {
      promise.reject("AUDIO_WRITE", error.message, error)
    }
  }

  private fun handleEnd(
    current: Session,
    promise: Promise
  ) {
    // Claim the ending under the state lock so a concurrent stop cannot slip
    // between the check and the install and leak the promise.
    val deadline: Runnable
    synchronized(stateLock) {
      if (session !== current || current.frames == 0 || current.ending != null) {
        promise.reject("STALE_AUDIO", "No active speech to finish.", null)
        return
      }
      current.ending = promise
      deadline =
        Runnable {
          onDeadline(current, promise)
        }
      current.deadline = deadline
    }
    main.postDelayed(deadline, 5000)
    // Marker ops are nonblocking, so hold the lock across them: stop cannot
    // release the track mid-arm, and the lock is never held across writes.
    synchronized(stateLock) {
      if (session === current && current.ending === promise) {
        val drained: Boolean? =
          try {
            current.track.notificationMarkerPosition = current.frames
            current.track.playbackHeadPosition >= current.frames
          } catch (error: IllegalStateException) {
            current.ending = null
            stopCurrent()
            promise.reject("AUDIO_WRITE", error.message, error)
            null
          }
        if (drained == true) finish(current)
      } else {
        // Stop reclaimed the session after the claim and settled the promise.
        main.removeCallbacks(deadline)
      }
    }
  }

  private fun finish(current: Session) {
    synchronized(stateLock) {
      if (session !== current) return
      val promise = current.ending ?: return
      current.ending = null
      stopCurrent()
      promise.resolve(null)
    }
  }

  private fun onDeadline(
    current: Session,
    promise: Promise
  ) {
    synchronized(stateLock) {
      if (session !== current || current.ending !== promise) return
      current.ending = null
      stopCurrent()
      promise.reject("AUDIO_TIMEOUT", "Audio output did not drain.", null)
    }
  }

  private fun stopById(id: String) {
    synchronized(stateLock) {
      if (session?.id == id) stopCurrent()
    }
  }

  private fun stopCurrent() {
    synchronized(stateLock) {
      val old = session ?: return
      session = null
      old.deadline?.let { main.removeCallbacks(it) }
      old.ending?.reject("AUDIO_CANCELLED", "Speech was cancelled.", null)
      old.ending = null
      try {
        old.track.pause()
        old.track.flush()
        old.track.release()
      } catch (_: Exception) {
      }
    }
  }
}
