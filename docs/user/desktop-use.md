# Desktop use

Desktop use lets ARIS see and control the desktop of the machine a node runs on. The agent can take
a screenshot, move the pointer, click, drag, scroll, type, press keys, list windows, and focus a
window. Because a node only ever controls its own display, this works for a real device in your mesh
rather than a cloud virtual machine.

## Using it with the agent

Nothing to switch on. Every agent session gets the `t3-code` tools, including the `desktop_*` tools.
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

The node has to be running in a graphical session. A Headless node with no display reports that
desktop use is unavailable.

## What each platform needs

Linux, X11:

```
sudo apt install xdotool wmctrl imagemagick ffmpeg
```

Linux, Wayland:

```
sudo apt install grim wtype ydotool
# ydotool also needs access to /dev/uinput for pointer and keyboard input
```

macOS: no installs. Capture uses `screencapture` and input uses AppleScript; `cliclick` is optional
and gives smoother pointer and drag control (`brew install cliclick`).

Windows: no installs. Capture and input use built-in PowerShell.

Where no supported tool is installed, `desktop_status` reports the reason instead of failing
silently.

## Permissions

macOS asks for two grants, both attached to the app that runs the server:

- Screen Recording, needed for screenshots.
- Accessibility, needed to move the pointer and type.

Grant them in System Settings, Privacy & Security, then restart the node. If a grant is missing,
desktop actions fail with a backend error that names the platform.

On Wayland, input needs permission to write to `/dev/uinput`. If your user cannot, pointer and
keyboard are reported unsupported.

## Safety

Actions are bounded and rate limited so a model cannot click off-screen forever or flood the input
queue. Coordinates must be real numbers in range, typed text is capped, scroll and drag are capped,
and keyboard input is limited to named keys and single printable characters.

## Troubleshooting

- "Desktop use is unavailable": no capture tool was found, or the node has no graphical session.
  `desktop_status` gives the reason.
- Screenshot is black under Wayland: the node fell back to XWayland, which cannot see native Wayland
  windows. Install `grim` (wlroots) or `gnome-screenshot` and restart the node.
- The agent clicks the wrong place: ask for a screenshot first, then target by the coordinates it
  reports.
