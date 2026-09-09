import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import type { JarvisMeshCatalog } from "./mesh.ts";

import { tryBoundedLocalGrammarForEvidence } from "@t3tools/jarvis-core/localGrammar";
import { resolveJarvisProposalExecuteRoute } from "./routeGrounding.ts";

const LAPTOP = EnvironmentId.make("node-laptop");
const DESKTOP = EnvironmentId.make("node-desktop");

const catalog: JarvisMeshCatalog = {
  nodes: [
    { nodeId: LAPTOP, label: "Laptop", reachability: "online" },
    { nodeId: DESKTOP, label: "Desktop", reachability: "online" },
  ],
  projects: [
    {
      projectId: ProjectId.make("rivvl-laptop"),
      title: "Rivvl",
      workspaceRoot: "/work/rivvl",
      repositoryNames: ["rivvl"],
      aliases: [],
      aliasDetails: [],
      nodeId: LAPTOP,
      ref: { nodeId: LAPTOP, projectId: ProjectId.make("rivvl-laptop") },
      nodeLabel: "Laptop",
    },
    {
      projectId: ProjectId.make("jarvis-desktop"),
      title: "Jarvis",
      workspaceRoot: "/work/jarvis",
      repositoryNames: ["jarvis"],
      aliases: [],
      aliasDetails: [],
      nodeId: DESKTOP,
      ref: { nodeId: DESKTOP, projectId: ProjectId.make("jarvis-desktop") },
      nodeLabel: "Desktop",
    },
  ],
  providers: [],
};

const ambientDesktop = {
  projectRef: { nodeId: DESKTOP, projectId: ProjectId.make("jarvis-desktop") },
};

describe("grammar proposals ground without partial dispatch", () => {
  it("routes single-token auth in Rivvl to its owning node", () => {
    // Changed contract: parser automatic path takes one token only.
    const source = "Fix auth in Rivvl.";
    const grammar = tryBoundedLocalGrammarForEvidence({
      source,
      projects: [
        { title: "Jarvis", names: ["Jarvis"] },
        { title: "Rivvl", names: ["Rivvl"] },
      ],
      tasks: [],
    });
    expect(grammar.status).toBe("proposal");
    if (grammar.status !== "proposal") return;
    expect(
      source.slice(grammar.proposal.refs[0]!.span.start, grammar.proposal.refs[0]!.span.end),
    ).toBe(grammar.proposal.refs[0]!.span.text);
    const route = resolveJarvisProposalExecuteRoute(
      catalog,
      source,
      grammar.proposal,
      ambientDesktop,
    );
    expect(route).toEqual({
      status: "routed",
      project: expect.objectContaining({
        ref: { nodeId: LAPTOP, projectId: ProjectId.make("rivvl-laptop") },
      }),
    });
  });

  it("leaves out-of-grammar compounds to the provider with no route", () => {
    const source = "Fix auth then add release notes.";
    const grammar = tryBoundedLocalGrammarForEvidence({
      source,
      projects: [
        { title: "Jarvis", names: ["Jarvis"] },
        { title: "Rivvl", names: ["Rivvl"] },
      ],
      tasks: [],
    });
    // Closed grammar declines; one-action containment lives in explicit
    // proposal cardinality on the execution node, not in a language veto.
    expect(grammar.status).toBe("decline");
    const route = resolveJarvisProposalExecuteRoute(
      catalog,
      source,
      { action: "unsupported", refs: [], model: null, effort: null, answer: null },
      ambientDesktop,
    );
    expect(route).toEqual({ status: "ambient" });
  });
});
