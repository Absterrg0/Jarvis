// @effect-diagnostics nodeBuiltinImport:off - this static policy test deliberately reads repository workflow files with Node APIs.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

const workflowDirectory = NodePath.resolve(process.cwd(), ".github/workflows");
const readWorkflow = (name: string) =>
  NodeFS.readFileSync(NodePath.join(workflowDirectory, name), "utf8");

describe("fork workflow policy", () => {
  it("does not depend on private Blacksmith runners", () => {
    for (const name of NodeFS.readdirSync(workflowDirectory)) {
      if (name.endsWith(".yml") || name.endsWith(".yaml")) {
        expect(readWorkflow(name), name).not.toContain("blacksmith-");
      }
    }
  });

  it("keeps core CI on main pushes", () => {
    const workflow = readWorkflow("ci.yml");
    expect(workflow).toMatch(/push:\s*\n\s+branches:\s*\n\s+- main/u);
    expect(workflow).not.toContain("run: vp check");
    expect(workflow).toContain("Lint Jarvis-owned paths");
    expect(workflow).toContain("Typecheck Jarvis runtime packages");
  });

  it.each(["deploy-relay.yml", "release.yml", "mobile-eas-production.yml"])(
    "keeps %s manual-only on the fork",
    (name) => {
      const workflow = readWorkflow(name);
      expect(workflow).toContain("workflow_dispatch:");
      expect(workflow).not.toMatch(/^\s+(push|schedule):/mu);
    },
  );

  it("does not auto-deploy the relay", () => {
    expect(readWorkflow("deploy-relay.yml")).not.toMatch(/^\s+push:/mu);
  });
});
