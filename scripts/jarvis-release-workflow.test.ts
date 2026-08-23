// @effect-diagnostics nodeBuiltinImport:off

import * as NodeFS from "node:fs";
import { assert, describe, it } from "@effect/vitest";

const componentWorkflows = [
  "jarvis-desktop-linux.yml",
  "jarvis-desktop-mac.yml",
  "jarvis-setup-windows.yml",
  "headless-node-release.yml",
] as const;

const readWorkflow = (name: string) =>
  NodeFS.readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), "utf8");

const stableTagTrigger = /\n  push:\n    tags:\n(?:      - .*\n)+/;
const releaseMutation = /softprops\/action-gh-release|gh release (?:create|upload|edit|delete)/;

describe("Jarvis release workflow contracts", () => {
  it("has one manual coordinator that promotes after all builds", () => {
    const coordinatorPath = new URL("../.github/workflows/jarvis-release.yml", import.meta.url);
    assert.isTrue(NodeFS.existsSync(coordinatorPath), "coordinator workflow is missing");

    const coordinator = NodeFS.readFileSync(coordinatorPath, "utf8");
    assert.include(coordinator, "workflow_dispatch:");
    assert.isFalse(/^\s{2}push:/m.test(coordinator), "coordinator must be manual-only");

    assert.include(coordinator, "uses: ./.github/workflows/jarvis-desktop-linux.yml");
    assert.include(coordinator, "uses: ./.github/workflows/jarvis-setup-windows.yml");
    assert.include(coordinator, "uses: ./.github/workflows/headless-node-release.yml");

    const preflightStart = coordinator.indexOf("\n  preflight:");
    const firstBuildStart = coordinator.indexOf("\n  build_linux:");
    const preflight = coordinator.slice(preflightStart, firstBuildStart);
    assert.include(
      preflight,
      'node scripts/jarvis-release-transaction.ts preflight "$RELEASE_VERSION" "$GITHUB_SHA"',
    );
    assert.include(preflight, "Fail closed without complete Apple release credentials");
    assert.include(preflight, "MACOS_PROVISIONING_PROFILE");
    assert.include(preflight, "CLERK_PUBLISHABLE_KEY or CLERK_PASSKEY_RP_DOMAINS");
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
    assert.include(coordinator, "scripts/jarvis-release-transaction.ts release-assets");
    assert.include(coordinator, "Jarvis-Setup.exe");
    assert.include(coordinator, "VERSION: ${{ needs.preflight.outputs.version }}");
    assert.include(coordinator, "RELEASE_TAG: v${{ needs.preflight.outputs.version }}");
    const macCall = coordinator.slice(
      coordinator.indexOf("  build_mac:"),
      coordinator.indexOf("  build_headless:"),
    );
    assert.include(macCall, "public_release: true");
    assert.include(coordinator, "Existing tag $RELEASE_TAG resolves");
    assert.include(
      coordinator,
      'if tag_ref="$(gh api "repos/$GITHUB_REPOSITORY/git/ref/tags/$RELEASE_TAG" 2>/dev/null)"; then',
    );
    assert.notInclude(coordinator, 'git/ref/tags/$RELEASE_TAG" 2>/dev/null || true');
    assert.notInclude(coordinator, "gh release upload");
    assert.notInclude(coordinator, "gh release create");
    assert.notInclude(coordinator, "releases/$RELEASE_ID");
    assert.equal((coordinator.match(/contents:\s*write/g) ?? []).length, 1);
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

  it("gates public Windows releases on complete Trusted Signing and verifies installed signatures", () => {
    const coordinator = readWorkflow("jarvis-release.yml");
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
      coordinator.indexOf("  build_mac:"),
    );
    assert.include(windowsCall, "public_release: true");

    const workflow = readWorkflow("jarvis-setup-windows.yml");
    const gate = workflow.slice(
      workflow.indexOf("      - name: Validate Azure Trusted Signing release gate"),
      workflow.indexOf("      - name: Setup Vite+"),
    );
    assert.include(workflow, "public_release:");
    assert.include(gate, "Azure Trusted Signing is only partially configured");
    assert.include(gate, "Public Jarvis releases require all Azure Trusted Signing secrets");
    assert.include(gate, "JARVIS_WINDOWS_SIGNING_ENABLED");
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
    assert.include(workflow, "$env:JARVIS_EXPECTED_PUBLISHER");
    assert.include(workflow, "installed Full Jarvis.exe");
    assert.include(workflow, "installed Controller Jarvis.exe");
    assert.include(workflow, "Status -ne 'Valid'");
  });

  it("uses a fork-available Mac runner and makes verification fail closed", () => {
    const workflow = readWorkflow("jarvis-desktop-mac.yml");
    assert.include(workflow, "public_release:");
    assert.include(workflow, "default: false");
    assert.include(workflow, "Apple signing configuration is incomplete");
    assert.include(
      workflow,
      "Signed macOS builds require CLERK_PUBLISHABLE_KEY or CLERK_PASSKEY_RP_DOMAINS.",
    );
    assert.include(
      workflow,
      "No Apple credentials supplied; continuing with unsigned manual verification.",
    );
    assert.include(
      workflow,
      "Public Jarvis macOS release is closed: Apple signing/notarization credentials are missing.",
    );
    assert.include(workflow, "runs-on: macos-15");
    assert.notInclude(workflow, "runs-on: blacksmith-");
    assert.include(workflow, "rust_target: aarch64-apple-darwin");
    assert.include(workflow, "rust_target: x86_64-apple-darwin");
    assert.include(workflow, "uses: dtolnay/rust-toolchain@stable");
    assert.include(workflow, "targets: ${{ matrix.rust_target }}");
    assert.include(workflow, "codesign --verify --deep --strict");
    assert.include(workflow, "spctl --assess --type execute");
    assert.include(workflow, "xcrun stapler validate");
    assert.include(workflow, 'xcrun stapler validate "$artifact"');
    assert.include(workflow, 'if [[ "$JARVIS_MAC_SIGNED" == "true" ]]');
    assert.include(workflow, "args+=(--signed)");
    assert.include(workflow, "scripts/mac-desktop-startup-smoke.mjs");
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
});
