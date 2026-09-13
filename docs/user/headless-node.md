# Circe Headless Node

Circe Headless Node runs the execution runtime on a Linux VPS without a GUI or speech models.
Your laptop or desktop can connect to it over Tailscale and send work to the providers installed on
the VPS.

## Install

Download the archive for the VPS architecture (`x64` or `arm64`), copy it to the VPS, and extract
it. The archive includes its own Node runtime and production dependencies; Git, the Circe source
tree, pnpm, and a separate Node installation are not required.

```sh
tar -xzf Circe-Headless-Node-<version>-linux-<arch>.tar.gz
cd circe-headless-node-<version>-linux-<arch>
./install.sh
```

The installer creates a user systemd service named `circe-headless.service`, starts it, and enables
it for future logins. It stores the node under `~/.circe-headless` by default. To choose another
location, set `CIRCE_HEADLESS_HOME` when installing and when running the helper commands.

If the VPS does not keep a user session, enable user service lingering once as an administrator:

```sh
loginctl enable-linger "$USER"
```

Install the provider CLIs you want to use on the VPS and authenticate them there. Provider
credentials stay on the execution node; the archive does not include provider CLIs or credentials.

## Pair and check the service

Run the bundled T3 pairing command on the VPS, then enter the pairing details on the controlling
Circe device (all paths below honor `$CIRCE_HEADLESS_HOME`, default `~/.circe-headless`):

```sh
$CIRCE_HEADLESS_HOME/node/bin/node \
  $CIRCE_HEADLESS_HOME/runtime/versions/*/node_modules/t3/dist/bin.mjs pair
$CIRCE_HEADLESS_HOME/bin/status.sh
```

The service log is at `$CIRCE_HEADLESS_HOME/userdata/logs/boot-service.log`. Circe projects, settings,
and other node state remain under `$CIRCE_HEADLESS_HOME/userdata`; provider credentials remain on the
VPS in the provider's own storage.

## Update and uninstall

Run `./install.sh` from a newer extracted archive to update the packaged runtime. The installer
stops the service while replacing only its runtime payload, then starts it again. User data is
preserved.

To remove the service and packaged runtime while keeping node data:

```sh
~/.circe-headless/bin/uninstall.sh
```

To remove the service, packaged runtime, and all node data, pass the explicit purge flag:

```sh
~/.circe-headless/bin/uninstall.sh --purge-data
```
