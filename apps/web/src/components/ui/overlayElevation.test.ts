import { describe, expect, it } from "vite-plus/test";

import { DIALOG_POPUP_CLASS } from "./dialog-styles";
import menuSource from "./menu.tsx?raw";
import popoverSource from "./popover.tsx?raw";
import selectSource from "./select.tsx?raw";

describe("overlay elevation", () => {
  it("keeps dialog popups elevated on flat opaque surfaces", () => {
    expect(DIALOG_POPUP_CLASS).toContain("bg-popover");
    expect(DIALOG_POPUP_CLASS).toContain("border-border");
    expect(DIALOG_POPUP_CLASS).toContain("rounded");
    expect(DIALOG_POPUP_CLASS).not.toContain("rounded-2xl");
    expect(DIALOG_POPUP_CLASS).toContain("shadow-[0_24px_64px_-24px_rgb(0_0_0/55%)]");
  });

  it("keeps menu popups elevated while sharp", () => {
    expect(menuSource).toContain("rounded-[var(--control-radius)]");
    expect(menuSource).toContain("border-border");
    expect(menuSource).toContain("bg-popover");
    expect(menuSource).toContain("shadow-[0_16px_40px_-18px_rgb(0_0_0/55%)]");
  });

  it("keeps popover popups elevated while sharp", () => {
    expect(popoverSource).toContain("rounded-[var(--control-radius)]");
    expect(popoverSource).toContain("border-border");
    expect(popoverSource).toContain("bg-popover");
    expect(popoverSource).toContain("shadow-[0_16px_40px_-18px_rgb(0_0_0/55%)]");
  });

  it("keeps select popups elevated while sharp", () => {
    expect(selectSource).toContain("rounded-[var(--control-radius)]");
    expect(selectSource).toContain("border-border");
    expect(selectSource).toContain("bg-popover");
    expect(selectSource).toContain("shadow-[0_16px_40px_-18px_rgb(0_0_0/55%)]");
  });
});
