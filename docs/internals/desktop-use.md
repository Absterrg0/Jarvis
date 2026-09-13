# Desktop use

Desktop use is the in-house computer-control capability: a node captures its own display and injects
pointer and keyboard events. It is deliberately not a cloud or virtual-desktop path. The driver only
ever touches the machine the server process runs on, which is what makes it useful for controlling a
real device in the mesh.

## Ownership

- Wire contracts: `packages/contracts/src/desktopUse.ts`.
- Engine: `apps/server/src/jarvis/desktopUse/` (`DesktopDriver`, `DesktopUse`, `platforms`, `parsers`,
  `policy`).
- Agent surface: `apps/server/src/mcp/toolkits/desktopUse/`, gated by the `desktop-use` MCP
  capability.
- Controller surface: the generic `desktopUse.*` WebSocket RPCs and the `desktopUse` flag in
  `ExecutionEnvironmentCapabilities`.

This is an ARIS capability composed at an existing seam. It does not add fields or callbacks to
provider, session, Git, terminal, or approval internals. The upstream desktop snapshot subsystem is
renderer-coupled and serves a different purpose; desktop use does not extend it.

## Why the server process owns the driver

The server already has the node's OS session, is the authenticated mesh endpoint, and runs the MCP
toolkits. Shelling out to OS capture and input tools there means the capability works for Full and
Headless nodes alike, and an agent's desktop actions do not need the Electron renderer to be open.
Platform permissions (macOS screen recording and accessibility) attach to the process that runs the
server.

## Backend selection

`resolveBackend` maps the platform and display server to one backend. Capture tries candidates in
preference order and keeps the first that exits 0 and yields a readable PNG, so a present-but-broken
helper cannot take the capability down.

| Backend       | Capture precedence                                          | Pointer / keyboard                                         |
| ------------- | ----------------------------------------------------------- | ---------------------------------------------------------- |
| linux-x11     | `import`, `scrot`, `ffmpeg`                                 | `xdotool`; `wmctrl` for window list and focus              |
| linux-wayland | `grim`, `gnome-screenshot`, `spectacle`, `import`, `ffmpeg` | `ydotool` for pointer; `wtype` then `ydotool` for keyboard |
| macos         | `/usr/sbin/screencapture`                                   | `cliclick`; `/usr/bin/osascript` fallback for keyboard     |
| windows       | PowerShell `System.Drawing`                                 | PowerShell `SendInput` via `-EncodedCommand`               |

`import` and `ffmpeg` are last on Wayland because they can only reach X clients through XWayland and
can produce a black frame for native Wayland surfaces. The driver does not detect a black frame; a
missing native capture tool is reported in `desktop_status` and the model should not treat a blank
frame as the desktop.

## Capture mechanics

Capture writes to a fresh temp directory under the server state directory with the fixed name
`capture.png`, because every screenshot tool infers the output format from the extension. The frame's
pixel size comes from the PNG IHDR rather than from the tool's output. Displays are probed from
`xrandr`, Finder desktop bounds, or `Screen.AllScreens`; when a compositor exposes no queryable
outputs the first capture supplies one synthetic `primary` display.

## Safety

`policy.ts` is the single gate. It bounds coordinates, text length, scroll distance, and drag
duration; it restricts keyboard input to named keys and single printable characters; and it enforces
an 8 ms floor between actions. Typed text and pointer actions are rate limited through one
`Ref`-backed state in `DesktopUse`, so every caller shares the same budget.

Pointer button state is explicit (`pointer.down` / `pointer.up`). The capability does not
automatically release a held button when a session ends, so an agent that presses down must release.
This is a deliberate small surface rather than a hidden state machine; if held-button leaks show up
in practice, add release-on-idle in `DesktopUse`, not in the platform builders.

## Mesh transport

The node's server owns the RPC, so a controller reaches desktop use over the same authenticated
connection it uses for every other node operation. `desktopUse.subscribeFrames` emits frames on a
`Stream.tick` cadence and stops capturing when the subscription ends; there is no idle polling.
`desktopUse.capture` and `desktopUse.input` are for a viewer that manages its own cadence. Capture,
input, and subscribe require an Operate-scoped credential; status and window listing require Read.

## Platform notes

- macOS needs Screen Recording for capture and Accessibility for input. `desktop_status` reports the
  backend but not the TCC grant; a denied grant surfaces as a typed backend error.
- Wayland input needs `/dev/uinput` access for `ydotool`. Without it, pointer and keyboard are
  reported unsupported.
- Windows ships no native helper; the encoded PowerShell scripts carry the P/Invoke definitions.
- X11-only sessions have no portal step, so capture is a direct root-window grab.
