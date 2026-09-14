import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { openCirceWebsite } from "./CirceQuickActions.logic";

const source = "open youtube.com";
afterEach(() => vi.unstubAllGlobals());
describe("Circe visible website launcher", () => {
  it("uses the local desktop shell and preserves its failure result", async () => {
    const openExternal = vi.fn().mockResolvedValue(false);
    const open = vi.fn();
    vi.stubGlobal("window", { desktopBridge: { openExternal }, open });
    expect(await openCirceWebsite("https://www.youtube.com/", source)).toBe(false);
    expect(openExternal).toHaveBeenCalledWith("https://www.youtube.com/");
    expect(open).not.toHaveBeenCalled();
  });
  it("focuses a newly opened browser window and removes the opener", async () => {
    const tab = { opener: {}, focus: vi.fn() };
    const open = vi.fn().mockReturnValue(tab);
    vi.stubGlobal("window", { open });
    expect(await openCirceWebsite("https://www.youtube.com/", source)).toBe(true);
    expect(tab.opener).toBeNull();
    expect(tab.focus).toHaveBeenCalledTimes(1);
  });
  it("reports popup blocking", async () => {
    vi.stubGlobal("window", { open: vi.fn().mockReturnValue(null) });
    expect(await openCirceWebsite("https://www.youtube.com/", source)).toBe(false);
  });
  it("refuses a target the user never named", async () => {
    const open = vi.fn();
    vi.stubGlobal("window", { open });
    expect(await openCirceWebsite("https://evil.example", "open YouTube")).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });
  it.each(["javascript:alert(1)", "file:///tmp/page", "https://user:password@example.com/"])(
    "refuses unsafe launch target %s",
    async (url) => {
      const open = vi.fn();
      vi.stubGlobal("window", { open });
      expect(await openCirceWebsite(url, url)).toBe(false);
      expect(open).not.toHaveBeenCalled();
    },
  );
});
