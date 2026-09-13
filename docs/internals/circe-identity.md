# Circe identity

Circe is the product name and the only name used across visible copy, code, packages, installed identities, and stored data. The earlier split (visible ARIS with reserved Jarvis identifiers) is gone; there is no reserved codename.

## What is Circe

- Display name `Circe`; nightly desktop builds show `Circe (Nightly)`; mobile variants show `Circe Dev`, `Circe Preview`, `Circe`.
- App and bundle IDs: `com.abstergo.circe`, `com.abstergo.circe.dev`, `com.abstergo.circe.preview`.
- Desktop schemes `circe` and `circe-dev`, plus the upstream mobile schemes `t3code`, `t3code-dev`, `t3code-preview`.
- Packages `@circe/core`, `@circe/client-runtime`, `@circe/relay`, in `packages/circe-*`.
- Data: `~/.circe`, `~/.circe-headless`, `.circe` config paths, `CIRCE_*` environment variables, `circe-resources`, `circe-official-release.json`, `official-circe` and `unified-circe`.
- Release endpoints `https://github.com/Absterrg0/Circe/releases` with artifacts `Circe-${version}-${arch}.${ext}`.
- Migrations keep numeric IDs 41 through 58 and their `Circe*` names.
- Relay resources, Clerk audience, and OTLP variables are Circe-named (`circe-relay`, `CIRCE_RELAY_URL`).

## Upstream T3 names that stay

- CLI command `t3`, `npx t3@` invocations, `t3 service install`, and `t3 connect`.
- `T3CODE_*` settings that predate the fork.
- `t3code:*` storage keys and the upstream mobile schemes.
- The `pingdotgg/t3code` release URL and the `t3 triage` playbook copy that must stay byte-identical to `.github/triage/PLAYBOOK.md`.

## Example catalog names

The semantic fixtures use `Beacon` as the example project alongside `Rivvl`. The assistant name is reserved, so an example project must not be named `Circe`: a project named the same as the assistant fuzzy-matches the assistant name during grounding.
