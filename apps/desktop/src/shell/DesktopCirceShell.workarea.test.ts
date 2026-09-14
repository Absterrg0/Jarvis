import { describe, expect, it, vi } from "vite-plus/test";

import { createDesktopCirceShell } from "./DesktopCirceShell.ts";

// Two side-by-side 1080p displays. The cursor idles on the primary (right)
// display while the orb lives on the secondary (left) one.
const screenState = vi.hoisted(() => ({
  cursor: { x: 100, y: 100 },
  cursorCalls: 0,
  nearestCalls: [] as Array<{ x: number; y: number }>,
  displayFor: (point: { x: number; y: number }) =>
    point.x < 0
      ? { x: -1920, y: 0, width: 1920, height: 1080 }
      : { x: 0, y: 0, width: 1920, height: 1080 },
}));

vi.mock("electron", () => ({
  screen: {
    getCursorScreenPoint: () => {
      screenState.cursorCalls += 1;
      return { ...screenState.cursor };
    },
    getDisplayNearestPoint: (point: { x: number; y: number }) => {
      screenState.nearestCalls.push({ ...point });
      const workArea = screenState.displayFor(point);
      return { workArea, bounds: workArea };
    },
  },
  globalShortcut: { register: () => true, unregister: () => {} },
  Tray: class {},
  Menu: { buildFromTemplate: (template: unknown) => template },
  BrowserWindow: class {},
  app: { getPath: () => "/tmp" },
  ipcMain: { on: () => {}, handle: () => {} },
}));

function windowMock(initialBounds: { x: number; y: number; width: number; height: number }) {
  let mockBounds = { ...initialBounds };
  const setBoundsCalls: Array<{ x: number; y: number; width: number; height: number }> = [];
  let consoleListener: ((event: unknown, level: number, message: string) => void) | undefined;
  const overlay = {
    isDestroyed: () => false,
    getBounds: () => ({ ...mockBounds }),
    setBounds: (bounds: { x: number; y: number; width: number; height: number }) => {
      mockBounds = { ...bounds };
      setBoundsCalls.push({ ...bounds });
    },
    setPosition: vi.fn(),
    setFocusable: vi.fn(),
    focus: vi.fn(),
    showInactive: vi.fn(),
    hide: vi.fn(),
    webContents: {
      executeJavaScript: vi.fn(() => Promise.resolve()),
      on: vi.fn((event: string, listener: typeof consoleListener) => {
        if (event === "console-message") consoleListener = listener;
      }),
      once: (_event: string, callback: () => void) => callback(),
    },
  };
  return {
    overlay,
    setBoundsCalls,
    setMockBounds: (bounds: { x: number; y: number; width: number; height: number }) => {
      mockBounds = { ...bounds };
    },
    sendConsole: (message: string) => consoleListener?.({}, 1, message),
  };
}

function shellWith(window: ReturnType<typeof windowMock>) {
  const shell = createDesktopCirceShell({
    displayName: "Circe",
    iconPath: null,
    platform: "linux",
    architecture: "x64",
    installPortalHoldShortcut: async () => null,
    createOverlay: () => window.overlay as never,
    // No injected work area: the shell must resolve displays itself.
    sendLiveVoiceToggle: vi.fn(),
    getLiveVoiceState: () => ({ enabled: true, active: false, status: "idle" }),
    revealMain: vi.fn(),
    quit: vi.fn(),
  });
  shell.start();
  return shell;
}

describe("DesktopCirceShell multi-display work area", () => {
  it("expands on the orb display instead of following the cursor", () => {
    screenState.cursorCalls = 0;
    screenState.nearestCalls.length = 0;
    const window = windowMock({ x: -1900, y: 500, width: 72, height: 72 });
    const shell = shellWith(window);

    // Seat the orb on the secondary display, then open the picker while the
    // cursor idles on the primary display.
    window.sendConsole('[circe-orb] {"type":"drag","phase":"end"}');
    window.sendConsole('[circe-orb] {"type":"expanded","expanded":true}');

    // Right-margin snap on the secondary display, expanded in place. Resolving
    // from the cursor display would clamp x into [0, 1536] instead.
    expect(window.setBoundsCalls[window.setBoundsCalls.length - 1]).toEqual({
      x: -400,
      y: 320,
      width: 384,
      height: 440,
    });
    expect(screenState.cursorCalls).toBe(0);
    expect(screenState.nearestCalls).toContainEqual({ x: -52, y: 540 });
    shell.stop();
  });

  it("stores the displayed centre after a drop while expanded", () => {
    const window = windowMock({ x: 114, y: 114, width: 72, height: 72 });
    const shell = shellWith(window);

    window.sendConsole('[circe-orb] {"type":"expanded","expanded":true}');
    // The user drags the expanded panel to a free spot the panel cannot hold.
    window.setMockBounds({ x: 114, y: 114, width: 72, height: 72 });
    window.sendConsole('[circe-orb] {"type":"drag","phase":"end"}');
    window.sendConsole('[circe-orb] {"type":"expanded","expanded":false}');

    // Collapsing returns to the displayed spot, not the requested drop.
    expect(window.setBoundsCalls[window.setBoundsCalls.length - 1]).toEqual({
      x: 312,
      y: 184,
      width: 72,
      height: 72,
    });
    shell.stop();
  });
});
