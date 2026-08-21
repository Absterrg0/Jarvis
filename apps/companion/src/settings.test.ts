import { assert, describe, it } from "@effect/vitest";

import {
  pairCompanionNode,
  parseCompanionSettings,
  removeCompanionNode,
  refreshCompanionNode,
  renameCompanionNode,
  selectCompanionNode,
  upsertCompanionNode,
  withoutCompanionDefault,
  withCompanionDefault,
  withCompanionOriginInteractionId,
  withoutCompanionPendingSubmission,
  withCompanionPendingSubmission,
  withCompanionHost,
} from "./settings.ts";

const HOST = "https://jarvis-host.tailnet.ts.net/";
const LEGACY_NODE = {
  nodeId: `legacy-host:${HOST}`,
  displayName: "Jarvis Host",
  host: HOST,
};

describe("companion settings", () => {
  it("keeps existing host-only settings readable", () => {
    assert.deepEqual(parseCompanionSettings({ host: HOST }), {
      host: HOST,
      nodes: [LEGACY_NODE],
      selectedNodeId: LEGACY_NODE.nodeId,
    });
  });

  it("preserves the installation origin and pending retry identity", () => {
    const parsed = parseCompanionSettings({
      host: HOST,
      originInteractionId: "origin-installation-1",
      pendingProjectTask: {
        originInteractionId: "origin-installation-1",
        requestId: "request-1",
        transcript: "Run the tests",
        projects: [{ id: "project-1", title: "Jarvis", workspaceRoot: "/work/Jarvis" }],
      },
    });

    assert.equal(parsed.originInteractionId, "origin-installation-1");
    assert.equal(parsed.pendingProjectTask?.originInteractionId, "origin-installation-1");
    assert.equal(
      withCompanionOriginInteractionId(parsed, "origin-installation-2").originInteractionId,
      "origin-installation-2",
    );
    assert.equal(
      withCompanionOriginInteractionId(parsed, "").originInteractionId,
      "origin-installation-1",
    );
  });

  it("round-trips a pending submission for a recreated Companion", () => {
    const parsed = parseCompanionSettings({
      host: HOST,
      pendingSubmission: {
        requestId: "request-retry-1",
        originInteractionId: "origin-installation-1",
        nodeId: "node-desktop",
        projectId: "project-rivvl",
        utterance: "Fix the failing tests",
        contextThreadId: "thread-rivvl",
        continueContext: true,
        modelSelection: { instanceId: "codex", model: "sol" },
      },
    });
    assert.deepEqual(parsed.pendingSubmission, {
      requestId: "request-retry-1",
      originInteractionId: "origin-installation-1",
      nodeId: "node-desktop",
      projectId: "project-rivvl",
      utterance: "Fix the failing tests",
      contextThreadId: "thread-rivvl",
      continueContext: true,
      modelSelection: { instanceId: "codex", model: "sol" },
    });
    const cleared = withoutCompanionPendingSubmission(
      withCompanionPendingSubmission(parsed, parsed.pendingSubmission!),
    );
    assert.isUndefined(cleared.pendingSubmission);
  });

  it("pairs a node and upserts reconnects without duplicating its stable identity", () => {
    const paired = pairCompanionNode(
      { host: null },
      {
        nodeId: "node-desktop",
        displayName: "Desktop",
        host: "https://desktop.tailnet.ts.net/",
      },
    );
    const reconnected = upsertCompanionNode(paired, {
      nodeId: "node-desktop",
      displayName: "Office Desktop",
      host: "https://desktop-new.tailnet.ts.net/",
    });

    assert.deepEqual(reconnected, {
      host: "https://desktop-new.tailnet.ts.net/",
      nodes: [
        {
          nodeId: "node-desktop",
          displayName: "Office Desktop",
          host: "https://desktop-new.tailnet.ts.net/",
        },
      ],
      selectedNodeId: "node-desktop",
    });
  });

  it("upgrades the migrated host entry when pairing reveals the real node identity", () => {
    const migrated = parseCompanionSettings({ host: HOST });
    const paired = upsertCompanionNode(migrated, {
      nodeId: "node-real",
      displayName: "Desktop",
      host: HOST,
    });

    assert.deepEqual(paired.nodes, [
      {
        nodeId: "node-real",
        displayName: "Desktop",
        host: HOST,
      },
    ]);
  });

  it("refreshes a legacy node descriptor without changing the selected node", () => {
    const migrated = parseCompanionSettings({ host: HOST });
    const refreshed = refreshCompanionNode(migrated, {
      nodeId: "node-real",
      displayName: "Desktop",
      host: HOST,
    });
    assert.deepEqual(refreshed.nodes, [
      { nodeId: "node-real", displayName: "Desktop", host: HOST },
    ]);
    assert.equal(refreshed.selectedNodeId, "node-real");
  });

  it("keeps multiple nodes addressable by node identity and selects one explicitly", () => {
    const desktop = pairCompanionNode(
      { host: null },
      {
        nodeId: "node-desktop",
        displayName: "Desktop",
        host: "https://desktop.tailnet.ts.net/",
      },
    );
    const both = pairCompanionNode(desktop, {
      nodeId: "node-laptop",
      displayName: "Laptop",
      host: "https://laptop.tailnet.ts.net/",
    });

    assert.equal(both.selectedNodeId, "node-laptop");
    assert.equal(selectCompanionNode(both, "node-desktop").selectedNodeId, "node-desktop");
    assert.equal(selectCompanionNode(both, "missing-node"), both);
  });

  it("renames a node without changing its stable identity or connection", () => {
    const paired = pairCompanionNode(
      { host: null },
      {
        nodeId: "node-desktop",
        displayName: "Desktop",
        host: "https://desktop.tailnet.ts.net/",
      },
    );

    assert.deepEqual(renameCompanionNode(paired, "node-desktop", "Office"), {
      ...paired,
      nodes: [
        {
          nodeId: "node-desktop",
          displayName: "Office",
          host: "https://desktop.tailnet.ts.net/",
        },
      ],
    });
  });

  it("removes a node and falls back to another node when the selection disappears", () => {
    const first = pairCompanionNode(
      { host: null },
      {
        nodeId: "node-desktop",
        displayName: "Desktop",
        host: "https://desktop.tailnet.ts.net/",
      },
    );
    const both = pairCompanionNode(first, {
      nodeId: "node-laptop",
      displayName: "Laptop",
      host: "https://laptop.tailnet.ts.net/",
    });

    const one = removeCompanionNode(both, "node-laptop");
    assert.deepEqual(one.nodes, first.nodes);
    assert.equal(one.selectedNodeId, "node-desktop");
    assert.equal(one.host, "https://desktop.tailnet.ts.net/");

    const empty = removeCompanionNode(one, "node-desktop");
    assert.deepEqual(empty, { host: null, nodes: [], selectedNodeId: null });
  });

  it("loads the persisted node directory and selected host", () => {
    assert.deepEqual(
      parseCompanionSettings({
        nodes: [
          {
            nodeId: "node-desktop",
            displayName: "Desktop",
            host: "https://desktop.tailnet.ts.net/",
          },
          {
            nodeId: "node-laptop",
            displayName: "Laptop",
            host: "https://laptop.tailnet.ts.net/",
          },
        ],
        selectedNodeId: "node-laptop",
      }),
      {
        host: "https://laptop.tailnet.ts.net/",
        nodes: [
          {
            nodeId: "node-desktop",
            displayName: "Desktop",
            host: "https://desktop.tailnet.ts.net/",
          },
          {
            nodeId: "node-laptop",
            displayName: "Laptop",
            host: "https://laptop.tailnet.ts.net/",
          },
        ],
        selectedNodeId: "node-laptop",
      },
    );
  });

  it("retains an explicitly empty directory after the last node is removed", () => {
    assert.deepEqual(parseCompanionSettings({ nodes: [], selectedNodeId: null }), {
      host: null,
      nodes: [],
      selectedNodeId: null,
    });
  });

  it("persists an explicit project target independently of the visible T3 project", () => {
    assert.deepEqual(
      parseCompanionSettings({
        host: HOST,
        projectTarget: {
          id: "project-jarvis",
          title: "Jarvis",
          workspaceRoot: "/work/Jarvis",
        },
      }),
      {
        host: HOST,
        nodes: [LEGACY_NODE],
        selectedNodeId: LEGACY_NODE.nodeId,
        projectTarget: {
          id: "project-jarvis",
          title: "Jarvis",
          workspaceRoot: "/work/Jarvis",
        },
      },
    );
  });

  it("retains defaults only when the companion stays paired to that host", () => {
    const configured = withCompanionDefault(
      { host: "https://jarvis-host.tailnet.ts.net/" },
      { instanceId: "codex", model: "gpt-5.6-sol" },
    );
    assert.deepEqual(withCompanionHost(configured, "https://another-host.tailnet.ts.net/"), {
      host: "https://another-host.tailnet.ts.net/",
    });
    assert.deepEqual(
      withCompanionHost(configured, "https://jarvis-host.tailnet.ts.net/"),
      configured,
    );
  });

  it("does not persist malformed selection values from the renderer", () => {
    assert.deepEqual(
      parseCompanionSettings({
        host: HOST,
        defaultModelSelection: { instanceId: "codex", model: "gpt-5.6-sol", options: [{}] },
      }),
      { host: HOST, nodes: [LEGACY_NODE], selectedNodeId: LEGACY_NODE.nodeId },
    );
  });

  it("can clear a stale default without dropping the host pairing", () => {
    assert.deepEqual(
      withoutCompanionDefault({
        host: "https://jarvis-host.tailnet.ts.net/",
        defaultModelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
      }),
      { host: "https://jarvis-host.tailnet.ts.net/" },
    );
  });

  it("defaults to a fresh thread while preserving an explicit continue preference", () => {
    assert.deepEqual(
      parseCompanionSettings({
        host: HOST,
        conversationMode: "continue-last-thread",
      }),
      {
        host: HOST,
        nodes: [LEGACY_NODE],
        selectedNodeId: LEGACY_NODE.nodeId,
        conversationMode: "continue-last-thread",
      },
    );
    assert.deepEqual(
      parseCompanionSettings({
        host: HOST,
        conversationMode: "anything-else",
      }),
      { host: HOST, nodes: [LEGACY_NODE], selectedNodeId: LEGACY_NODE.nodeId },
    );
  });

  it("restores the exact last task reference for safe controls after restart", () => {
    assert.deepEqual(
      parseCompanionSettings({
        host: HOST,
        attentionTarget: {
          projectId: "project-1",
          threadId: "thread-1",
          reportKind: "approval-needed",
        },
      }).attentionTarget,
      { projectId: "project-1", threadId: "thread-1", reportKind: "approval-needed" },
    );
  });

  it("persists node ownership for defaults, attention, and pending clarification", () => {
    const parsed = parseCompanionSettings({
      host: HOST,
      defaultModelSelection: { instanceId: "codex", model: "sol" },
      defaultModelNodeId: "node-desktop",
      attentionTarget: {
        nodeId: "node-desktop",
        projectId: "project-1",
        threadId: "thread-1",
      },
      pendingProjectTask: {
        nodeId: "node-desktop",
        requestId: "request-1",
        transcript: "Run the tests",
        projects: [
          {
            id: "project-1",
            title: "Jarvis",
            workspaceRoot: "/work/Jarvis",
            nodeId: "node-desktop",
            nodeLabel: "Desktop",
          },
        ],
      },
    });
    assert.equal(parsed.defaultModelNodeId, "node-desktop");
    assert.equal(parsed.attentionTarget?.nodeId, "node-desktop");
    assert.equal(parsed.pendingProjectTask?.requestId, "request-1");
    assert.equal(parsed.pendingProjectTask?.projects[0]?.nodeId, "node-desktop");
  });

  it("restores a pending project confirmation only for the same Host", () => {
    const pending = parseCompanionSettings({
      host: HOST,
      pendingProjectTask: {
        transcript: "Check the PR in ripple",
        heardAlias: "ripple",
        projects: [{ id: "project-rivvl", title: "Rivvl", workspaceRoot: "/work/rivvl" }],
      },
    });
    assert.equal(pending.pendingProjectTask?.transcript, "Check the PR in ripple");
    assert.equal(pending.pendingProjectTask?.heardAlias, "ripple");
    assert.deepEqual(withCompanionHost(pending, "https://jarvis-host.tailnet.ts.net/"), pending);
    assert.deepEqual(withCompanionHost(pending, "https://other.tailnet.ts.net/"), {
      host: "https://other.tailnet.ts.net/",
    });
  });
});
