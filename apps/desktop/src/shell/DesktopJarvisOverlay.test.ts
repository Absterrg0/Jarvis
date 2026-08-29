import { describe, expect, it } from "@effect/vitest";

import {
  desktopJarvisOverlayDataUrl,
  desktopJarvisOverlayLevelScript,
  desktopJarvisOverlayPresentation,
  desktopJarvisOverlayStateScript,
} from "./DesktopJarvisOverlay.ts";

describe("DesktopJarvisOverlay", () => {
  it("maps every voice state to a distinct fluid surface profile", () => {
    const profiles = [
      ["starting", "Warming local listening", true],
      ["capturing", "Listening", true],
      ["transcribing", "Understanding your request", true],
      ["speaking", "Jarvis is speaking", true],
      ["ready", "Jarvis is ready", false],
      ["error", "Jarvis voice needs attention", false],
      ["unavailable", "Jarvis voice is unavailable", false],
    ] as const;

    for (const [status, label, animated] of profiles) {
      const profile = desktopJarvisOverlayPresentation({ status, native: true });
      expect(profile.label).toBe(label);
      expect(profile.animated).toBe(animated);
      expect(profile.settled).toBe(!animated);
      expect(profile.accent).toMatch(/^#[0-9a-f]{6}$/);
    }
    expect(
      desktopJarvisOverlayPresentation(
        { status: "capturing", native: true },
        { interaction: "tap" },
      ).label,
    ).toBe("Listening — tap again to stop");
    expect(desktopJarvisOverlayStateScript({ status: "speaking", native: true })).toContain(
      'setState("speaking", "hold")',
    );
  });

  it("ships a local bottom pill with lightweight state-driven motion", () => {
    const html = decodeURIComponent(
      desktopJarvisOverlayDataUrl().replace(/^data:text\/html;charset=utf-8,/, ""),
    );
    const serializedProfiles = html.match(/const profiles = (\{.*?\});/);
    expect(serializedProfiles).not.toBeNull();
    const rendererStatuses = Object.keys(JSON.parse(serializedProfiles?.[1] ?? "{}"));
    expect(rendererStatuses.sort()).toEqual(
      ["starting", "capturing", "transcribing", "speaking", "ready", "error", "unavailable"].sort(),
    );
    expect(html).toContain('class="waveform"');
    expect(html).not.toContain("@keyframes waveform");
    expect(html).toContain("transition:opacity 180ms ease,transform 100ms ease");
    expect(html).toContain("@keyframes dock-in");
    expect(html).toContain("prefers-reduced-motion: reduce");
    expect(html).not.toContain("<canvas");
    expect(html).not.toContain("requestAnimationFrame");
    expect(html).not.toContain('getContext("webgl"');
    expect(desktopJarvisOverlayLevelScript(0.4)).toContain("setLevel(0.4)");
    expect(html).toContain("connect-src 'none'");
    expect(html).not.toContain("https://");
    expect(html).not.toContain("http://");
  });
});
