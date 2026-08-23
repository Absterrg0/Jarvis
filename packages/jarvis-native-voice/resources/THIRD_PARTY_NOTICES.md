# Jarvis native voice notices

Jarvis downloads and redistributes the following offline speech components:

- **NVIDIA Parakeet TDT/CTC 110M** model weights, licensed under
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Model and attribution:
  <https://huggingface.co/nvidia/parakeet-tdt_ctc-110m>.
- **Kokoro 82M** model weights, licensed under Apache License 2.0. Model and attribution:
  <https://huggingface.co/hexgrad/Kokoro-82M>. The downloaded sherpa-onnx archive also includes
  its model license and voice/data notices.
- **sherpa-onnx**, Copyright the sherpa development team, licensed under Apache License 2.0:
  <https://github.com/k2-fsa/sherpa-onnx>.
- **Jarvis native microphone**, vendored from node-cpal 0.1.1 at commit
  `72e6e68af8be9c15ce2aa1f760c96997411a615b`, licensed under ISC. See the
  package's `NOTICE.md` and `PROVENANCE.json`.

The complete license texts shipped by npm dependencies remain in their packaged modules.
