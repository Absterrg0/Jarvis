// @effect-diagnostics nodeBuiltinImport:off - this static policy test deliberately reads repository workflow files with Node APIs.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { describe, expect, it } from "vite-plus/test";

const repoRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const workflowDirectory = NodePath.join(repoRoot, ".github/workflows");
const readWorkflow = (name: string) =>
  NodeFS.readFileSync(NodePath.join(workflowDirectory, name), "utf8");

describe("fork workflow policy", () => {
  it("does not depend on private Blacksmith runners", () => {
    for (const name of NodeFS.readdirSync(workflowDirectory)) {
      if (name.endsWith(".yml") || name.endsWith(".yaml")) {
        const workflow = readWorkflow(name);
        if (name === "release.yml") {
          expect(workflow).toContain("github.repository == 'pingdotgg/t3code'");
          expect(workflow).toContain("workflow_dispatch:");
          expect(workflow).not.toMatch(/^\s+(push|schedule):/mu);
        } else {
          expect(workflow, name).not.toContain("blacksmith-");
        }
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

  it("keeps GitHub release mutation in the Jarvis transaction coordinator", () => {
    const mutator = /softprops\/action-gh-release|gh release (?:create|upload|edit|delete)/u;
    const coordinator = readWorkflow("jarvis-release.yml");
    expect(coordinator).toContain("scripts/jarvis-release-transaction.ts release-assets");
    for (const name of NodeFS.readdirSync(workflowDirectory)) {
      if (!(name.endsWith(".yml") || name.endsWith(".yaml"))) continue;
      if (name === "release.yml" || name === "jarvis-release.yml") continue;
      expect(readWorkflow(name), name).not.toMatch(mutator);
    }
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

  it("keeps thread transfer reporting manual-only while preserving its reporter", () => {
    const workflow = readWorkflow("thread-transfer-report.yml");
    const trigger = workflow.slice(0, workflow.indexOf("\n\npermissions:"));
    expect(trigger).toContain("workflow_dispatch:");
    expect(trigger).not.toContain("workflow_run:");
    expect(workflow).toContain("SOURCE_WORKFLOW_RUN_ID");
    expect(workflow).toContain("getWorkflowRun");
  });
});
