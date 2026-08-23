// @effect-diagnostics nodeBuiltinImport:off

import * as NodeFS from "node:fs";
import { assert, describe, it } from "@effect/vitest";

const componentWorkflows = [
  "jarvis-desktop-linux.yml",
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
    assert.include(preflight, "published_count");
    assert.notInclude(preflight, "draft_count");
    assert.notInclude(preflight, ".draft == true");
    assert.notInclude(preflight, "reusable draft release");

    const promoteIndex = coordinator.indexOf("\n  promote:");
    assert.isAtLeast(promoteIndex, 0, "coordinator needs one promote job");
    const promote = coordinator.slice(promoteIndex);
    assert.include(promote, "needs:");
    assert.include(promote, "needs: [preflight, build_linux, build_windows, build_headless]");
    assert.include(promote, "build_linux");
    assert.include(promote, "build_windows");
    assert.include(promote, "build_headless");
    assert.include(coordinator, "scripts/verify-jarvis-release.mjs release-assets");
    assert.include(coordinator, "--write-sha256sums");
    assert.include(coordinator, "Jarvis-Setup.exe");
    assert.include(coordinator, "SHA256SUMS");
    assert.include(coordinator, "VERSION: ${{ needs.preflight.outputs.version }}");
    assert.include(coordinator, "RELEASE_TAG: v${{ needs.preflight.outputs.version }}");
    assert.include(coordinator, "Existing tag $RELEASE_TAG resolves");
    assert.include(
      coordinator,
      'if tag_ref="$(gh api "repos/$GITHUB_REPOSITORY/git/ref/tags/$RELEASE_TAG" 2>/dev/null)"; then',
    );
    assert.notInclude(coordinator, 'git/ref/tags/$RELEASE_TAG" 2>/dev/null || true');
    assert.include(coordinator, ".target_commitish");
    assert.include(coordinator, "releases?per_page=100");
    assert.include(coordinator, "RELEASE_ID");
    assert.include(coordinator, "releases/$RELEASE_ID");
    assert.include(coordinator, "releases/assets/$asset_id");
    assert.notInclude(coordinator, "releases/$RELEASE_ID/assets/$asset_id");
    assert.notInclude(coordinator, "releases/tags/$RELEASE_TAG");
    assert.include(coordinator, "remote_size");
    assert.include(coordinator, "remote_digest");
    assert.include(coordinator, "stat --printf='%s'");
    assert.include(coordinator, 'sha256sum "$local_file"');
    assert.include(coordinator, "Remote asset digest is missing");

    const draftIndex = coordinator.search(/--draft(?:=true)?|draft:\s*true/);
    const publishIndex = coordinator.search(
      /--draft=false|draft:\s*false|draft=false|--latest|make_latest:/,
    );
    assert.isAtLeast(draftIndex, 0, "coordinator must create or reuse a draft release");
    assert.isAbove(publishIndex, draftIndex, "publish/latest must happen after draft creation");
    assert.equal((coordinator.match(/gh release upload/g) ?? []).length, 1);
    assert.equal((coordinator.match(/gh release create/g) ?? []).length, 1);
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
});
