import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";
import type { CirceMeshCatalog } from "@circe/client-runtime/circe/mesh";

import { describeCirceRouteNodeIssues } from "./mobileNodeReadiness";

const DESKTOP = EnvironmentId.make("node-desktop");
const LAPTOP = EnvironmentId.make("node-laptop");
const VPS = EnvironmentId.make("node-vps");
const STUDIO = EnvironmentId.make("node-studio");

function catalogWith(nodes: CirceMeshCatalog["nodes"]): CirceMeshCatalog {
  return { nodes, projects: [], providers: [] };
}

describe("Circe route node status", () => {
  it("returns no issues when the catalog is not loaded yet", () => {
    expect(describeCirceRouteNodeIssues(null)).toEqual([]);
  });

  it("keeps healthy and loaded-empty nodes usable with no rows", () => {
    expect(
      describeCirceRouteNodeIssues(
        catalogWith([{ nodeId: DESKTOP, label: "Desktop", reachability: "online" }]),
      ),
    ).toEqual([]);
  });

  it("keeps the node's actual service message with retry recovery", () => {
    expect(
      describeCirceRouteNodeIssues(
        catalogWith([
          { nodeId: DESKTOP, label: "Desktop", reachability: "online" },
          {
            nodeId: LAPTOP,
            label: "Laptop",
            reachability: "online",
            catalogError: "catalog service failed",
            catalogErrorKind: "service",
          },
        ]),
      ),
    ).toEqual([
      {
        nodeId: LAPTOP,
        label: "Laptop",
        loading: false,
        message: "catalog service failed",
        recovery: "retry",
      },
    ]);
  });

  it("maps auth failures to reconnect recovery independent of the command message", () => {
    expect(
      describeCirceRouteNodeIssues(
        catalogWith([
          {
            nodeId: LAPTOP,
            label: "Laptop",
            reachability: "online",
            catalogError: "Node authentication failed; reconnect with a valid pairing link.",
            catalogErrorKind: "authentication",
          },
        ]),
      ),
    ).toEqual([
      {
        nodeId: LAPTOP,
        label: "Laptop",
        loading: false,
        message: "Node authentication failed; reconnect with a valid pairing link.",
        recovery: "reauthenticate",
      },
    ]);
  });

  it("projects mixed offline, loading, update, and healthy nodes", () => {
    expect(
      describeCirceRouteNodeIssues(
        catalogWith([
          { nodeId: DESKTOP, label: "Desktop", reachability: "online" },
          { nodeId: VPS, label: "VPS", reachability: "offline" },
          {
            nodeId: STUDIO,
            label: "Studio",
            reachability: "online",
            catalogPending: true,
          },
          {
            nodeId: LAPTOP,
            label: "Laptop",
            reachability: "online",
            catalogError:
              "Node returned an incompatible Circe catalog; update both devices and retry.",
            catalogErrorKind: "incompatible",
          },
        ]),
      ),
    ).toEqual([
      {
        nodeId: VPS,
        label: "VPS",
        loading: false,
        message: "VPS is offline; reconnect it and retry catalog refresh.",
        recovery: "reconnect",
      },
      {
        nodeId: STUDIO,
        label: "Studio",
        loading: true,
        message: null,
        recovery: null,
      },
      {
        nodeId: LAPTOP,
        label: "Laptop",
        loading: false,
        message: "Node returned an incompatible Circe catalog; update both devices and retry.",
        recovery: "update",
      },
    ]);
  });
});
