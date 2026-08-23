import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { jarvisRequestAcceptanceKey } from "./requestIdentity.ts";

describe("jarvisRequestAcceptanceKey", () => {
  it("does not scope an accepted request to an authenticated session", () => {
    const input = {
      executionNodeId: EnvironmentId.make("environment-desktop"),
      requestMetadata: {
        requestId: "request-1",
        origin: {
          originNodeId: EnvironmentId.make("environment-laptop"),
          originInteractionId: "interaction-1",
        },
      },
    };

    expect(jarvisRequestAcceptanceKey(input)).toBe(jarvisRequestAcceptanceKey({ ...input }));
  });

  it("keeps equal request IDs from different origins and nodes independent", () => {
    const requestMetadata = { requestId: "same-request" };
    const first = jarvisRequestAcceptanceKey({
      executionNodeId: EnvironmentId.make("environment-desktop"),
      requestMetadata: {
        ...requestMetadata,
        origin: {
          originNodeId: EnvironmentId.make("environment-laptop"),
          originInteractionId: "interaction-laptop",
        },
      },
    });
    const second = jarvisRequestAcceptanceKey({
      executionNodeId: EnvironmentId.make("environment-desktop"),
      requestMetadata: {
        ...requestMetadata,
        origin: {
          originNodeId: EnvironmentId.make("environment-tablet"),
          originInteractionId: "interaction-tablet",
        },
      },
    });
    const third = jarvisRequestAcceptanceKey({
      executionNodeId: EnvironmentId.make("environment-laptop"),
      requestMetadata: {
        ...requestMetadata,
        origin: {
          originNodeId: EnvironmentId.make("environment-laptop"),
          originInteractionId: "interaction-laptop",
        },
      },
    });

    expect(new Set([first, second, third]).size).toBe(3);
  });

  it("escapes user-controlled identity components", () => {
    const key = jarvisRequestAcceptanceKey({
      executionNodeId: EnvironmentId.make("node/a"),
      requestMetadata: {
        requestId: "request:1",
        origin: { originInteractionId: "interaction/1" },
      },
    });

    expect(key).toContain("node%2Fa");
    expect(key).toContain("request%3A1");
    expect(key).not.toContain("node/a");
  });
});
