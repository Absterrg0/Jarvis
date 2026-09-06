// Jarvis Pocket TTS daemon. Owns one PocketTTS model in a disposable OS
// process so a native failure can never become a successful completion and
// model memory returns to the OS on close.
//
// The daemon links its own ONNX Runtime, isolated from the frozen voice
// host, so the two runtimes never share a process.
//
// Protocol is JSON-lines on stdin/stdout. Chunk audio is exchanged as
// IEEE-float mono WAV files in the caller-provided output directory:
//
//   stdin:  {"type":"synthesize","requestId":"...","text":"...","outputDirectory":"..."}
//   stdin:  {"type":"cancel","requestId":"..."}
//   stdin:  {"type":"shutdown"}
//   stdout: {"type":"ready","sampleRate":24000}
//   stdout: {"type":"chunk","requestId":"...","index":0,"path":".../raw-000000.wav"}
//   stdout: {"type":"synthesis-finished","requestId":"...",...}
//   stdout: {"type":"cancelled","requestId":"..."}
//   stdout: {"type":"failed","requestId":"...","message":"..."}
//   stdout: {"type":"startup-failed","message":"..."}
//
// Cancellation aborts the active stream in place: the model stays loaded, so
// the next utterance after a barge-in reuses the warm runtime. Only one
// synthesis runs at a time; overlapping work is rejected so the active model
// is never used concurrently or destroyed while busy.

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <csignal>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <mutex>
#include <queue>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#ifdef _WIN32
#include <windows.h>

#include <psapi.h>
#else
#include <sys/resource.h>
#include <sys/select.h>
#include <unistd.h>
#endif

namespace {

void write_wav_f32(const std::string& path, const float* samples, size_t count, int sample_rate) {
    FILE* file = std::fopen(path.c_str(), "wb");
    if (file == nullptr) throw std::runtime_error("Failed to write: " + path);
    const uint32_t data_bytes = static_cast<uint32_t>(count * sizeof(float));
    unsigned char header[44] = {0};
    std::memcpy(header, "RIFF", 4);
    const uint32_t riff_size = 36 + data_bytes;
    std::memcpy(header + 4, &riff_size, 4);
    std::memcpy(header + 8, "WAVEfmt ", 8);
    const uint32_t fmt_size = 16;
    std::memcpy(header + 16, &fmt_size, 4);
    const uint16_t audio_format = 3;
    std::memcpy(header + 20, &audio_format, 2);
    const uint16_t channels = 1;
    std::memcpy(header + 22, &channels, 2);
    std::memcpy(header + 24, &sample_rate, 4);
    const uint32_t byte_rate = static_cast<uint32_t>(sample_rate * sizeof(float));
    std::memcpy(header + 28, &byte_rate, 4);
    const uint16_t block_align = sizeof(float);
    std::memcpy(header + 32, &block_align, 2);
    const uint16_t bits = 32;
    std::memcpy(header + 34, &bits, 2);
    std::memcpy(header + 36, "data", 4);
    std::memcpy(header + 40, &data_bytes, 4);
    if (std::fwrite(header, 1, sizeof(header), file) != sizeof(header)) {
        std::fclose(file);
        throw std::runtime_error("Failed to write: " + path);
    }
    if (count > 0 && std::fwrite(samples, sizeof(float), count, file) != count) {
        std::fclose(file);
        throw std::runtime_error("Failed to write: " + path);
    }
    std::fclose(file);
}

}  // namespace

extern "C" {
void* ptt_create(const char* models_dir, const char* voices_dir, const char* tokenizer_path,
                 const char* precision, float temperature, int lsd_steps, int num_threads);
double ptt_warmup(void* handle);
void ptt_free_audio(float* samples);
void ptt_destroy(void* handle);
void* ptt_stream_start(void* handle, const char* text, const char* voice);
int ptt_prepare_voice(void* handle, const char* voice);
int ptt_stream_read(void* stream_ctx, float** out_samples, int* out_len);
const char* ptt_stream_error(void* stream_ctx);
void ptt_stream_cancel(void* stream_ctx);
void ptt_stream_end(void* stream_ctx);
}

namespace {

std::atomic<bool> g_shutdown{false};

// The signal handler only stores the flag. The reader thread observes it on
// its bounded wait and notifies the main loop, and the synthesis read loop
// checks it per chunk, so an external SIGTERM still exits promptly.
void on_signal(int) { g_shutdown.store(true); }

std::string json_escape(const std::string& value) {
    std::string out;
    out.reserve(value.size() + 2);
    for (char c : value) {
        switch (c) {
            case '"': out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            default:
                if (c >= 0 && c < 0x20) {
                    char buf[8];
                    std::snprintf(buf, sizeof(buf), "\\u%04x", c);
                    out += buf;
                } else {
                    out += c;
                }
        }
    }
    return out;
}

void emit(const std::string& line) {
    std::cout << line << "\n" << std::flush;
}

std::string field(const std::string& line, const std::string& key) {
    const std::string needle = "\"" + key + "\"";
    const size_t at = line.find(needle);
    if (at == std::string::npos) return "";
    const size_t colon = line.find(':', at + needle.size());
    if (colon == std::string::npos) return "";
    const size_t quote = line.find('"', colon + 1);
    if (quote == std::string::npos) return "";
    std::string value;
    for (size_t i = quote + 1; i < line.size(); ++i) {
        const char c = line[i];
        if (c == '\\' && i + 1 < line.size()) {
            const char next = line[i + 1];
            if (next == '"') value += '"';
            else if (next == '\\') value += '\\';
            else if (next == 'n') value += '\n';
            else if (next == 'r') value += '\r';
            else if (next == 't') value += '\t';
            else value += next;
            ++i;
        } else if (c == '"') {
            break;
        } else {
            value += c;
        }
    }
    return value;
}

long peak_rss_bytes() {
#ifdef _WIN32
    PROCESS_MEMORY_COUNTERS counters;
    if (GetProcessMemoryInfo(GetCurrentProcess(), &counters, sizeof(counters)) == 0) return 0;
    return static_cast<long>(counters.PeakWorkingSetSize);
#else
    struct rusage usage;
    if (getrusage(RUSAGE_SELF, &usage) != 0) return 0;
#ifdef __APPLE__
    return static_cast<long>(usage.ru_maxrss);
#else
    return static_cast<long>(usage.ru_maxrss) * 1024;
#endif
#endif
}

std::string chunk_path(const std::string& directory, int index) {
    char name[64];
    std::snprintf(name, sizeof(name), "raw-%06d.wav", index);
    return directory + "/" + name;
}

struct ActiveStream {
    void* ctx = nullptr;
    std::string request_id;
    std::atomic<bool> cancelled{false};
};

std::mutex g_active_mtx;
ActiveStream* g_active = nullptr;

// Called on the stdin thread. Everything observable happens under the active
// lock so a completing synthesis cannot free the state mid-cancel. Never
// joins or frees: it only wakes the blocked read so the synthesis observes
// the cancel flag, drains, and reports `cancelled` with the model still
// loaded. Lock order is always active-then-stream; the synthesis path never
// nests them in reverse.
void cancel_active() {
    void* ctx = nullptr;
    {
        std::lock_guard<std::mutex> lock(g_active_mtx);
        if (g_active == nullptr) return;
        g_active->cancelled.store(true);
        ctx = g_active->ctx;
    }
    ptt_stream_cancel(ctx);
}

void request_cancel(const std::string& request_id) {
    void* ctx = nullptr;
    {
        std::lock_guard<std::mutex> lock(g_active_mtx);
        if (g_active == nullptr || g_active->request_id != request_id) return;
        g_active->cancelled.store(true);
        ctx = g_active->ctx;
    }
    ptt_stream_cancel(ctx);
}

}  // namespace

int main(int argc, char** argv) {
    std::signal(SIGTERM, on_signal);
    std::signal(SIGINT, on_signal);

    std::string models_dir = "models";
    std::string voice_file;
    std::string precision = "mixed";
    float temperature = 0.3f;
    int lsd_steps = 1;
    int num_threads = 2;
    for (int i = 1; i < argc; ++i) {
        const std::string arg = argv[i];
        auto next = [&] {
            if (i + 1 >= argc) {
                std::cerr << "Missing value for " << arg << "\n";
                std::exit(2);
            }
            return std::string(argv[++i]);
        };
        if (arg == "--models") models_dir = next();
        else if (arg == "--voice") voice_file = next();
        else if (arg == "--precision") precision = next();
        else if (arg == "--temperature") temperature = std::stof(next());
        else if (arg == "--lsd-steps") lsd_steps = std::stoi(next());
        else if (arg == "--threads") num_threads = std::stoi(next());
        else {
            std::cerr << "Unknown argument: " << arg << "\n";
            return 2;
        }
    }
    if (voice_file.empty()) {
        emit("{\"type\":\"startup-failed\",\"message\":\"Pocket voice reference was not provided.\"}");
        return 1;
    }

    void* handle = ptt_create(models_dir.c_str(), models_dir.c_str(),
                              (models_dir + "/tokenizer.model").c_str(), precision.c_str(),
                              temperature, lsd_steps, num_threads);
    if (handle == nullptr) {
        emit("{\"type\":\"startup-failed\",\"message\":\"Pocket speech runtime failed to load. Reinstall Jarvis.\"}");
        return 1;
    }
    if (ptt_warmup(handle) < 0) {
        emit("{\"type\":\"startup-failed\",\"message\":\"Pocket speech runtime failed to warm. Reinstall Jarvis.\"}");
        ptt_destroy(handle);
        return 1;
    }
    // Encode the configured voice once up front. The first synthesis and an
    // interruption during it otherwise pay encoder inference before any
    // cancellable streaming work begins.
    if (ptt_prepare_voice(handle, voice_file.c_str()) != 0) {
        emit("{\"type\":\"startup-failed\",\"message\":\"Pocket voice reference failed to load. Reinstall Jarvis.\"}");
        ptt_destroy(handle);
        return 1;
    }
    emit("{\"type\":\"ready\",\"sampleRate\":24000,\"engineId\":\"pocket-2026-04\"}");

    std::mutex cmd_mtx;
    std::condition_variable cmd_cv;
    std::queue<std::string> commands;
    bool stdin_closed = false;
    // The reader owns no model state; it only routes lines. It returns on
    // EOF, on shutdown, or when the shutdown flag appears, so the main thread
    // can always join it before exit. (Joining a thread blocked inside stdio
    // at exit deadlocks the C library's flush, and closing a pipe fd does not
    // wake a blocked read on Linux, so the reader must exit by itself.)
    std::thread stdin_thread([&] {
        std::string line;
#ifdef _WIN32
        while (std::getline(std::cin, line)) {
            const std::string type = field(line, "type");
            if (type == "cancel") {
                request_cancel(field(line, "requestId"));
                continue;
            }
            if (type == "shutdown") {
                g_shutdown.store(true);
                cancel_active();
                cmd_cv.notify_all();
                return;
            }
            {
                std::lock_guard<std::mutex> lock(cmd_mtx);
                commands.push(line);
            }
            cmd_cv.notify_one();
        }
#else
        // Bounded wait: shutdown and external signals surface within
        // STDIN_POLL_MS even with no further input.
        static constexpr int STDIN_POLL_MS = 200;
        std::string buffered;
        while (!g_shutdown.load()) {
            fd_set readable;
            FD_ZERO(&readable);
            FD_SET(STDIN_FILENO, &readable);
            struct timeval timeout;
            timeout.tv_sec = 0;
            timeout.tv_usec = STDIN_POLL_MS * 1000;
            const int ready = ::select(STDIN_FILENO + 1, &readable, nullptr, nullptr, &timeout);
            if (g_shutdown.load()) break;
            if (ready < 0) break;
            if (ready == 0) continue;
            char chunk[4096];
            const ssize_t count = ::read(STDIN_FILENO, chunk, sizeof(chunk));
            if (count <= 0) break;
            buffered.append(chunk, static_cast<size_t>(count));
            size_t newline;
            while ((newline = buffered.find('\n')) != std::string::npos) {
                line = buffered.substr(0, newline);
                if (!line.empty() && line.back() == '\r') line.pop_back();
                buffered.erase(0, newline + 1);
                const std::string type = field(line, "type");
                if (type == "cancel") {
                    request_cancel(field(line, "requestId"));
                    continue;
                }
                if (type == "shutdown") {
                    g_shutdown.store(true);
                    cancel_active();
                    cmd_cv.notify_all();
                    return;
                }
                {
                    std::lock_guard<std::mutex> lock(cmd_mtx);
                    commands.push(line);
                }
                cmd_cv.notify_one();
            }
        }
#endif
        {
            std::lock_guard<std::mutex> lock(cmd_mtx);
            stdin_closed = true;
        }
        cmd_cv.notify_one();
    });

    auto run_synthesis = [&](const std::string& request_id, const std::string& text,
                             const std::string& output) {
        const auto started = std::chrono::steady_clock::now();
        const clock_t cpu_start = std::clock();
        bool first_chunk = true;
        double first_chunk_ms = 0;
        int chunks = 0;
        long samples = 0;

        ActiveStream active;
        active.request_id = request_id;
        {
            std::lock_guard<std::mutex> lock(g_active_mtx);
            if (g_active != nullptr) {
                emit("{\"type\":\"failed\",\"requestId\":\"" + json_escape(request_id) +
                     "\",\"message\":\"Pocket received overlapping synthesis work.\"}");
                return;
            }
            g_active = &active;
        }

        void* stream = ptt_stream_start(handle, text.c_str(), voice_file.c_str());
        if (stream == nullptr) {
            std::lock_guard<std::mutex> lock(g_active_mtx);
            g_active = nullptr;
            emit("{\"type\":\"failed\",\"requestId\":\"" + json_escape(request_id) +
                 "\",\"message\":\"Pocket could not start synthesis.\"}");
            return;
        }
        {
            // Publish the stream handle under the same lock the cancel path
            // takes: a cancel that lands during startup still wakes the read
            // loop below instead of missing the handle.
            std::lock_guard<std::mutex> lock(g_active_mtx);
            active.ctx = stream;
            if (active.cancelled.load()) ptt_stream_cancel(stream);
        }
        bool failed = false;
        std::string failure;
        while (!g_shutdown.load()) {
            float* pcm = nullptr;
            int length = 0;
            const int status = ptt_stream_read(stream, &pcm, &length);
            if (status < 0) {
                const char* detail = ptt_stream_error(stream);
                failure = (detail != nullptr && detail[0] != '\0') ? detail : "Pocket synthesis failed.";
                failed = true;
                break;
            }
            if (status == 0) break;
            const std::string path = chunk_path(output, chunks);
            try {
                write_wav_f32(path, pcm, static_cast<size_t>(length), 24000);
            } catch (const std::exception& e) {
                ptt_free_audio(pcm);
                failure = e.what();
                failed = true;
                break;
            }
            ptt_free_audio(pcm);
            if (first_chunk) {
                first_chunk = false;
                first_chunk_ms =
                    std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - started)
                        .count();
            }
            emit("{\"type\":\"chunk\",\"requestId\":\"" + json_escape(request_id) + "\",\"index\":" +
                 std::to_string(chunks) + ",\"path\":\"" + json_escape(path) + "\"}");
            chunks += 1;
            samples += length;
            if (active.cancelled.load() || g_shutdown.load()) break;
        }
        const bool was_cancelled = active.cancelled.load() || g_shutdown.load();
        ptt_stream_end(stream);
        {
            std::lock_guard<std::mutex> lock(g_active_mtx);
            g_active = nullptr;
        }
        if (g_shutdown.load()) return;
        if (was_cancelled) {
            emit("{\"type\":\"cancelled\",\"requestId\":\"" + json_escape(request_id) + "\"}");
            return;
        }
        if (failed) {
            emit("{\"type\":\"failed\",\"requestId\":\"" + json_escape(request_id) +
                 "\",\"message\":\"" + json_escape(failure) + "\"}");
            return;
        }
        const double wall_ms =
            std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - started)
                .count();
        const double cpu_ms = static_cast<double>(std::clock() - cpu_start) * 1000.0 / CLOCKS_PER_SEC;
        std::ostringstream body;
        body << "{\"type\":\"synthesis-finished\",\"requestId\":\"" << json_escape(request_id)
             << "\",\"chunkCount\":" << chunks << ",\"totalSamples\":" << samples
             << ",\"sampleRate\":24000,\"synthesisDurationMs\":" << wall_ms
             << ",\"synthesisCpuMs\":" << cpu_ms << ",\"peakRssBytes\":" << peak_rss_bytes();
        if (!first_chunk) body << ",\"firstChunkReadyMs\":" << first_chunk_ms;
        body << "}";
        emit(body.str());
    };

    while (!g_shutdown.load()) {
        std::string line;
        {
            std::unique_lock<std::mutex> lock(cmd_mtx);
            cmd_cv.wait(lock, [&] { return !commands.empty() || stdin_closed || g_shutdown.load(); });
            if (g_shutdown.load()) break;
            if (commands.empty()) break;
            line = commands.front();
            commands.pop();
        }
        const std::string type = field(line, "type");
        if (type != "synthesize") continue;
        run_synthesis(field(line, "requestId"), field(line, "text"), field(line, "outputDirectory"));
    }

    // Shut the stdin reader down before exiting: the reader returns by
    // itself on EOF, shutdown, or the shutdown flag (see above), so joining
    // it here is bounded and avoids the exit-time stdio flush deadlock.
    stdin_thread.join();
    ptt_destroy(handle);
    return 0;
}
