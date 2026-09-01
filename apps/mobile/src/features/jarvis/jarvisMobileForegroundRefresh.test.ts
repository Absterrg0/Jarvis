import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  hasEnvironmentConnected,
  isAppForegroundTransition,
  isSelectedTaskDeskNodeCatalogued,
} from "./jarvisMobileForegroundRefresh";

describe("mobile Jarvis foreground reconciliation", () => {
  it("only refreshes when the app returns from background or inactive", () => {
    expect(isAppForegroundTransition("background", "active")).toBe(true);
    expect(isAppForegroundTransition("inactive", "active")).toBe(true);
    expect(isAppForegroundTransition("active", "active")).toBe(false);
    expect(isAppForegroundTransition("active", "background")).toBe(false);
  });

  it("detects a node entering connected without treating an unchanged connection as new", () => {
    const desktop = EnvironmentId.make("desktop");
    const laptop = EnvironmentId.make("laptop");
    const previous = new Map([
      [desktop, "reconnecting" as const],
      [laptop, "connected" as const],
    ]);

    expect(
      hasEnvironmentConnected(previous, [
        { environmentId: desktop, connectionState: "connected" },
        { environmentId: laptop, connectionState: "connected" },
      ]),
    ).toBe(true);
    expect(
      hasEnvironmentConnected(previous, [{ environmentId: laptop, connectionState: "connected" }]),
    ).toBe(false);
  });

  it("keeps an explicit desk selection from falling back to another catalogued node", () => {
    const selected = EnvironmentId.make("desktop");
    const other = EnvironmentId.make("laptop");
    const catalog = {
      nodes: [{ nodeId: other }],
    };

    expect(isSelectedTaskDeskNodeCatalogued(catalog, selected)).toBe(false);
    expect(isSelectedTaskDeskNodeCatalogued(catalog, other)).toBe(true);
  });
});
