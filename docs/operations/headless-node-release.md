# Headless Node Release

> For maintainers. User setup is documented in [Headless Node](../user/headless-node.md).

The headless Linux artifact is a self-contained tarball containing:

- the built server only (the web client is intentionally excluded from this no-UI artifact);
- the production dependency tree produced by `pnpm deploy --prod`;
- a matching Linux Node executable;
- the pinned-runtime launcher and service state;
- a `headless` capability manifest and preset;
- install, status, and uninstall helpers plus a user systemd unit template.

The deterministic artifact names are:

```text
Jarvis-Headless-Node-<version>-linux-x64.tar.gz
Jarvis-Headless-Node-<version>-linux-arm64.tar.gz
```

## Build on Linux

Build the web and server first, then package the host architecture:

```sh
vp run --filter t3 build
pnpm run package:headless:linux:x64
```

The script runs `pnpm deploy --prod --legacy` for the `t3` package, stages it under the pinned
runtime layout, removes the web client, source maps, and the server source directory, and creates a
sorted tarball with normalized timestamps and ownership. It also writes two files beside the
tarball: a `<artifact>.sha256` checksum and a `<artifact>.provenance.json` record containing the
source commit, release version, Linux architecture, bundled Node version, artifact name, and
artifact SHA-256. The archive manifest contains the same source commit, so provenance remains
available after the sidecars are separated from an uploaded artifact. It does not read or write the
live `~/.t3` userdata.

The `Headless Node release` workflow performs this build from a clean checkout on a Linux x64
runner. It runs the focused packaging tests, rejects UI/source/source-map payloads and unsafe
symlinks, starts the bundled CLI with isolated state, and exercises install/update/uninstall with a
fake user `systemctl` while checking that userdata survives. It uploads the archive, checksum, and
provenance as one CI artifact. There is no supported public Linux arm64 runner in this repository,
so CI deliberately publishes x64 only; arm64 must be built on a native Linux arm64 builder (or
with target-architecture deploy dependencies) and is never relabeled from an x64 deployment.

For a real arm64 artifact, run the package step on an arm64 Linux builder (or provide both a target
Node executable and a `--deploy-dir` produced with target-architecture production dependencies):

```sh
node scripts/package-headless-node.ts \
  --arch arm64 \
  --node-executable /path/to/linux-arm64/node \
  --node-version v24.13.1 \
  --deploy-dir /path/to/linux-arm64/t3-deploy
```

The script intentionally refuses to label an x64 host deployment as arm64. Native dependencies
such as `node-pty` must be built for the target architecture. A cross-arch Node executable alone is
not sufficient.

## Inspect and smoke-test an artifact

Use a temporary directory and an isolated home; never install a test artifact into a maintainer's
live home or start it against live T3 data:

```sh
artifact=release/Jarvis-Headless-Node-0.0.34-linux-x64.tar.gz
tar -tzf "$artifact" | sed -n '1,80p'
tmp_home=$(mktemp -d)
tmp_root=$(mktemp -d)
HOME="$tmp_home" tar -xzf "$artifact" -C "$tmp_root"
HOME="$tmp_home" JARVIS_HEADLESS_HOME="$tmp_home/.jarvis-headless" \
  sh -n "$tmp_root"/*/install.sh
"$tmp_root"/*/node/bin/node -e 'console.log(process.arch, process.version)'
if tar -tzf "$artifact" | grep -Eq '(^|/)node_modules/t3/(src(/|$)|dist/client(/|$)|dist/.*\\.map$)'; then
  echo "headless artifact contains the T3 UI, T3 source, or T3 source map payload" >&2
  exit 1
fi
rm -rf "$tmp_home" "$tmp_root"
```

The focused contract test covers the manifest, pinned launcher paths, archive naming, helper
scripts, source-map removal, and production staging:

```sh
pnpm --dir scripts exec vp test run package-headless-node.test.ts
pnpm --filter @t3tools/scripts exec tsgo --noEmit
```

For a manually supplied cross-architecture build, pass the source commit explicitly when the
builder is not the checkout that produced the deploy directory:

```sh
node scripts/package-headless-node.ts \
  --arch arm64 \
  --node-executable /path/to/linux-arm64/node \
  --node-version v24.13.1 \
  --source-commit "$(git rev-parse HEAD)" \
  --deploy-dir /path/to/linux-arm64/t3-deploy
```
