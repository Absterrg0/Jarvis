import { describe, expect, it } from "@effect/vitest";

import { parseDesktopCirceOverlayHelperCommand } from "./DesktopCirceOverlayHelper.ts";

describe("DesktopCirceOverlayHelper protocol", () => {
  it("accepts orb state and catalog commands", () => {
    expect(
      parseDesktopCirceOverlayHelperCommand(
        '{"type":"orb-state","state":{"enabled":true,"active":true,"status":"live"}}',
      ),
    ).toEqual({
      type: "orb-state",
      state: { enabled: true, active: true, status: "live" },
    });
    expect(
      parseDesktopCirceOverlayHelperCommand(
        '{"type":"orb-catalog","catalog":{"providers":[],"selected":null}}',
      ),
    ).toEqual({
      type: "orb-catalog",
      catalog: { providers: [], selected: null },
    });
    expect(parseDesktopCirceOverlayHelperCommand('{"type":"show"}')).toEqual({ type: "show" });
    expect(parseDesktopCirceOverlayHelperCommand('{"type":"hide"}')).toEqual({ type: "hide" });
    expect(parseDesktopCirceOverlayHelperCommand('{"type":"shutdown"}')).toEqual({
      type: "shutdown",
    });
    expect(parseDesktopCirceOverlayHelperCommand('{"type":"resize","expanded":true}')).toEqual({
      type: "resize",
      expanded: true,
    });
    expect(parseDesktopCirceOverlayHelperCommand('{"type":"resize","expanded":false}')).toEqual({
      type: "resize",
      expanded: false,
    });
  });

  it("rejects malformed and foreign lines", () => {
    expect(parseDesktopCirceOverlayHelperCommand("not json")).toBeNull();
    expect(parseDesktopCirceOverlayHelperCommand('{"type":"orb-state"}')).toBeNull();
    expect(
      parseDesktopCirceOverlayHelperCommand(
        '{"type":"orb-state","state":{"enabled":true,"active":true,"status":"bogus"}}',
      ),
    ).toBeNull();
    expect(
      parseDesktopCirceOverlayHelperCommand('{"type":"orb-catalog","catalog":{"nope":[]}}'),
    ).toBeNull();
    expect(parseDesktopCirceOverlayHelperCommand('{"type":"eject"}')).toBeNull();
    expect(
      parseDesktopCirceOverlayHelperCommand(
        '{"type":"state","state":{"status":"capturing"},"interaction":"hold"}',
      ),
    ).toBeNull();
    expect(parseDesktopCirceOverlayHelperCommand('{"type":"level","level":0.4}')).toBeNull();
    expect(parseDesktopCirceOverlayHelperCommand('{"type":"resize","expanded":"true"}')).toBeNull();
  });
});
