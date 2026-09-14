import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  DESKTOP_CIRCE_ORB_CENTER_FROM_RIGHT,
  DESKTOP_CIRCE_ORB_COLLAPSED_HEIGHT,
  DESKTOP_CIRCE_ORB_COLLAPSED_WIDTH,
  DESKTOP_CIRCE_ORB_CONSOLE_PREFIX,
  DESKTOP_CIRCE_ORB_MARGIN,
  DESKTOP_CIRCE_ORB_WINDOW_HEIGHT,
  DESKTOP_CIRCE_ORB_WINDOW_WIDTH,
  desktopCirceOrbCatalogScript,
  desktopCirceOrbPresentation,
  desktopCirceOrbStateScript,
  desktopCirceOverlayDataUrl,
  desktopCirceOverlayOrbCenter,
  parseDesktopCirceOverlayEvent,
  parseDesktopCirceOrbEvent,
  resolveDesktopCirceOverlayBounds,
  snapDesktopCirceOverlayAnchor,
} from "./DesktopCirceOverlay.ts";

describe("DesktopCirceOrb", () => {
  it("maps every live state to a readable status, marking active sessions", () => {
    const profiles = [
      ["idle", "Circe is idle", false],
      ["requesting", "Starting live conversation", true],
      ["connecting", "Connecting live conversation", true],
      ["live", "Live conversation", true],
      ["closing", "Ending live conversation", false],
      ["failed", "Live conversation failed", false],
    ] as const;

    for (const [status, label, animated] of profiles) {
      const profile = desktopCirceOrbPresentation({ enabled: true, active: true, status });
      expect(profile.label).toBe(label);
      expect(profile.animated).toBe(animated);
      expect(profile.accent).toMatch(/^#[0-9a-f]{6}$/);
    }
    // Idle never pulses, even when the node has a key.
    expect(
      desktopCirceOrbPresentation({ enabled: true, active: false, status: "idle" }).animated,
    ).toBe(false);
    // A stale "live" flag without an active session never animates.
    expect(
      desktopCirceOrbPresentation({ enabled: true, active: false, status: "live" }).animated,
    ).toBe(false);
    expect(desktopCirceOrbStateScript({ enabled: true, active: true, status: "live" })).toContain(
      'setLiveState({"enabled":true,"active":true,"status":"live"})',
    );
  });

  it("ships a liquid-glass orb with providers and running agents", () => {
    const html = decodeURIComponent(
      desktopCirceOverlayDataUrl().replace(/^data:text\/html;charset=utf-8,/, ""),
    );
    // Orb plus short provider picker underneath. The picker mirrors the
    // app dropdown: muted section label, flat rows, hint below the list.
    // No Close button; the orb toggles and Escape collapses.
    expect(html).toContain("data-orb");
    expect(html).toContain("data-orb-root");
    expect(html).not.toContain("orb-halo");
    expect(html).toContain("data-picker");
    expect(html).toContain("data-provider-list");
    expect(html).toContain("data-picker-error");
    expect(html).toContain("picker-label");
    expect(html).toContain("Default agent");
    expect(html).toContain("Running agents");
    expect(html).toContain("data-running-list");
    expect(html).not.toContain("data-picker-close");
    expect(html).not.toContain("picker-close");
    expect(html).not.toContain("picker-head");
    expect(html).not.toContain("picker-title");
    expect(html).not.toContain(">Provider<");
    expect(html).not.toContain(">Close<");
    // No status sentence under the orb; the hint lives below the list and
    // state stays in the orb color plus the button label.
    expect(html).not.toContain("data-status-label");
    expect(html).not.toContain('class="status"');
    expect(html).toContain("picker-hint");
    expect(html).toContain("Ctrl+Shift+J toggles voice.");
    expect(html.indexOf("Ctrl+Shift+J toggles voice.")).toBeGreaterThan(
      html.indexOf("data-provider-list"),
    );
    // Selected rows carry an inline check SVG, matching the app dropdown.
    expect(html).toContain("row-check");
    expect(html).toContain('<svg class="row-check"');
    expect(html).toContain("aria-label");
    // Picker reports selections on the console bridge; toggling stays local
    // to the orb button and Escape.
    expect(html).toContain(DESKTOP_CIRCE_ORB_CONSOLE_PREFIX);
    expect(html).toContain("setLiveState");
    expect(html).toContain("setCatalog");
    // Middle-right anchoring, not the old bottom dock.
    expect(html).toContain("right:0");
    expect(html).toContain("top:0");
    expect(html).not.toContain("inset:6px 0");
    expect(html).toContain("prefers-reduced-motion: reduce");
    // The orb is a WebGL shader canvas, with a CSS orb fallback when WebGL or
    // motion is unavailable, and a transition on expand/collapse.
    expect(html).toContain("data-orb-canvas");
    expect(html).toContain('type="x-shader/x-fragment"');
    expect(html).toContain("gl_FragColor");
    expect(html).toContain("getContext");
    expect(html).toContain("requestAnimationFrame");
    expect(html).toContain("visibilitychange");
    // The orb is draggable: pointer capture keeps moves flowing after the
    // cursor leaves the tiny window, and a drag must not toggle the panel.
    expect(html).toContain("pointerdown");
    expect(html).toContain("pointermove");
    expect(html).toContain("setPointerCapture");
    expect(html).toContain("releasePointerCapture");
    expect(html).toContain("cursor:grab");
    expect(html).not.toContain("orb-halo");
    expect(html).toContain('main[data-expanded="true"] .picker{opacity:1;transform:none}');
    expect(html).toContain("connect-src 'none'");
    expect(html).not.toContain("https://");
    expect(html).not.toContain("http://");
  });

  it("keeps the orb window tight around the orb plus the short picker", () => {
    expect(DESKTOP_CIRCE_ORB_WINDOW_WIDTH).toBe(384);
    expect(DESKTOP_CIRCE_ORB_WINDOW_HEIGHT).toBe(440);
    expect(DESKTOP_CIRCE_ORB_MARGIN).toBe(16);
    expect(DESKTOP_CIRCE_ORB_COLLAPSED_WIDTH).toBe(72);
    expect(DESKTOP_CIRCE_ORB_COLLAPSED_HEIGHT).toBe(72);
    const html = decodeURIComponent(
      desktopCirceOverlayDataUrl().replace(/^data:text\/html;charset=utf-8,/, ""),
    );
    expect(html).toContain("width:52px;height:52px");
    expect(html).toContain("width:72px;height:72px");
    expect(html).toContain("top:calc(50% - 36px)");
    expect(html).toContain("width:calc(100% - 84px)");
  });

  it("renders a flat shortlist with provider plus model rows and honest states", () => {
    const html = decodeURIComponent(
      desktopCirceOverlayDataUrl().replace(/^data:text\/html;charset=utf-8,/, ""),
    );
    // One row per provider, capped at six, using the first listed model.
    expect(html).toContain("slice(0, 6)");
    expect(html).toContain("provider-row");
    expect(html).toContain("row-provider");
    expect(html).toContain("row-model");
    expect(html).toContain("row-state");
    expect(html).toContain("row-check");
    expect(html).toContain("Unavailable");
    expect(html).toContain("Saving…");
    // The selected row shows a check icon, not a text badge.
    expect(html).not.toContain(">Current<");
    // An unsaved suggestion renders as its own honest state, never as current.
    expect(html).toContain("Suggested");
    expect(html).toContain("suggested until saved");
    expect(html).toContain("suggestedSelection");
    expect(html).toContain("overflow:auto");
    expect(html).toContain("scrollbar-width:thin");
    // No em dashes in user-visible copy.
    expect(html).not.toContain("—");
    // Old grouped multi-model markup is gone.
    expect(html).not.toContain("model-row");
    expect(html).not.toContain("provider-group");
  });

  it("serializes the renderer catalog verbatim for the picker", () => {
    const catalog = {
      providers: [
        {
          instanceId: "claudeAgent",
          displayName: "Claude",
          driver: "claudeAgent",
          available: true,
          models: [{ slug: "sonnet", name: "Sonnet" }],
        },
      ],
      selected: null,
      pendingSelection: null,
      error: null,
      agents: [
        {
          taskRef: {
            executionNodeId: EnvironmentId.make("node-a"),
            threadId: ThreadId.make("thread-1"),
          },
          title: "Refactor shell",
          projectTitle: "Circe",
          nodeLabel: "Laptop",
          providerLabel: "Codex",
          status: "running" as const,
        },
      ],
    };
    const script = desktopCirceOrbCatalogScript(catalog);
    expect(script).toContain("setCatalog");
    expect(script).toContain("claudeAgent");
    expect(script).toContain("sonnet");
    expect(script).toContain("Refactor shell");
  });

  it("reports expansion events while keeping provider selection separate", () => {
    expect(
      parseDesktopCirceOverlayEvent('[circe-orb] {"type":"expanded","expanded":true}'),
    ).toEqual({ type: "expanded", expanded: true });
    expect(
      parseDesktopCirceOverlayEvent('[circe-orb] {"type":"expanded","expanded":false}'),
    ).toEqual({ type: "expanded", expanded: false });
    expect(
      parseDesktopCirceOverlayEvent('[circe-orb] {"type":"expanded","expanded":"yes"}'),
    ).toBeNull();
  });

  it("reports orb drags so the host can move the window", () => {
    expect(
      parseDesktopCirceOverlayEvent('[circe-orb] {"type":"drag","phase":"start","x":10,"y":20}'),
    ).toEqual({ type: "drag", phase: "start", x: 10, y: 20 });
    expect(
      parseDesktopCirceOverlayEvent('[circe-orb] {"type":"drag","phase":"move","x":11,"y":21}'),
    ).toEqual({ type: "drag", phase: "move", x: 11, y: 21 });
    expect(parseDesktopCirceOverlayEvent('[circe-orb] {"type":"drag","phase":"end"}')).toEqual({
      type: "drag",
      phase: "end",
    });
    // A move without coordinates is not actionable.
    expect(parseDesktopCirceOverlayEvent('[circe-orb] {"type":"drag","phase":"move"}')).toBeNull();
  });

  it("magnets the orb to the nearest edge mesh but leaves free drops alone", () => {
    const workArea = { x: 0, y: 0, width: 1920, height: 1080 };
    // The orb sits at the window's right edge, so the left/top/bottom targets
    // sit inside the work area by the expanded window's half-footprint.
    const left = snapDesktopCirceOverlayAnchor(workArea, { x: 40, y: 540 });
    const right = snapDesktopCirceOverlayAnchor(workArea, { x: 1920 - 40, y: 540 });
    const top = snapDesktopCirceOverlayAnchor(workArea, { x: 900, y: 40 });
    const bottom = snapDesktopCirceOverlayAnchor(workArea, { x: 900, y: 1080 - 40 });
    expect(left).toEqual({
      x:
        DESKTOP_CIRCE_ORB_MARGIN +
        DESKTOP_CIRCE_ORB_WINDOW_WIDTH -
        DESKTOP_CIRCE_ORB_CENTER_FROM_RIGHT,
      y: 540,
    });
    expect(right.x).toBe(1920 - (DESKTOP_CIRCE_ORB_MARGIN + DESKTOP_CIRCE_ORB_CENTER_FROM_RIGHT));
    expect(top).toEqual({
      x: 900,
      y: DESKTOP_CIRCE_ORB_MARGIN + DESKTOP_CIRCE_ORB_WINDOW_HEIGHT / 2,
    });
    expect(bottom.y).toBe(1080 - DESKTOP_CIRCE_ORB_MARGIN - DESKTOP_CIRCE_ORB_WINDOW_HEIGHT / 2);
    const free = snapDesktopCirceOverlayAnchor(workArea, { x: 900, y: 450 });
    expect(free).toEqual({ x: 900, y: 450 });
  });

  it("snaps to the closest eligible target when mesh rows overlap", () => {
    // A short work area compresses the five mesh rows within the threshold, so
    // a first-match scan would seat the orb on the top row instead of the
    // nearest one.
    const workArea = { x: 0, y: 0, width: 1920, height: 520 };
    const snapped = snapDesktopCirceOverlayAnchor(workArea, { x: 900, y: 250 });
    expect(snapped.y).toBe(248);
  });

  it("keeps the orb centre fixed as the panel opens and closes at every edge", () => {
    const workArea = { x: 0, y: 0, width: 1920, height: 1080 };
    const drops = [
      { x: 40, y: 540 }, // left margin
      { x: 1920 - 40, y: 540 }, // right margin
      { x: 900, y: 40 }, // top row
      { x: 900, y: 1080 - 40 }, // bottom row
      { x: 900, y: 450 }, // free drop
    ];
    for (const drop of drops) {
      const anchor = snapDesktopCirceOverlayAnchor(workArea, drop);
      const collapsed = desktopCirceOverlayOrbCenter(
        resolveDesktopCirceOverlayBounds(workArea, false, anchor),
      );
      const expanded = desktopCirceOverlayOrbCenter(
        resolveDesktopCirceOverlayBounds(workArea, true, anchor),
      );
      const recollapsed = desktopCirceOverlayOrbCenter(
        resolveDesktopCirceOverlayBounds(workArea, false, anchor),
      );
      expect(collapsed).toEqual(anchor);
      expect(expanded).toEqual(anchor);
      expect(recollapsed).toEqual(anchor);
    }
  });

  it("keeps a dragged orb fixed while the panel expands around it", () => {
    const workArea = { x: 0, y: 0, width: 1920, height: 1080 };
    const anchor = { x: 500, y: 300 };
    const collapsed = resolveDesktopCirceOverlayBounds(workArea, false, anchor);
    const expanded = resolveDesktopCirceOverlayBounds(workArea, true, anchor);

    expect(collapsed.x + collapsed.width - DESKTOP_CIRCE_ORB_CENTER_FROM_RIGHT).toBe(anchor.x);
    expect(expanded.x + expanded.width - DESKTOP_CIRCE_ORB_CENTER_FROM_RIGHT).toBe(anchor.x);
    expect(desktopCirceOverlayOrbCenter(collapsed)).toEqual(anchor);
    expect(desktopCirceOverlayOrbCenter(expanded)).toEqual(anchor);
  });

  it("parses orb picker selections and rejects everything else", () => {
    expect(
      parseDesktopCirceOrbEvent(
        '[circe-orb] {"type":"select","instanceId":"codex","model":"gpt-5"}',
      ),
    ).toEqual({ instanceId: "codex", model: "gpt-5" });
    expect(parseDesktopCirceOrbEvent("React devtools hook")).toBeNull();
    expect(parseDesktopCirceOrbEvent("[circe-orb] not json")).toBeNull();
    expect(parseDesktopCirceOrbEvent('[circe-orb] {"type":"click"}')).toBeNull();
    expect(
      parseDesktopCirceOrbEvent('[circe-orb] {"type":"select","instanceId":"","model":"x"}'),
    ).toBeNull();
    expect(
      parseDesktopCirceOrbEvent('[circe-orb] {"type":"select","instanceId":"x","model":""}'),
    ).toBeNull();
    expect(
      parseDesktopCirceOrbEvent(
        `[circe-orb] {"type":"select","instanceId":"${"i".repeat(300)}","model":"x"}`,
      ),
    ).toBeNull();
  });
});
