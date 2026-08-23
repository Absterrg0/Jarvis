# Jarvis native microphone provenance

This package vendors the minimal Rust/Neon binding source from `node-cpal`
0.1.1 at commit
`72e6e68af8be9c15ce2aa1f760c96997411a615b`:

<https://github.com/saeta-eth/node-cpal/tree/72e6e68af8be9c15ce2aa1f760c96997411a615b>

The vendored source is ISC-licensed. Jarvis keeps the source and lockfile in
this repository so native release builds are reproducible and never download
or execute a build from GitHub at packaging time. See `LICENSE` for the
preserved ISC grant.
