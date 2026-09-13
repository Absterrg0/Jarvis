# Desktop use

Desktop use lets ARIS see and control the desktop of the machine a node runs on. The agent can take
a screenshot, move the pointer, click, drag, scroll, type, press keys, list windows, and focus a
window. Because a node only ever controls its own display, this works for a real device in your mesh
rather than a cloud virtual machine.

## Using it with the agent

On Full nodes, agent sessions get the `t3-code` desktop tools when the node advertises desktop support.
Ask in plain language and the agent picks the actions:

- "Take a screenshot of the desktop."
- "Open the Settings app and turn off notifications."
- "Click the Save button in the window that is open, then type the project name."

The tools are `desktop_status`, `desktop_screenshot`, `desktop_move`, `desktop_click`,
`desktop_drag`, `desktop_scroll`, `desktop_type`, `desktop_key`, `desktop_windows`, and
`desktop_focus_window`. `desktop_status` reports the platform, backend, displays, and which action
classes work.

Give the agent a screenshot first when you want it to hit a target accurately. It sees pointer
position when the platform exposes it.

## Controlling a remote node

A node controls the desktop of the machine it runs on. When you talk to ARIS from a controller
device, the request runs on the execution node and desktop use acts on that node, not on the
controller. There is no cloud VM and no moving work to a different machine.

Desktop use requires Full or Controller running in a graphical session. Headless does not provide
desktop capture or control, even if graphical tools happen to be installed. Controller can control
its local desktop through authenticated clients, but runs coding agents on remote execution nodes.

## What each platform needs

Linux, X11: install `xrandr`, `xdotool`, and a capture helper (`imagemagick`, `scrot`, or
`ffmpeg`). Install `wmctrl` for window discovery and focus. On Debian/Ubuntu, `xrandr` comes
with `x11-xserver-utils`. Start the node within your graphical session.

Linux, Wayland: wlroots compositors need `wlr-randr` and `grim`; GNOME needs `gjs` and
`gnome-screenshot`. Other compositors currently report unavailable when their display geometry
cannot be queried. `wtype` provides keyboard input on compositors with the virtual-keyboard
protocol. Pointer input needs a running `ydotoold` daemon with `/dev/uinput` access and a socket
accessible to the node. `ydotool` is also a keyboard fallback, limited to ASCII text and US-layout
key positions. Wayland window discovery and focus are currently unsupported.

macOS: capture and input use system tools. Grant Screen Recording and Accessibility to the app
or terminal hosting the node when macOS requests them. Window discovery and shortcuts can also
request Automation access to System Events. Restart the node after changing permissions.

Windows: capture and input use built-in PowerShell. Run the node in the signed-in graphical
session. Windows can refuse input to elevated applications and secure desktops; desktop use
does not bypass those restrictions.

## Action limits

Input is serialized across connected agents and controllers. Drags release their button on
completion or cancellation. If release fails, further input is blocked until cleanup succeeds.
Requests can still partially act before an error, so take a new screenshot before retrying.

Coordinates refer to the returned screenshot, including on scaled monitors. Targets outside the
selected display are refused. Text, scrolling, drag duration and pending requests are bounded.

## Troubleshooting

- "Desktop use is unavailable": no capture tool was found, or the node has no graphical session.
  `desktop_status` gives the reason.
- Wayland capture is unavailable: check the compositor-specific helpers above. ARIS does not use
  XWayland screenshots as a fallback for native Wayland windows.
- The agent clicks the wrong place: ask for a screenshot first, then target by the coordinates it
  reports.
