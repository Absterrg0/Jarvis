// @effect-diagnostics nodeBuiltinImport:off

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { assert, describe, it } from "@effect/vitest";

const componentWorkflows = [
  "circe-desktop-linux.yml",
  "circe-desktop-mac.yml",
  "circe-setup-windows.yml",
  "headless-node-release.yml",
] as const;

const readWorkflow = (name: string) =>
  NodeFS.readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), "utf8");

const stableTagTrigger = /\n  push:\n    tags:\n(?:      - .*\n)+/;
const releaseMutation = /softprops\/action-gh-release|gh release (?:create|upload|edit|delete)/;

describe("Circe release workflow contracts", () => {
  it("has one manual coordinator that promotes after all builds", () => {
    const coordinatorPath = new URL("../.github/workflows/circe-release.yml", import.meta.url);
    assert.isTrue(NodeFS.existsSync(coordinatorPath), "coordinator workflow is missing");

    const coordinator = NodeFS.readFileSync(coordinatorPath, "utf8");
    assert.include(coordinator, "workflow_dispatch:");
    assert.include(coordinator, "channel:");
    assert.include(coordinator, "- preview");
    assert.include(coordinator, "v${version}-preview.${RELEASE_RUN_NUMBER}");
    assert.isFalse(/^\s{2}push:/m.test(coordinator), "coordinator must be manual-only");

    assert.include(coordinator, "uses: ./.github/workflows/circe-desktop-linux.yml");
    assert.include(coordinator, "uses: ./.github/workflows/circe-setup-windows.yml");
    assert.include(coordinator, "uses: ./.github/workflows/headless-node-release.yml");

    const preflightStart = coordinator.indexOf("\n  preflight:");
    const firstBuildStart = coordinator.indexOf("\n  build_linux:");
    const preflight = coordinator.slice(preflightStart, firstBuildStart);
    assert.include(
      preflight,
      'node scripts/circe-release-transaction.ts preflight "$RELEASE_VERSION" "$GITHUB_SHA"',
    );
    assert.include(preflight, "Apple release credentials");
    assert.include(preflight, "CSC_LINK");
    assert.notInclude(preflight, "CLERK_PUBLISHABLE_KEY or CLERK_PASSKEY_RP_DOMAINS");
    assert.notInclude(preflight, "MACOS_PROVISIONING_PROFILE");
    const nodeSetupIndex = coordinator.indexOf("uses: actions/setup-node@v6");
    const releaseStatePreflightIndex = coordinator.indexOf(
      "name: Preflight existing GitHub release state",
    );
    assert.isAtLeast(nodeSetupIndex, 0, "preflight must pin Node.js from package.json");
    assert.include(coordinator, "node-version-file: package.json");
    assert.isBelow(nodeSetupIndex, releaseStatePreflightIndex);
    assert.notInclude(preflight, "releases?per_page=100");
    assert.notInclude(preflight, "published_count");
    assert.notInclude(preflight, "draft_count");
    assert.notInclude(preflight, ".draft == true");
    assert.notInclude(preflight, "reusable draft release");

    const promoteIndex = coordinator.indexOf("\n  promote:");
    assert.isAtLeast(promoteIndex, 0, "coordinator needs one promote job");
    const promote = coordinator.slice(promoteIndex);
    assert.include(promote, "needs:");
    assert.include(
      promote,
      "needs: [preflight, build_linux, build_windows, build_mac, build_headless]",
    );
    assert.include(promote, "build_linux");
    assert.include(promote, "build_windows");
    assert.include(promote, "build_headless");
    assert.include(coordinator, "scripts/circe-release-transaction.ts release-assets");
    assert.include(coordinator, "Circe-Setup.exe");
    assert.notInclude(coordinator, ".zip");
    assert.include(coordinator, "VERSION: ${{ needs.preflight.outputs.version }}");
    assert.notInclude(coordinator, "\n      RELEASE_TAG:");
    assert.include(coordinator, "build_mac:");
    assert.include(coordinator, "circe-desktop-mac.yml");
    assert.include(coordinator, "downloads/mac");
    assert.include(coordinator, ".dmg");
    assert.include(coordinator, "CIRCE_RELEASE_PRERELEASE");
    assert.include(coordinator, "CIRCE_RELEASE_MAKE_LATEST");
    const transaction = NodeFS.readFileSync(
      new URL("./circe-release-transaction.ts", import.meta.url),
      "utf8",
    );
    assert.include(transaction, "these artifacts are unsigned");
    assert.include(transaction, "Windows SmartScreen");
    assert.include(transaction, "macOS Gatekeeper");
    assert.include(transaction, "Verify the hashes before proceeding");
    assert.include(coordinator, "Existing tag $tag resolves");
    assert.include(
      coordinator,
      'if tag_ref="$(gh api "repos/$GITHUB_REPOSITORY/git/ref/tags/$tag" 2>/dev/null)"; then',
    );
    assert.notInclude(coordinator, 'git/ref/tags/$tag" 2>/dev/null || true');
    assert.notInclude(coordinator, "gh release upload");
    assert.notInclude(coordinator, "gh release create");
    assert.notInclude(coordinator, "releases/$RELEASE_ID");
    assert.equal((coordinator.match(/contents:\s*write/g) ?? []).length, 1);
  });

  it("bounds coordinator preflight and promotion jobs", () => {
    const coordinator = NodeFS.readFileSync(
      new URL("../.github/workflows/circe-release.yml", import.meta.url),
      "utf8",
    );
    const preflight = coordinator.slice(
      coordinator.indexOf("\n  preflight:"),
      coordinator.indexOf("\n  build_linux:"),
    );
    const promote = coordinator.slice(coordinator.indexOf("\n  promote:"));
    assert.include(preflight, "timeout-minutes: 15");
    assert.include(promote, "timeout-minutes: 30");
  });

  it("checks only the shallow current main ref during preflight", () => {
    const coordinator = NodeFS.readFileSync(
      new URL("../.github/workflows/circe-release.yml", import.meta.url),
      "utf8",
    );
    const preflight = coordinator.slice(
      coordinator.indexOf("\n  preflight:"),
      coordinator.indexOf("\n  build_linux:"),
    );
    assert.include(preflight, "ref: refs/heads/main");
    assert.include(preflight, "fetch-depth: 1");
    assert.include(preflight, "fetch-tags: false");
    assert.notInclude(preflight, "fetch-depth: 0");
    assert.include(preflight, "git fetch --force origin refs/heads/main:refs/remotes/origin/main");
    assert.notInclude(preflight, "git fetch --force --tags origin main");
    assert.include(preflight, "git rev-parse refs/remotes/origin/main");
    assert.include(preflight, 'gh api "repos/$GITHUB_REPOSITORY/git/ref/tags/$tag');
  });

  it("keeps component workflows reusable, build-only, and tag-free", () => {
    for (const name of componentWorkflows) {
      const workflow = readWorkflow(name);
      assert.include(workflow, "workflow_call:", `${name} must be reusable`);
      assert.include(workflow, "workflow_dispatch:", `${name} must support manual debugging`);
      assert.isFalse(stableTagTrigger.test(workflow), `${name} must not trigger on stable tags`);
      assert.isFalse(releaseMutation.test(workflow), `${name} must not mutate releases`);
    }
  });

  it("adapts the release graph to the fork", () => {
    const workflow = readWorkflow("release.yml");
    assert.include(workflow, "workflow_dispatch:");
    assert.notMatch(workflow, /^\s+(push|schedule):/m);
    assert.include(workflow, "github.repository == 'Absterrg0/circe'");
    assert.notInclude(workflow, "runs-on: blacksmith-");
    assert.include(workflow, "runs-on: ubuntu-24.04");
    assert.include(workflow, "name: Release quality checks");
  });

  it("checks npm trust before any release builds and supports a check-only dispatch", () => {
    const workflow = readWorkflow("release.yml");
    const npmPreflight = workflow.slice(
      workflow.indexOf("\n  npm_preflight:"),
      workflow.indexOf("\n  resolve_commit:"),
    );
    assert.include(npmPreflight, "id-token: write");
    assert.include(npmPreflight, "timeout-minutes: 3");
    assert.include(npmPreflight, "node scripts/check-npm-publish.mjs");
    assert.notInclude(npmPreflight, "run-install:");
    assert.include(workflow, "preflight_only:");
    assert.include(workflow, "format('preflight-{0}', github.ref)");
    assert.include(workflow, "needs: [npm_preflight]\n    if: ${{ !inputs.preflight_only }}");
    for (const job of ["relay_public_config", "build_wsl_node_pty"]) {
      const section = workflow.slice(workflow.indexOf(`\n  ${job}:`) + 1);
      assert.include(section.split(/\n  [a-z_]+:/)[0] ?? "", "needs: [resolve_commit]");
    }
  });

  it("uses the same pinned npm for preflight and publication and exposes exchange errors", () => {
    const workflow = readWorkflow("release.yml");
    const versions = [...workflow.matchAll(/npm install --global npm@([^\s]+)/g)].map(
      (match) => match[1],
    );
    assert.deepEqual(versions, ["11.11.0", "11.11.0"]);
    assert.include(workflow, "NPM_CONFIG_LOGLEVEL: verbose");
  });

  for (const channel of ["latest", "nightly"]) {
    it(`publishes the actual ${channel} installer set without requiring nonexistent ZIPs`, () => {
      const workflow = readWorkflow("release.yml");
      const filenames = [
        "Circe-0.0.52-arm64.dmg",
        "Circe-0.0.52-x64.dmg",
        "Circe-0.0.52-x86_64.AppImage",
        "Circe-0.0.52-x64.exe",
        "Circe-0.0.52-x64.exe.blockmap",
        `${channel}-mac.yml`,
        `${channel}-linux.yml`,
        `${channel}.yml`,
      ];
      const publishPatterns = [...workflow.matchAll(/^            release-assets\/(.+)$/gm)].map(
        (match) => match[1] ?? "",
      );
      assert.isNotEmpty(publishPatterns);
      for (const pattern of publishPatterns) {
        assert.isTrue(
          filenames.some((name) => NodePath.matchesGlob(name, pattern)),
          `Required upload pattern ${pattern} has no output from the release builders`,
        );
      }
      const collector = workflow.slice(
        workflow.indexOf("      - name: Collect release assets"),
        workflow.indexOf("      - name: Collect resource monitor"),
      );
      const collectPatterns = [...collector.matchAll(/"release\/([^"\n]+)"/g)].map(
        (match) => match[1] ?? "",
      );
      assert.isNotEmpty(collectPatterns);
      const collected = [...filenames, "builder-debug.yml"].filter((name) =>
        collectPatterns.some((pattern) => NodePath.matchesGlob(name, pattern)),
      );
      assert.deepEqual(collected, filenames);
    });
  }

  it("uses a shallow checkout for headless packaging", () => {
    const workflow = readWorkflow("headless-node-release.yml");
    assert.include(workflow, "fetch-depth: 1");
    assert.notInclude(workflow, "fetch-depth: 0");
  });

  it("gates public Windows releases on complete Trusted Signing and verifies installed signatures", () => {
    const coordinator = readWorkflow("circe-release.yml");
    const preflight = coordinator.slice(
      coordinator.indexOf("  preflight:"),
      coordinator.indexOf("  build_linux:"),
    );
    assert.include(preflight, "Fail closed without complete Azure Trusted Signing credentials");
    for (const name of [
      "AZURE_TENANT_ID",
      "AZURE_CLIENT_ID",
      "AZURE_CLIENT_SECRET",
      "AZURE_TRUSTED_SIGNING_ENDPOINT",
      "AZURE_TRUSTED_SIGNING_ACCOUNT_NAME",
      "AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME",
      "AZURE_TRUSTED_SIGNING_PUBLISHER_NAME",
    ]) {
      assert.include(preflight, name);
    }
    const windowsCall = coordinator.slice(
      coordinator.indexOf("  build_windows:"),
      coordinator.indexOf("  build_headless:"),
    );
    assert.include(windowsCall, "public_release: ${{ inputs.channel == 'stable' }}");

    const workflow = readWorkflow("circe-setup-windows.yml");
    const gate = workflow.slice(
      workflow.indexOf("      - name: Validate Azure Trusted Signing release gate"),
      workflow.indexOf("      - name: Setup Vite+"),
    );
    assert.include(workflow, "public_release:");
    assert.include(gate, "Azure Trusted Signing is only partially configured");
    assert.include(gate, "Public Circe releases require all Azure Trusted Signing secrets");
    assert.include(gate, "if (-not $publicRelease)");
    assert.include(gate, "CIRCE_WINDOWS_SIGNING_ENABLED=false");
    assert.include(gate, "CIRCE_WINDOWS_SIGNING_ENABLED");
    const desktopBuildStart = workflow.indexOf("      - name: Build desktop payload directory");
    const desktopBuildEnd = workflow.indexOf(
      "      - name: Stage standalone Windows runtime",
      desktopBuildStart,
    );
    const desktopBuild = workflow.slice(desktopBuildStart, desktopBuildEnd);
    assert.include(desktopBuild, "$buildArgs += '--signed'");
    for (const name of [
      "AZURE_TENANT_ID",
      "AZURE_CLIENT_ID",
      "AZURE_CLIENT_SECRET",
      "AZURE_TRUSTED_SIGNING_ENDPOINT",
      "AZURE_TRUSTED_SIGNING_ACCOUNT_NAME",
      "AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME",
      "AZURE_TRUSTED_SIGNING_PUBLISHER_NAME",
    ]) {
      assert.include(desktopBuild, name + ": ${{ secrets." + name + " }}");
    }
    assert.include(workflow, "Get-AuthenticodeSignature -LiteralPath $Path");
    assert.include(workflow, "$env:CIRCE_EXPECTED_PUBLISHER");
    assert.include(workflow, "installed Full Circe.exe");
    assert.include(workflow, "installed Controller Circe.exe");
    assert.include(workflow, "Status -ne 'Valid'");
  });

  it("uses native Mac runners and makes verification fail closed", () => {
    const workflow = readWorkflow("circe-desktop-mac.yml");
    assert.include(workflow, "public_release:");
    assert.include(workflow, "default: false");
    assert.include(workflow, "Apple signing configuration is incomplete");
    assert.include(workflow, 'if [[ "$PUBLIC_RELEASE" != "true" ]]');
    assert.include(workflow, 'echo "signed=false" >> "$GITHUB_OUTPUT"');
    assert.include(
      workflow,
      "Public release disabled; continuing with unsigned preview/manual verification.",
    );
    assert.include(workflow, "macOS passkey configuration is incomplete");
    assert.include(
      workflow,
      "No Apple credentials supplied; continuing with unsigned manual verification.",
    );
    assert.include(
      workflow,
      "Public Circe macOS release is closed: Apple signing/notarization credentials are missing.",
    );
    assert.include(workflow, "runs-on: ${{ matrix.runner }}");
    assert.include(workflow, "runner: macos-15");
    assert.include(workflow, "runner: macos-15-intel");
    assert.notInclude(workflow, "Rosetta");
    assert.notInclude(workflow, "uses: dtolnay/rust-toolchain@stable");
    assert.notInclude(workflow, "build:native");
    assert.include(workflow, "codesign --verify --deep --strict");
    assert.include(workflow, "spctl --assess --type execute");
    assert.include(workflow, "xcrun stapler validate");
    assert.include(workflow, 'xcrun stapler validate "$artifact"');
    assert.include(workflow, 'if [[ "$CIRCE_MAC_SIGNED" == "true" ]]');
    assert.include(workflow, "args+=(--signed)");
    assert.include(workflow, "passkeys=true");
    assert.include(workflow, "if: ${{ steps.signing.outputs.signed == 'true' }}");
    assert.include(workflow, "scripts/mac-desktop-startup-smoke.mjs");
    assert.include(workflow, "scripts/build-desktop-artifact.test.ts");
    assert.include(workflow, "apps/desktop/src/preload.test.ts");
    assert.include(workflow, "apps/desktop/src/shell/DesktopCirceLiveVoiceState.test.ts");
    assert.include(workflow, "live-voice bridge tests");
    assert.include(workflow, "Build Full Desktop DMG");
    assert.notInclude(workflow, "Build Full Desktop DMG and ZIP");
    assert.notInclude(workflow, ".zip");
    assert.include(workflow, 'ditto "$mounted_app" "$copied_app"');
    assert.include(workflow, 'hdiutil detach "$mount_root" -quiet');
    assert.notInclude(workflow, 'device="$(awk');
    assert.include(workflow, "mounted=false");
    assert.include(workflow, "mounted=true");
    assert.include(workflow, 'if [[ "$mounted" == "true" ]]');
    assert.include(workflow, "Refusing to remove the still-mounted DMG");
    const copyIndex = workflow.indexOf('ditto "$mounted_app" "$copied_app"');
    const detachIndex = workflow.indexOf('hdiutil detach "$mount_root" -quiet', copyIndex);
    const launchIndex = workflow.indexOf("scripts/mac-desktop-startup-smoke.mjs", detachIndex);
    assert.isAtLeast(copyIndex, 0, "DMG contents must be copied before launch");
    assert.isAtLeast(detachIndex, 0, "DMG must be detached by mountpoint");
    assert.isBelow(copyIndex, detachIndex, "DMG must be copied before unmounting");
    assert.isBelow(detachIndex, launchIndex, "LaunchServices smoke must run after unmounting");
    assert.include(
      workflow,
      'application_root="$RUNNER_TEMP/circe-applications-${{ matrix.arch }}"',
    );
    assert.notInclude(workflow, "Contents/MacOS/Circe");
    assert.include(workflow, "Contents/Resources/circe-official-release.json");
    assert.include(workflow, "Upload Mac startup log on failure");
    assert.include(workflow, "if: ${{ failure() }}");
    assert.include(workflow, "circe-mac-startup-${{ matrix.arch }}-${{ github.run_id }}");
    assert.notInclude(workflow, "sleep 1");
    assert.notInclude(workflow, "for _ in $(seq");
    const checksumStart = workflow.indexOf("      - name: Write Mac checksums and provenance");
    const uploadStart = workflow.indexOf(
      "      - name: Upload Mac desktop artifacts",
      checksumStart,
    );
    const checksumStep = workflow.slice(checksumStart, uploadStart);
    assert.include(checksumStep, "node -e");
    assert.notInclude(checksumStep, "<<'NODE'");
    assert.include(checksumStep, "done");
  });

  it("verifies the global-hook binding and official release marker on every desktop target", () => {
    const linux = readWorkflow("circe-desktop-linux.yml");
    const mac = readWorkflow("circe-desktop-mac.yml");
    const windows = readWorkflow("circe-setup-windows.yml");
    for (const workflow of [linux, windows]) {
      assert.include(workflow, "uiohook-napi");
      assert.include(workflow, "typeof loaded.start !== 'function'");
      assert.include(workflow, "typeof loaded.stop !== 'function'");
      assert.notInclude(workflow, "typeof loaded.uIOhook !== 'object'");
    }
    const linuxUiohookProbeStart = linux.indexOf(
      'xvfb-run --auto-servernum --server-args="-screen 0 1280x800x24"',
    );
    assert.isAtLeast(linuxUiohookProbeStart, 0);
    const linuxUiohookProbe = linux.slice(linuxUiohookProbeStart, linuxUiohookProbeStart + 1_000);
    assert.include(linuxUiohookProbe, "env ELECTRON_RUN_AS_NODE=1");
    assert.include(linuxUiohookProbe, "typeof loaded.start !== 'function'");
    assert.include(linuxUiohookProbe, "typeof loaded.stop !== 'function'");
    assert.notInclude(linuxUiohookProbe, "--no-sandbox");
    assert.include(mac, "NSMicrophoneUsageDescription");
    assert.include(mac, "node_modules/uiohook-napi");
    assert.include(linux, "resources/circe-official-release.json");
    assert.include(mac, "Contents/Resources/circe-official-release.json");
  });
  it("runs the Linux AppImage GUI smoke on an isolated X11 display", () => {
    const linux = readWorkflow("circe-desktop-linux.yml");
    assert.include(linux, 'x_display=":99"');
    assert.include(
      linux,
      '"$appimage" --ozone-platform=x11 --no-sandbox --disable-gpu --password-store=basic --circe-startup-probe="$probe_file"',
    );
    assert.include(linux, 'XDG_RUNTIME_DIR="$smoke_root/xdg-runtime" DISPLAY="$x_display"');
    assert.include(linux, 'wait -n "$watcher_pid" "$app_pid"');
    assert.include(linux, 'receipt.phase !== "main-window-revealed"');
    assert.include(linux, "renderer mount and window reveal");
    assert.include(linux, 'env ELECTRON_RUN_AS_NODE=1 "$extract_root/squashfs-root/circe"');
    assert.notInclude(linux, "WAYLAND");
    assert.notInclude(linux, "--headless");
  });
});
