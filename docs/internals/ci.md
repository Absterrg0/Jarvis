# CI quality gates

> For maintainers. Using T3 Code? See [docs/user](../user/).

[`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) runs on pull requests and pushes to
`main`. Its current gates are:

- **Check**: lint Jarvis-owned paths, typecheck the Jarvis runtime packages plus the server, build
  the desktop pipeline, and verify the preload bundle markers.
- **Test**: run non-server workspace tests in parallel and server tests in three shards, publishing
  the transfer-budget result when produced.
- **Rust**: format-check and test the resource monitor.
- **Mobile Native Static Analysis**: a Linux change detector gates the macOS
  `scripts/mobile-native-static-check.ts` job. The detector fails open when GitHub cannot provide a
  complete changed-file list.
- **Release Smoke**: exercise release-only workflow contracts through
  `scripts/release-smoke.ts` without publishing artifacts.

Jarvis native packaging uses reusable workflows rather than the obsolete upstream release graph:

- [`jarvis-desktop-linux.yml`](../../.github/workflows/jarvis-desktop-linux.yml) runs focused desktop,
  voice, microphone, and Linux startup tests; builds the Full AppImage; checks the official marker,
  native resources, and absence of Companion payloads; then runs packaged voice and GUI startup
  smoke gates.
- [`jarvis-desktop-mac.yml`](../../.github/workflows/jarvis-desktop-mac.yml) applies the preview versus
  stable Apple signing policy, runs focused contracts/typechecks, builds DMGs, verifies the Full
  marker/resources and bundle identity, and validates the installed LaunchServices startup path.
- [`jarvis-setup-windows.yml`](../../.github/workflows/jarvis-setup-windows.yml) runs setup, native
  voice, server/controller, and Jarvis UI tests; builds the role-selecting setup; verifies payload
  markers/signatures when enabled; and exercises clean install, upgrade, startup, and uninstall
  gates.
- [`jarvis-companion-release.yml`](../../.github/workflows/jarvis-companion-release.yml) runs
  Companion-focused tests/typecheck and speech smoke, packages Windows and Linux Companion artifacts,
  validates their isolated payloads/startup, and publishes Companion updater metadata.

[`jarvis-release.yml`](../../.github/workflows/jarvis-release.yml) is the release coordinator. Its
preflight verifies the current `main` SHA, package versions, tag identity, and channel; stable
publication fails closed without complete Apple and Azure signing credentials. It then calls the
native workflows, stages the exact artifact matrix, and promotes one release through
`scripts/jarvis-release-transaction.ts`.

See [Release Checklist](../operations/release.md) for the full release/signing setup checklist.
