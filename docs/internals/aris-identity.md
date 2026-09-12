# ARIS identity

ARIS is the product name. Jarvis remains only inside code identifiers, file paths, and shipped data names that cannot change without breaking installs, updates, routes, or stored state.

## Visible name

- Display name is `ARIS`. Nightly desktop builds show `ARIS (Nightly)`.
- Mobile variants show `ARIS Dev`, `ARIS Preview`, and `ARIS`.
- Web boot title, splash, and PWA manifest say ARIS. The command palette offers `Open ARIS`.
- Web control center, onboarding, sidebar, and mobile screens say ARIS.
- Desktop tray shows `Open ARIS` and `Talk to ARIS`. The portal shortcut description says `Hold to talk to ARIS`.
- Desktop voice overlay, portal scope description, and native voice errors say ARIS.
- Desktop update notices name `ARIS Setup` and `ARIS Releases`.
- Mobile theme picker, push channel, activity title, and voice failure copy say ARIS.
- CLI, service, pairing, auth, and provider copy say ARIS. Settings say `ARIS settings`.
- Install and updating guides say ARIS. The voice prompts, mesh errors, and reporter say ARIS.
- DMG backgrounds and the `assets/jarvis/jarvis-mark.svg` title say ARIS. Mark geometry is unchanged.

## Interface treatment

- Web and desktop use square panels and controls with crisp 1px rules. Control radius is `0.1875rem`, settings pulse is `3px`, composer corners are `4px`. Glass blur is `0px` with full opacity.
- Stage art is graphite with a restrained amber rule. Built-in theme IDs and mobile theme IDs are unchanged, and theme storage keys stay `t3code:*`.
- The rebrand changes visible copy, palette, and corner treatment only. Installed identities below are unchanged.

## Intentionally unchanged

- Bundle and app IDs: `com.abstergo.jarvis`, `com.abstergo.jarvis.dev`, `com.abstergo.jarvis.preview`.
- Deep links and schemes: `jarvis`, `jarvis-dev`, `t3code`, `t3code-dev`, `t3code-preview`, mobile linking key `Jarvis` with linking path `jarvis`, web route `/jarvis`, mobile route name `Jarvis`.
- CLI command name `t3`, `npx t3@` invocations, and `t3 service install` wording.
- Asset and icon paths: `/jarvis-mark.png`, `assets/jarvis/*`, `apps/desktop/resources/dmg/*`.
- Data namespaces: `jarvis` and `Jarvis` user-data directory names, `.jarvis` config paths, `~/.jarvis-headless`, `JARVIS_*` environment variables, `jarvis-resources` voice destination, `jarvis-official-release.json` marker, `unified-jarvis` and `official-jarvis` distribution names, `t3code:*` storage keys.
- Release and update endpoints: `https://github.com/Absterrg0/Jarvis/releases/tag` tag base URL, desktop artifact filename `Jarvis-${version}-${arch}.${ext}`.
- Code identifiers: file names, exported `JARVIS_*` constants, type and function names, IPC channels, the `DesktopStartupProbe` receipt product, migration IDs 41 through 58 including the `Jarvis*` migration names.
- Upstream attribution: `pingdotgg/t3code` release URL, `T3CODE_*` settings, the `docs/internals/jarvis-t3-boundary.md` path, the `t3 triage` playbook copy that must stay byte-identical to `.github/triage/PLAYBOOK.md`, and the `T3 Connect` feature name.
- Example catalog names: the semantic prompt and user guide use Jarvis as an example project alongside Rivvl, matching the eval examples owned by the verifier lane. This is an explicit rebrand exception: the disambiguation examples only work against the fixture names the evaluator asserts, so the example survives until the verifier lane renames its fixtures.

## Notes

- Speech lifecycle copy in `mobileJarvisTurn.ts` and `JarvisMobileProvider.tsx` already said ARIS before this pass, so behavior there is untouched.
- Core interpretation keeps its grammar and span rules. Only product words in user-facing prompts changed.
- User docs `docs/user/jarvis.md`, `docs/user/jarvis-mobile.md`, and `docs/internals/jarvis-controller.md` now describe ARIS. File names, link targets, and route IDs are unchanged.
