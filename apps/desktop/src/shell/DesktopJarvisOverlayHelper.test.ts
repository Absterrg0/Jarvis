import { describe, expect, it } from "@effect/vitest";

import { parseDesktopJarvisOverlayHelperCommand } from "./DesktopJarvisOverlayHelper.ts";

describe("DesktopJarvisOverlayHelper protocol", () => {
  it("accepts orb state and catalog commands", () => {
    expect(
      parseDesktopJarvisOverlayHelperCommand(
        '{"type":"orb-state","state":{"enabled":true,"active":true,"status":"live"}}',
      ),
    ).toEqual({
      type: "orb-state",
      state: { enabled: true, active: true, status: "live" },
    });
    expect(
      parseDesktopJarvisOverlayHelperCommand(
        '{"type":"orb-catalog","catalog":{"providers":[],"selected":null}}',
      ),
    ).toEqual({
      type: "orb-catalog",
      catalog: { providers: [], selected: null },
    });
    expect(parseDesktopJarvisOverlayHelperCommand('{"type":"show"}')).toEqual({ type: "show" });
    expect(parseDesktopJarvisOverlayHelperCommand('{"type":"hide"}')).toEqual({ type: "hide" });
    expect(parseDesktopJarvisOverlayHelperCommand('{"type":"shutdown"}')).toEqual({
      type: "shutdown",
    });
    expect(parseDesktopJarvisOverlayHelperCommand('{"type":"resize","expanded":true}')).toEqual({
      type: "resize",
      expanded: true,
    });
    expect(parseDesktopJarvisOverlayHelperCommand('{"type":"resize","expanded":false}')).toEqual({
      type: "resize",
      expanded: false,
    });
  });

  it("rejects malformed and foreign lines", () => {
    expect(parseDesktopJarvisOverlayHelperCommand("not json")).toBeNull();
    expect(parseDesktopJarvisOverlayHelperCommand('{"type":"orb-state"}')).toBeNull();
    expect(
      parseDesktopJarvisOverlayHelperCommand(
        '{"type":"orb-state","state":{"enabled":true,"active":true,"status":"bogus"}}',
      ),
    ).toBeNull();
    expect(
      parseDesktopJarvisOverlayHelperCommand('{"type":"orb-catalog","catalog":{"nope":[]}}'),
    ).toBeNull();
    expect(parseDesktopJarvisOverlayHelperCommand('{"type":"eject"}')).toBeNull();
    expect(
      parseDesktopJarvisOverlayHelperCommand(
        '{"type":"state","state":{"status":"capturing"},"interaction":"hold"}',
      ),
    ).toBeNull();
    expect(parseDesktopJarvisOverlayHelperCommand('{"type":"level","level":0.4}')).toBeNull();
    expect(
      parseDesktopJarvisOverlayHelperCommand('{"type":"resize","expanded":"true"}'),
    ).toBeNull();
  });
});
