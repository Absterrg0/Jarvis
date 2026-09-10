# Jarvis native voice notices

Jarvis downloads and redistributes the following offline speech components:

- **NVIDIA Parakeet TDT/CTC 110M** model weights, licensed under
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Model and attribution:
  <https://huggingface.co/nvidia/parakeet-tdt_ctc-110m>.
- **Pocket TTS English 2026-04** ONNX weights, optimized export by stephvax,
  licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
  Base model Kyutai Pocket TTS: <https://github.com/kyutai-labs/pocket-tts>.
  Export and attribution: <https://huggingface.co/stephvax/pocket-tts-onnx>.
- **Alba casual voice reference** (first three seconds, mono 24 kHz), voice
  acted by Alba MacKenna, licensed under
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Source:
  <https://huggingface.co/kyutai/tts-voices> (`alba-mackenna/casual.wav`).
- **PocketTTS.cpp** native runtime, Copyright VolgaGerm, licensed under the MIT
  License: <https://github.com/VolgaGerm/PocketTTS.cpp>. The desktop build
  compiles the pinned revision with the production edits in
  `packages/jarvis-native-voice/native/pocket` into a standalone daemon that
  links its own ONNX Runtime 1.23.2 (MIT) and SentencePiece (Apache-2.0),
  isolated from the frozen voice host.
- **sherpa-onnx**, Copyright the sherpa development team, licensed under Apache License 2.0:
  <https://github.com/k2-fsa/sherpa-onnx>.
- **Pipecat 1.7.0**, Copyright Daily, licensed under the BSD 2-Clause License:
  <https://github.com/pipecat-ai/pipecat>.
- **ONNX Runtime 1.27.1**, Copyright Microsoft Corporation, licensed under the MIT License:
  <https://github.com/microsoft/onnxruntime>.
- **Python 3.12**, Copyright the Python Software Foundation, licensed under the PSF License:
  <https://docs.python.org/3/license.html>.
- **PyInstaller**, used to produce the standalone voice host, licensed under GPL-2.0-or-later
  with the PyInstaller bootloader exception:
  <https://pyinstaller.org/en/stable/license.html>.
- The Pipecat host also redistributes its pinned Python runtime closure, including NumPy (BSD),
  soxr (LGPL-2.1-or-later), Pydantic (MIT), aiohttp (Apache-2.0/MIT), Protobuf (BSD-3-Clause),
  PyYAML (MIT), and WebSockets (BSD-3-Clause). Exact
  versions are recorded in `apps/desktop/pipecat/uv.lock`.
- **node-cpal 0.1.1**, Node.js bindings for CPAL, licensed under ISC:
  <https://github.com/saeta-eth/node-cpal/tree/72e6e68af8be9c15ce2aa1f760c96997411a615b>.

The complete license texts shipped by npm dependencies remain in their packaged modules.
