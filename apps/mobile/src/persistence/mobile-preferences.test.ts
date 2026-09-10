import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("./mobile-database", () => ({}));
vi.mock("./mobile-secure-storage", () => ({}));

import { sanitizePreferences } from "./mobile-preferences";

describe("sanitizePreferences", () => {
  it("trims whitespace from validated identity fields before branding", () => {
    const preferences = sanitizePreferences({
      preferredVoiceNodeId: EnvironmentId.make("voice-node"),
      preferredJarvisProjectRef: {
        nodeId: EnvironmentId.make("node-A"),
        projectId: ProjectId.make("project-a"),
      },
    });

    expect(preferences.preferredVoiceNodeId).toBe("voice-node");
    expect(preferences.preferredJarvisProjectRef).toMatchObject({
      nodeId: "node-A",
      projectId: "project-a",
    });
  });

  it("keeps padded persisted identities usable after a reload", () => {
    // Stored JSON may carry padding; validation accepts it, so the branded
    // value must carry the trimmed form or downstream identity compares fail.
    const preferences = sanitizePreferences(
      JSON.parse(
        JSON.stringify({
          preferredVoiceNodeId: "  voice-node  ",
          preferredJarvisProjectRef: { nodeId: "  node-A ", projectId: " project-a\t" },
        }),
      ) as never,
    );

    expect(preferences.preferredVoiceNodeId).toBe("voice-node");
    expect(preferences.preferredJarvisProjectRef).toMatchObject({
      nodeId: "node-A",
      projectId: "project-a",
    });
  });
});
