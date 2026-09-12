package expo.modules.jarvislocalasr

import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Genuine on-device live speech recognition for Jarvis.
 *
 * Uses ONLY [SpeechRecognizer.createOnDeviceSpeechRecognizer]. The online
 * constructor ([SpeechRecognizer.createSpeechRecognizer]) is never called, so
 * a missing on-device pack reports ON_DEVICE_UNAVAILABLE instead of silently
 * uploading audio. First use may need a network connection to download the
 * on-device pack; later recognition for that language stays on the device.
 * Offline behavior is NOT claimed here beyond what the framework reports
 * through [SpeechRecognizer.isOnDeviceRecognitionAvailable]. There is no file
 * transcription API in the framework: the shared VoiceTranscriber file
 * argument is accepted for interface conformance and never read.
 *
 * Threading: every [SpeechRecognizer] method must run on the main application
 * thread (framework requirement). start/stop create and drive the recognizer
 * inside [main.post]; cancel/destroy capture the handle under [stateLock] and
 * post the actual destroy to [main] so an Expo worker thread never touches the
 * recognizer directly. RecognitionListener callbacks arrive on the main thread
 * and settle the pending stop promise there.
 *
 * Availability gates: on-device support is API 31 (S) via
 * [SpeechRecognizer.isOnDeviceRecognitionAvailable] and
 * [SpeechRecognizer.createOnDeviceSpeechRecognizer]. API 33 (Tiramisu)
 * [SpeechRecognizer.checkRecognitionSupport] is deliberately NOT used as a
 * gate: per-locale pack support is resolved by trial start plus the
 * ERROR_LANGUAGE_NOT_SUPPORTED / ERROR_LANGUAGE_UNAVAILABLE mapping to
 * UNSUPPORTED_LOCALE, which works back to API 31.
 *
 * Permission: RECORD_AUDIO is required by the framework. The JS capture flow
 * requests it via expo-audio, but this module enforces it natively: an
 * explicit checkSelfPermission (API 23+) rejects with NO_PERMISSION before
 * creating the recognizer, and ERROR_INSUFFICIENT_PERMISSIONS maps to the
 * same code. Package visibility for isRecognitionAvailable on API 30+ comes
 * from the library manifest queries entry for RecognitionService.
 *
 * Cancellation: cancel captures and nulls the recognizer under lock, posts
 * cancel/destroy to the main thread, clears partial finals and terminal
 * state, and rejects the pending stop promise with CANCELLED so no caller
 * hangs and no stale transcript survives. Terminal onResults/onError destroy
 * and null the recognizer so a later stop reports the retained result or the
 * retained error instead of driving a dead handle, and a second stop reports
 * NO_ACTIVE_SESSION instead of reusing stale state.
 *
 * Physical-device verification is pending (no Android device in CI). Static
 * tests cover the JS adapter contract with this module mocked.
 */
class JarvisLocalAsrModule : Module() {
  private val main = Handler(Looper.getMainLooper())
  private val stateLock = Any()

  private var recognizer: SpeechRecognizer? = null
  private var finals: MutableList<String> = mutableListOf()
  private var stopPromise: Promise? = null
  private var terminalErrorCode: String? = null
  private var terminalErrorMessage: String? = null
  private var silentEnd = false
  private var activeLanguage: String? = null

  @Volatile private var destroyed = false

  private fun recognitionAvailable(): Boolean {
    return try {
      val context = appContext.reactContext ?: return false
      SpeechRecognizer.isRecognitionAvailable(context)
    } catch (_: Exception) {
      false
    }
  }

  private fun onDeviceAvailable(): Boolean {
    // Single-return shape keeps ReturnCount within budget.
    val available = try {
      // Correct gate is S (31): isOnDeviceRecognitionAvailable and
      // createOnDeviceSpeechRecognizer both arrived in API 31. Do not raise
      // this to TIRAMISU (33); checkRecognitionSupport is 33+ per-locale API
      // that this module deliberately does not use as a gate.
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
        false
      } else {
        val context = appContext.reactContext
        if (context == null) {
          false
        } else {
          SpeechRecognizer.isOnDeviceRecognitionAvailable(context)
        }
      }
    } catch (_: Exception) {
      false
    }
    return available
  }

  private fun hasRecordAudioPermission(): Boolean {
    // Single-return shape keeps ReturnCount within budget.
    val granted = try {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
        true
      } else {
        val context = appContext.reactContext
        if (context == null) {
          false
        } else {
          context.checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) ==
            PackageManager.PERMISSION_GRANTED
        }
      }
    } catch (_: Exception) {
      false
    }
    return granted
  }

  private fun failStop(code: String, message: String, cause: Throwable? = null) {
    val pending = synchronized(stateLock) {
      val current = stopPromise
      stopPromise = null
      current
    }
    pending?.reject(code, message, cause)
  }

  private fun destroyOnMain(handle: SpeechRecognizer?) {
    if (handle == null) return
    if (Looper.myLooper() == Looper.getMainLooper()) {
      try {
        handle.cancel()
      } catch (_: Exception) {
      }
      try {
        handle.destroy()
      } catch (_: Exception) {
      }
    } else {
      main.post {
        try {
          handle.cancel()
        } catch (_: Exception) {
        }
        try {
          handle.destroy()
        } catch (_: Exception) {
        }
      }
    }
  }

  // SpeechRecognizer start/stop/error wiring lives in one ModuleDefinition so
  // session supersede, terminal retain, and stop-race handling stay together.
  // Splitting it for length budgets would risk behavior drift without a
  // compiler locally, so length and complexity are suppressed here. Broad
  // Exception catches are intentional module boundaries: the framework throws
  // across create/start/stop, and every path settles the caller.
  @Suppress("LongMethod", "CyclomaticComplexMethod", "TooGenericExceptionCaught", "SwallowedException")
  override fun definition() = ModuleDefinition {
    Name("JarvisLocalAsr")

    Function("isRecognitionAvailable") {
      recognitionAvailable()
    }

    Function("isOnDeviceRecognitionAvailable") {
      onDeviceAvailable()
    }

    Function("getSupport") {
      mapOf(
        "recognitionAvailable" to recognitionAvailable(),
        "onDeviceAvailable" to onDeviceAvailable()
      )
    }

    AsyncFunction("startListening") { language: String, promise: Promise ->
      if (destroyed) {
        promise.reject("MODULE_DESTROYED", "Speech module is destroyed.", null)
        return@AsyncFunction
      }
      if (!recognitionAvailable()) {
        promise.reject("NOT_AVAILABLE", "Speech recognition is not available on this device.", null)
        return@AsyncFunction
      }
      if (!onDeviceAvailable()) {
        promise.reject(
          "ON_DEVICE_UNAVAILABLE",
          "On-device speech recognition is not available. No online fallback is used.",
          null
        )
        return@AsyncFunction
      }
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
        promise.reject(
          "ON_DEVICE_UNAVAILABLE",
          "On-device speech recognition needs Android 12 or later. No online fallback is used.",
          null
        )
        return@AsyncFunction
      }
      main.post {
        // A previous session must never hang: supersede its pending stop so
        // the old caller settles instead of waiting on a destroyed handle.
        val superseded = synchronized(stateLock) {
          val previous = stopPromise
          stopPromise = null
          val old = recognizer
          recognizer = null
          finals = mutableListOf()
          terminalErrorCode = null
          terminalErrorMessage = null
          silentEnd = false
          activeLanguage = null
          try {
            old?.cancel()
          } catch (_: Exception) {
          }
          try {
            old?.destroy()
          } catch (_: Exception) {
          }
          previous
        }
        superseded?.reject("CANCELLED", "Recognition superseded by a new session.", null)
        if (destroyed) {
          promise.reject("MODULE_DESTROYED", "Speech module is destroyed.", null)
          return@post
        }
        val context = appContext.reactContext
        if (context == null) {
          promise.reject("NOT_AVAILABLE", "Speech recognition is not available.", null)
          return@post
        }
        if (!hasRecordAudioPermission()) {
          promise.reject(
            "NO_PERMISSION",
            "Microphone permission is required for on-device recognition.",
            null
          )
          return@post
        }
        val current: SpeechRecognizer = try {
          SpeechRecognizer.createOnDeviceSpeechRecognizer(context)
        } catch (error: Exception) {
          promise.reject("ON_DEVICE_UNAVAILABLE", "On-device recognizer failed to start.", error)
          return@post
        }
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
          putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
          putExtra(RecognizerIntent.EXTRA_LANGUAGE, language)
          putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
          putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
          putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
        }
        synchronized(stateLock) { activeLanguage = language }
        current.setRecognitionListener(object : RecognitionListener {
          @Suppress("EmptyFunctionBlock")
          override fun onReadyForSpeech(params: Bundle?) {
            // No-op: listener requires this callback.
          }
          @Suppress("EmptyFunctionBlock")
          override fun onBeginningOfSpeech() {
            // No-op: listener requires this callback.
          }
          @Suppress("EmptyFunctionBlock")
          override fun onRmsChanged(rmsdB: Float) {
            // No-op: listener requires this callback.
          }
          @Suppress("EmptyFunctionBlock")
          override fun onBufferReceived(buffer: ByteArray?) {
            // No-op: listener requires this callback.
          }
          @Suppress("EmptyFunctionBlock")
          override fun onEndOfSpeech() {
            // No-op: listener requires this callback.
          }
          @Suppress("EmptyFunctionBlock")
          override fun onPartialResults(partialResults: Bundle?) {
            // No-op: listener requires this callback.
          }
          @Suppress("EmptyFunctionBlock")
          override fun onEvent(eventType: Int, params: Bundle?) {
            // No-op: listener requires this callback.
          }

          override fun onResults(results: Bundle?) {
            // Callbacks run on the main thread: safe to destroy here.
            val texts = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
            val pending: Promise?
            val transcript: String
            synchronized(stateLock) {
              if (texts != null) finals.addAll(texts)
              transcript = finals.joinToString(" ").trim()
              pending = stopPromise
              stopPromise = null
              try {
                recognizer?.destroy()
              } catch (_: Exception) {
              }
              recognizer = null
              activeLanguage = null
              if (pending != null) {
                finals = mutableListOf()
              }
              // No pending stop yet: keep finals so the later stopListening
              // returns this transcript instead of driving a dead handle.
            }
            pending?.resolve(transcript)
          }

          override fun onError(error: Int) {
            // Silence is a completion, not a failure: NO_MATCH and
            // SPEECH_TIMEOUT mean the user said nothing, so the pending stop
            // resolves with an empty transcript instead of a stale failure.
            if (
              error == SpeechRecognizer.ERROR_NO_MATCH ||
              error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT
            ) {
              val pending: Promise?
              synchronized(stateLock) {
                pending = stopPromise
                stopPromise = null
                try {
                  recognizer?.destroy()
                } catch (_: Exception) {
                }
                recognizer = null
                activeLanguage = null
                finals = mutableListOf()
                terminalErrorCode = null
                terminalErrorMessage = null
                // No stop is waiting yet: remember the silence so the later
                // stop resolves an empty transcript instead of NO_ACTIVE_SESSION.
                if (pending == null) silentEnd = true
              }
              pending?.resolve("")
              return
            }
            val code = when (error) {
              SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED,
              SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE -> "UNSUPPORTED_LOCALE"
              SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "NO_PERMISSION"
              else -> "RECOGNITION_FAILED"
            }
            val message = when (code) {
              "UNSUPPORTED_LOCALE" -> "On-device recognition does not support this language."
              "NO_PERMISSION" -> "Microphone permission is required for on-device recognition."
              else -> "On-device recognition failed."
            }
            val pending: Promise?
            synchronized(stateLock) {
              pending = stopPromise
              stopPromise = null
              try {
                recognizer?.destroy()
              } catch (_: Exception) {
              }
              recognizer = null
              activeLanguage = null
              if (pending == null) {
                // Error arrived before stop: retain it so the later stop
                // reports this cause instead of generic NO_ACTIVE_SESSION,
                // and drop partial finals so no stale text survives.
                finals = mutableListOf()
                terminalErrorCode = code
                terminalErrorMessage = message
              } else {
                finals = mutableListOf()
                terminalErrorCode = null
                terminalErrorMessage = null
              }
            }
            pending?.reject(code, message, null)
          }
        })
        synchronized(stateLock) {
          if (destroyed) {
            try {
              current.destroy()
            } catch (_: Exception) {
            }
            promise.reject("MODULE_DESTROYED", "Speech module is destroyed.", null)
            return@post
          }
          recognizer = current
        }
        try {
          current.startListening(intent)
          promise.resolve(null)
        } catch (error: Exception) {
          synchronized(stateLock) {
            try {
              current.destroy()
            } catch (_: Exception) {
            }
            if (recognizer === current) recognizer = null
            finals = mutableListOf()
            terminalErrorCode = null
            terminalErrorMessage = null
            silentEnd = false
            activeLanguage = null
          }
          promise.reject("RECOGNITION_FAILED", "On-device recognition failed to start.", error)
        }
      }
    }

    AsyncFunction("stopListening") { promise: Promise ->
      val terminal: Triple<SpeechRecognizer?, String?, Pair<String, String>?> =
        synchronized(stateLock) {
          val handle = recognizer
          if (handle == null) {
            val retainedTranscript =
              if (finals.isNotEmpty()) {
                finals.joinToString(" ").trim()
              } else if (silentEnd) {
                ""
              } else {
                null
              }
            val retainedError =
              if (terminalErrorCode != null && terminalErrorMessage != null) {
                Pair(terminalErrorCode as String, terminalErrorMessage as String)
              } else {
                null
              }
            if (retainedTranscript != null || retainedError != null) {
              finals = mutableListOf()
              terminalErrorCode = null
              terminalErrorMessage = null
              silentEnd = false
            }
            Triple(null, retainedTranscript, retainedError)
          } else {
            if (stopPromise != null) {
              Triple(handle, null, null)
            } else {
              stopPromise = promise
              Triple(handle, null, null)
            }
          }
        }
      val (handle, retainedTranscript, retainedError) = terminal
      if (handle == null) {
        if (retainedError != null) {
          promise.reject(retainedError.first, retainedError.second, null)
        } else if (retainedTranscript != null) {
          promise.resolve(retainedTranscript)
        } else {
          promise.reject("NO_ACTIVE_SESSION", "No active recognition session.", null)
        }
        return@AsyncFunction
      }
      synchronized(stateLock) {
        if (stopPromise !== promise) {
          // stopPromise mismatch means this call lost the race for the single
          // in-flight stop; report it instead of queuing a second native stop.
          promise.reject("ALREADY_STOPPING", "Recognition is already stopping.", null)
          return@AsyncFunction
        }
      }
      main.post {
        val stillCurrent = synchronized(stateLock) {
          recognizer === handle && stopPromise === promise && !destroyed
        }
        if (!stillCurrent) {
          // Cancelled or superseded while queued: the pending promise was
          // already settled via cancel/supersede; do not touch the handle.
          return@post
        }
        try {
          handle.stopListening()
        } catch (error: Exception) {
          failStop("RECOGNITION_FAILED", "On-device recognition failed to stop.", error)
        }
      }
    }

    Function("cancel") {
      // Never touch the recognizer off the main thread: capture under lock,
      // destroy on main, then complete the pending promise. Idempotent.
      val toDestroy = synchronized(stateLock) {
        val current = recognizer
        recognizer = null
        finals = mutableListOf()
        terminalErrorCode = null
        terminalErrorMessage = null
        activeLanguage = null
        current
      }
      destroyOnMain(toDestroy)
      failStop("CANCELLED", "On-device recognition was cancelled.")
    }

    OnDestroy {
      destroyed = true
      val toDestroy = synchronized(stateLock) {
        val current = recognizer
        recognizer = null
        finals = mutableListOf()
        terminalErrorCode = null
        terminalErrorMessage = null
        activeLanguage = null
        current
      }
      destroyOnMain(toDestroy)
      failStop("MODULE_DESTROYED", "Speech module is destroyed.")
    }
  }
}
