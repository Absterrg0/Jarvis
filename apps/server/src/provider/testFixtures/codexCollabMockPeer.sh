#!/usr/bin/env bash
# Wrapper so CodexSessionRuntime can spawn the mock peer: the runtime always
# passes "app-server" as the first argument (real codex CLI subcommand).
# Keep other subcommands so the peer can also stand in for `codex exec`.
if [[ "$1" == "app-server" ]]; then
  shift
fi
exec node "$(dirname "$0")/codexCollabMockPeer.mjs" "$@"
