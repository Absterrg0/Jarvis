import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId, ThreadId, type CirceSemanticProposal } from "@t3tools/contracts";
import type { CirceMeshCatalog } from "./mesh.ts";

import {
  resolveCirceProposalExecuteRoute,
  resolveCirceRouteCoverageConfirm,
} from "./routeGrounding.ts";

const LAPTOP = EnvironmentId.make("node-laptop");
const DESKTOP = EnvironmentId.make("node-desktop");
const VPS = EnvironmentId.make("node-vps");

const catalog: CirceMeshCatalog = {
  nodes: [
    { nodeId: LAPTOP, label: "Laptop", reachability: "online" },
    { nodeId: DESKTOP, label: "Desktop", reachability: "online" },
    { nodeId: VPS, label: "VPS", reachability: "offline" },
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
      projectId: ProjectId.make("circe-desktop"),
      title: "Circe",
      workspaceRoot: "/work/circe",
      repositoryNames: ["circe"],
      aliases: [],
      aliasDetails: [],
      nodeId: DESKTOP,
      ref: { nodeId: DESKTOP, projectId: ProjectId.make("circe-desktop") },
      nodeLabel: "Desktop",
    },
    {
      projectId: ProjectId.make("zivil-vps"),
      title: "Zivil",
      workspaceRoot: "/work/zivil",
      repositoryNames: ["zivil"],
      aliases: [],
      aliasDetails: [],
      nodeId: VPS,
      ref: { nodeId: VPS, projectId: ProjectId.make("zivil-vps") },
      nodeLabel: "VPS",
    },
  ],
  providers: [],
};

const ambientDesktop = {
  projectRef: { nodeId: DESKTOP, projectId: ProjectId.make("circe-desktop") },
};

function proposal(
  action: CirceSemanticProposal["action"],
  refs: CirceSemanticProposal["refs"],
): CirceSemanticProposal {
  return { action, refs, model: null, effort: null, answer: null };
}

function destinationRef(source: string, wrapper: string, value: string) {
  const start = source.indexOf(wrapper);
  return {
    span: { start, end: start + wrapper.length, text: wrapper },
    role: "destination" as const,
    value,
  };
}

describe("proposal-first execute route grounding", () => {
  it("routes an explicit destination to its owning node", () => {
    const source = "Check PRs in Rivvl";
    expect(
      resolveCirceProposalExecuteRoute(
        catalog,
        source,
        proposal("start", [destinationRef(source, "in Rivvl", "Rivvl")]),
        ambientDesktop,
      ),
    ).toEqual({
      status: "routed",
      project: expect.objectContaining({
        ref: { nodeId: LAPTOP, projectId: ProjectId.make("rivvl-laptop") },
      }),
    });
  });

  it("leaves an instruction without a destination on the ambient target", () => {
    expect(
      resolveCirceProposalExecuteRoute(
        catalog,
        "Fix the login bug",
        proposal("start", []),
        ambientDesktop,
      ),
    ).toEqual({ status: "ambient" });
  });

  it("never routes subject-only mentions", () => {
    const source = "In Rivvl compare with Circe";
    const inRivvl = source.indexOf("In Rivvl");
    const withCirce = source.indexOf("Circe");
    expect(
      resolveCirceProposalExecuteRoute(
        catalog,
        source,
        proposal("start", [
          {
            span: { start: inRivvl, end: inRivvl + "In Rivvl".length, text: "In Rivvl" },
            role: "destination",
            value: "Rivvl",
          },
          {
            span: { start: withCirce, end: withCirce + "Circe".length, text: "Circe" },
            role: "subject",
            value: "Circe",
          },
        ]),
        ambientDesktop,
      ),
    ).toEqual({
      status: "routed",
      project: expect.objectContaining({
        ref: { nodeId: LAPTOP, projectId: ProjectId.make("rivvl-laptop") },
      }),
    });
    // Subject alone never chooses a node.
    const subjectOnly = "PRs mentioning Rivvl";
    const mention = subjectOnly.indexOf("Rivvl");
    expect(
      resolveCirceProposalExecuteRoute(
        catalog,
        subjectOnly,
        proposal("start", [
          {
            span: { start: mention, end: mention + "Rivvl".length, text: "Rivvl" },
            role: "subject",
            value: "Rivvl",
          },
        ]),
        ambientDesktop,
      ),
    ).toEqual({ status: "ambient" });
  });

  it("chooses no node for a deliberately negated destination", () => {
    const source = "Check auth but not in Fable";
    const start = source.indexOf("in Fable");
    expect(
      resolveCirceProposalExecuteRoute(
        catalog,
        source,
        proposal("start", [
          {
            span: { start, end: start + "in Fable".length, text: "in Fable" },
            role: "excluded",
            value: "Fable",
          },
        ]),
        ambientDesktop,
      ),
    ).toEqual({ status: "ambient" });
  });

  it("stays ambient on malformed refs instead of routing on distrust", () => {
    const source = "Check PRs in Rivvl";
    // Span text does not reproduce the source slice.
    expect(
      resolveCirceProposalExecuteRoute(
        catalog,
        source,
        proposal("start", [
          {
            span: { start: 10, end: 18, text: "IN RIVVL" },
            role: "destination",
            value: "Rivvl",
          },
        ]),
        ambientDesktop,
      ),
    ).toEqual({ status: "ambient" });
    // Cardinality: two destinations is a compound, never a route.
    expect(
      resolveCirceProposalExecuteRoute(
        catalog,
        source,
        proposal("start", [
          destinationRef(source, "in Rivvl", "Rivvl"),
          destinationRef(source, "in Rivvl", "Rivvl"),
        ]),
        ambientDesktop,
      ),
    ).toEqual({ status: "ambient" });
    // Unheard: wrapper does not contain the claimed name.
    const other = "Fix auth in Rivvl";
    expect(
      resolveCirceProposalExecuteRoute(
        catalog,
        other,
        proposal("start", [
          {
            span: {
              start: other.indexOf("in Rivvl"),
              end: other.indexOf("in Rivvl") + "in Rivvl".length,
              text: "in Rivvl",
            },
            role: "destination",
            value: "Circe",
          },
        ]),
        ambientDesktop,
      ),
    ).toEqual({ status: "ambient" });
  });

  it("asks instead of guessing when the name lives on two nodes", () => {
    const both: CirceMeshCatalog = {
      ...catalog,
      projects: [
        ...catalog.projects,
        {
          projectId: ProjectId.make("rivvl-desktop"),
          title: "Rivvl",
          workspaceRoot: "/work/rivvl",
          repositoryNames: ["rivvl"],
          aliases: [],
          aliasDetails: [],
          nodeId: DESKTOP,
          ref: { nodeId: DESKTOP, projectId: ProjectId.make("rivvl-desktop") },
          nodeLabel: "Desktop",
        },
      ],
    };
    const source = "Check PRs in Rivvl";
    const route = resolveCirceProposalExecuteRoute(
      both,
      source,
      proposal("start", [destinationRef(source, "in Rivvl", "Rivvl")]),
      ambientDesktop,
    );
    expect(route.status).toBe("needs-choice");
    expect(
      route.status === "needs-choice" ? route.candidates.map(({ label }) => label).toSorted() : [],
    ).toEqual(["Rivvl — Desktop", "Rivvl — Laptop"]);
  });

  it("stays ambient for an unknown alias so the execution node clarifies", () => {
    const source = "Check PRs in Ripple";
    expect(
      resolveCirceProposalExecuteRoute(
        catalog,
        source,
        proposal("start", [destinationRef(source, "in Ripple", "Ripple")]),
        ambientDesktop,
      ),
    ).toEqual({ status: "ambient" });
  });

  it("reports the exact disconnected node instead of falling back", () => {
    const source = "Check PRs in Zivil";
    expect(
      resolveCirceProposalExecuteRoute(
        catalog,
        source,
        proposal("start", [destinationRef(source, "in Zivil", "Zivil")]),
        ambientDesktop,
      ),
    ).toEqual({
      status: "unavailable",
      project: expect.objectContaining({
        ref: { nodeId: VPS, projectId: ProjectId.make("zivil-vps") },
      }),
      nodeLabel: "VPS",
    });
  });

  it("never swaps a qualified pinned followup to a mentioned project", () => {
    const source = "Check PRs in Rivvl";
    const pinned = {
      projectRef: { nodeId: DESKTOP, projectId: ProjectId.make("circe-desktop") },
      contextThreadId: ThreadId.make("thread-circe"),
    };
    expect(
      resolveCirceProposalExecuteRoute(
        catalog,
        source,
        proposal("start", [destinationRef(source, "in Rivvl", "Rivvl")]),
        pinned,
      ),
    ).toEqual({ status: "ambient" });
  });

  it("keeps a cross-node pinned task on its owner instead of rerouting", () => {
    const source = "Check PRs in Rivvl";
    const pinned = {
      projectRef: { nodeId: DESKTOP, projectId: ProjectId.make("circe-desktop") },
      contextThreadId: ThreadId.make("thread-cross-node"),
    };
    // Even though the proposal names a healthy other-node project, the pinned
    // task owns the turn: pins stay on the owner node, no silent move.
    expect(
      resolveCirceProposalExecuteRoute(
        catalog,
        source,
        proposal("continue", [destinationRef(source, "in Rivvl", "Rivvl")]),
        pinned,
      ),
    ).toEqual({ status: "ambient" });
  });

  it("routes a correction ref like a destination", () => {
    const source = "I meant Rivvl fix auth";
    const start = source.indexOf("Rivvl");
    expect(
      resolveCirceProposalExecuteRoute(
        catalog,
        source,
        proposal("start", [
          {
            span: { start, end: start + "Rivvl".length, text: "Rivvl" },
            role: "correction",
            value: "Rivvl",
          },
        ]),
        ambientDesktop,
      ),
    ).toEqual({
      status: "routed",
      project: expect.objectContaining({
        ref: { nodeId: LAPTOP, projectId: ProjectId.make("rivvl-laptop") },
      }),
    });
  });
});

describe("route coverage confirmation under partial catalogs", () => {
  const LOCAL = EnvironmentId.make("node-local");
  const REMOTE = EnvironmentId.make("node-remote");
  const atlasId = ProjectId.make("atlas-local");
  const atlas = {
    projectId: atlasId,
    title: "Atlas",
    workspaceRoot: "/atlas",
    repositoryNames: ["atlas"],
    aliases: [],
    aliasDetails: [],
    nodeId: LOCAL,
    ref: { nodeId: LOCAL, projectId: atlasId },
    nodeLabel: "Local",
  };
  const partialCatalog: CirceMeshCatalog = {
    nodes: [
      { nodeId: LOCAL, label: "Local", reachability: "online" },
      {
        nodeId: REMOTE,
        label: "Remote",
        reachability: "online",
        catalogError: "unreachable",
        catalogErrorKind: "unreachable",
      },
    ],
    projects: [atlas],
    providers: [],
  };
  const fullCatalog: CirceMeshCatalog = {
    ...partialCatalog,
    nodes: [
      { nodeId: LOCAL, label: "Local", reachability: "online" },
      { nodeId: REMOTE, label: "Remote", reachability: "online" },
    ],
  };
  function subjectRef(source: string, mention: string) {
    const start = source.indexOf(mention);
    return {
      span: { start, end: start + mention.length, text: mention },
      role: "subject" as const,
      value: mention,
    };
  }
  function excludedRef(source: string, mention: string) {
    const start = source.indexOf(mention);
    return {
      span: { start, end: start + mention.length, text: mention },
      role: "excluded" as const,
      value: mention,
    };
  }

  it("confirms an ambient mention when a peer catalog is unread", () => {
    const source = "Check out Atlas";
    expect(
      resolveCirceRouteCoverageConfirm({
        catalog: partialCatalog,
        source,
        proposal: proposal("start", [subjectRef(source, "Atlas")]),
        resolved: atlas,
        routed: false,
        pinned: false,
      }),
    ).toEqual({ status: "confirm", project: atlas, nodeLabels: ["Remote"] });
  });

  it("proceeds when coverage is complete", () => {
    const source = "Check out Atlas";
    expect(
      resolveCirceRouteCoverageConfirm({
        catalog: fullCatalog,
        source,
        proposal: proposal("start", [subjectRef(source, "Atlas")]),
        resolved: atlas,
        routed: false,
        pinned: false,
      }),
    ).toEqual({ status: "proceed" });
  });

  it("proceeds for a name-independent turn on a partial catalog", () => {
    expect(
      resolveCirceRouteCoverageConfirm({
        catalog: partialCatalog,
        source: "Fix the login bug",
        proposal: proposal("start", []),
        resolved: atlas,
        routed: false,
        pinned: false,
      }),
    ).toEqual({ status: "proceed" });
  });

  it("confirms a routed destination under partial coverage", () => {
    const source = "Check out Atlas";
    expect(
      resolveCirceRouteCoverageConfirm({
        catalog: partialCatalog,
        source,
        proposal: proposal("start", [destinationRef(source, "Atlas", "Atlas")]),
        resolved: atlas,
        routed: true,
        pinned: false,
      }),
    ).toEqual({ status: "confirm", project: atlas, nodeLabels: ["Remote"] });
  });

  it("lets an excluded ambient name reach the execution veto instead", () => {
    const source = "Check auth but not in Atlas";
    expect(
      resolveCirceRouteCoverageConfirm({
        catalog: partialCatalog,
        source,
        proposal: proposal("start", [excludedRef(source, "Atlas")]),
        resolved: atlas,
        routed: false,
        pinned: false,
      }),
    ).toEqual({ status: "proceed" });
  });

  it("never interrupts a pinned followup for coverage", () => {
    const source = "Check out Atlas";
    expect(
      resolveCirceRouteCoverageConfirm({
        catalog: partialCatalog,
        source,
        proposal: proposal("start", [subjectRef(source, "Atlas")]),
        resolved: atlas,
        routed: false,
        pinned: true,
      }),
    ).toEqual({ status: "proceed" });
  });

  it("proceeds past a malformed multi-destination proposal to execution clarification", () => {
    const source = "Check Atlas and Rivvl";
    const atlasAt = source.indexOf("Atlas");
    const rivvlAt = source.indexOf("Rivvl");
    expect(
      resolveCirceRouteCoverageConfirm({
        catalog: partialCatalog,
        source,
        proposal: proposal("start", [
          {
            span: { start: atlasAt, end: atlasAt + "Atlas".length, text: "Atlas" },
            role: "destination",
            value: "Atlas",
          },
          {
            span: { start: rivvlAt, end: rivvlAt + "Rivvl".length, text: "Rivvl" },
            role: "destination",
            value: "Rivvl",
          },
        ]),
        resolved: atlas,
        routed: false,
        pinned: false,
      }),
    ).toEqual({ status: "proceed" });
  });
});

describe("route coverage confirmation with no resolved target", () => {
  const LOCAL = EnvironmentId.make("node-local2");
  const REMOTE = EnvironmentId.make("node-remote2");
  const atlasId = ProjectId.make("atlas-local2");
  const atlas = {
    projectId: atlasId,
    title: "Atlas",
    workspaceRoot: "/atlas",
    repositoryNames: ["atlas"],
    aliases: [],
    aliasDetails: [],
    nodeId: LOCAL,
    ref: { nodeId: LOCAL, projectId: atlasId },
    nodeLabel: "Local",
  };
  const rivvlId = ProjectId.make("rivvl-local2");
  const rivvl = {
    projectId: rivvlId,
    title: "Rivvl",
    workspaceRoot: "/rivvl",
    repositoryNames: ["rivvl"],
    aliases: [],
    aliasDetails: [],
    nodeId: LOCAL,
    ref: { nodeId: LOCAL, projectId: rivvlId },
    nodeLabel: "Local",
  };
  const partialCatalog: CirceMeshCatalog = {
    nodes: [
      { nodeId: LOCAL, label: "Local", reachability: "online" },
      {
        nodeId: REMOTE,
        label: "Remote",
        reachability: "online",
        catalogError: "unreachable",
        catalogErrorKind: "unreachable",
      },
    ],
    projects: [atlas, rivvl],
    providers: [],
  };
  function subjectRef(source: string, mention: string) {
    const start = source.indexOf(mention);
    return {
      span: { start, end: start + mention.length, text: mention },
      role: "subject" as const,
      value: mention,
    };
  }

  it("confirms a single mentioned visible project", () => {
    const source = "Check out Atlas";
    expect(
      resolveCirceRouteCoverageConfirm({
        catalog: partialCatalog,
        source,
        proposal: proposal("start", [subjectRef(source, "Atlas")]),
        resolved: undefined,
        routed: false,
        pinned: false,
      }),
    ).toEqual({ status: "confirm", project: atlas, nodeLabels: ["Remote"] });
  });

  it("falls through when several visible projects are mentioned", () => {
    const source = "Compare Atlas with Rivvl";
    const atlasAt = source.indexOf("Atlas");
    const rivvlAt = source.indexOf("Rivvl");
    expect(
      resolveCirceRouteCoverageConfirm({
        catalog: partialCatalog,
        source,
        proposal: proposal("start", [
          {
            span: { start: atlasAt, end: atlasAt + "Atlas".length, text: "Atlas" },
            role: "subject",
            value: "Atlas",
          },
          {
            span: { start: rivvlAt, end: rivvlAt + "Rivvl".length, text: "Rivvl" },
            role: "subject",
            value: "Rivvl",
          },
        ]),
        resolved: undefined,
        routed: false,
        pinned: false,
      }),
    ).toEqual({ status: "proceed" });
  });

  it("falls through when routing refs are present without a target", () => {
    const source = "Check out Atlas";
    const at = source.indexOf("Atlas");
    expect(
      resolveCirceRouteCoverageConfirm({
        catalog: partialCatalog,
        source,
        proposal: proposal("start", [
          {
            span: { start: at, end: at + "Atlas".length, text: "Atlas" },
            role: "destination",
            value: "Atlas",
          },
        ]),
        resolved: undefined,
        routed: false,
        pinned: false,
      }),
    ).toEqual({ status: "proceed" });
  });
});
