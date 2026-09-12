import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  DESKTOP_JARVIS_ORB_COLLAPSED_HEIGHT,
  DESKTOP_JARVIS_ORB_COLLAPSED_WIDTH,
  DESKTOP_JARVIS_ORB_CONSOLE_PREFIX,
  DESKTOP_JARVIS_ORB_MARGIN,
  DESKTOP_JARVIS_ORB_WINDOW_HEIGHT,
  DESKTOP_JARVIS_ORB_WINDOW_WIDTH,
  desktopJarvisOrbCatalogScript,
  desktopJarvisOrbPresentation,
  desktopJarvisOrbStateScript,
  desktopJarvisOverlayDataUrl,
  parseDesktopJarvisOverlayEvent,
  parseDesktopJarvisOrbEvent,
} from "./DesktopJarvisOverlay.ts";

describe("DesktopJarvisOrb", () => {
  it("maps every live state to a readable status, marking active sessions", () => {
    const profiles = [
      ["idle", "ARIS is idle", false],
      ["requesting", "Starting live conversation", true],
      ["connecting", "Connecting live conversation", true],
      ["live", "Live conversation", true],
      ["closing", "Ending live conversation", false],
      ["failed", "Live conversation failed", false],
    ] as const;

    for (const [status, label, animated] of profiles) {
      const profile = desktopJarvisOrbPresentation({ enabled: true, active: true, status });
      expect(profile.label).toBe(label);
      expect(profile.animated).toBe(animated);
      expect(profile.accent).toMatch(/^#[0-9a-f]{6}$/);
    }
    // Idle never pulses, even when the node has a key.
    expect(
      desktopJarvisOrbPresentation({ enabled: true, active: false, status: "idle" }).animated,
    ).toBe(false);
    // A stale "live" flag without an active session never animates.
    expect(
      desktopJarvisOrbPresentation({ enabled: true, active: false, status: "live" }).animated,
    ).toBe(false);
    expect(desktopJarvisOrbStateScript({ enabled: true, active: true, status: "live" })).toContain(
      'setLiveState({"enabled":true,"active":true,"status":"live"})',
    );
  });

  it("ships a liquid-glass orb with providers and running agents", () => {
    const html = decodeURIComponent(
      desktopJarvisOverlayDataUrl().replace(/^data:text\/html;charset=utf-8,/, ""),
    );
    // Orb plus short provider picker underneath. The picker mirrors the
    // app dropdown: muted section label, flat rows, hint below the list.
    // No Close button; the orb toggles and Escape collapses.
    expect(html).toContain("data-orb");
    expect(html).toContain("data-orb-root");
    expect(html).toContain("orb-halo");
    expect(html).toContain("data-picker");
    expect(html).toContain("data-provider-list");
    expect(html).toContain("data-picker-error");
    expect(html).toContain("picker-label");
    expect(html).toContain("Providers");
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
    expect(html).toContain(DESKTOP_JARVIS_ORB_CONSOLE_PREFIX);
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
    expect(html).toContain("main.webgl .orb-halo{display:none}");
    expect(html).toContain('main[data-expanded="true"] .picker{opacity:1;transform:none}');
    expect(html).toContain("connect-src 'none'");
    expect(html).not.toContain("https://");
    expect(html).not.toContain("http://");
  });

  it("keeps the orb window tight around the orb plus the short picker", () => {
    expect(DESKTOP_JARVIS_ORB_WINDOW_WIDTH).toBe(384);
    expect(DESKTOP_JARVIS_ORB_WINDOW_HEIGHT).toBe(440);
    expect(DESKTOP_JARVIS_ORB_MARGIN).toBe(16);
    expect(DESKTOP_JARVIS_ORB_COLLAPSED_WIDTH).toBe(72);
    expect(DESKTOP_JARVIS_ORB_COLLAPSED_HEIGHT).toBe(72);
    const html = decodeURIComponent(
      desktopJarvisOverlayDataUrl().replace(/^data:text\/html;charset=utf-8,/, ""),
    );
    expect(html).toContain("width:52px;height:52px");
    expect(html).toContain("width:72px;height:72px");
    expect(html).toContain("top:calc(50% - 36px)");
    expect(html).toContain("width:calc(100% - 84px)");
  });

  it("renders a flat shortlist with provider plus model rows and honest states", () => {
    const html = decodeURIComponent(
      desktopJarvisOverlayDataUrl().replace(/^data:text\/html;charset=utf-8,/, ""),
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
          projectTitle: "Jarvis",
          nodeLabel: "Laptop",
          providerLabel: "Codex",
          status: "running" as const,
        },
      ],
    };
    const script = desktopJarvisOrbCatalogScript(catalog);
    expect(script).toContain("setCatalog");
    expect(script).toContain("claudeAgent");
    expect(script).toContain("sonnet");
    expect(script).toContain("Refactor shell");
  });

  it("reports expansion events while keeping provider selection separate", () => {
    expect(
      parseDesktopJarvisOverlayEvent('[jarvis-orb] {"type":"expanded","expanded":true}'),
    ).toEqual({ type: "expanded", expanded: true });
    expect(
      parseDesktopJarvisOverlayEvent('[jarvis-orb] {"type":"expanded","expanded":false}'),
    ).toEqual({ type: "expanded", expanded: false });
    expect(
      parseDesktopJarvisOverlayEvent('[jarvis-orb] {"type":"expanded","expanded":"yes"}'),
    ).toBeNull();
  });

  it("parses orb picker selections and rejects everything else", () => {
    expect(
      parseDesktopJarvisOrbEvent(
        '[jarvis-orb] {"type":"select","instanceId":"codex","model":"gpt-5"}',
      ),
    ).toEqual({ instanceId: "codex", model: "gpt-5" });
    expect(parseDesktopJarvisOrbEvent("React devtools hook")).toBeNull();
    expect(parseDesktopJarvisOrbEvent("[jarvis-orb] not json")).toBeNull();
    expect(parseDesktopJarvisOrbEvent('[jarvis-orb] {"type":"click"}')).toBeNull();
    expect(
      parseDesktopJarvisOrbEvent('[jarvis-orb] {"type":"select","instanceId":"","model":"x"}'),
    ).toBeNull();
    expect(
      parseDesktopJarvisOrbEvent('[jarvis-orb] {"type":"select","instanceId":"x","model":""}'),
    ).toBeNull();
    expect(
      parseDesktopJarvisOrbEvent(
        `[jarvis-orb] {"type":"select","instanceId":"${"i".repeat(300)}","model":"x"}`,
      ),
    ).toBeNull();
  });
});
