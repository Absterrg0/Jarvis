# Desktop use

Desktop use is an Circe adapter at the node's authenticated MCP and WebSocket boundaries. It
controls the OS session of that node, including when reached remotely. It does not route input
to the controller's machine or depend on the Electron renderer. Provider and orchestration
internals do not own desktop policy. Full and Controller provide desktop capability; Headless
refuses every desktop operation before discovering or spawning helpers.

## Input ownership

All MCP and RPC input shares one node-local queue. A drag owns its button through completion or
cancellation; public requests cannot leave buttons held between calls. Cleanup finishes before
the next action starts. If the helper cannot release input, the driver retains cleanup and
refuses new injection until release succeeds. OS permission loss or a server crash can still
prevent cleanup; this is not a guarantee across process death.

Helpers run in bounded process scopes. Timing out or cancelling a command terminates and reaps
it before releasing the queue. Do not retry input on another backend after injection starts:
a failed command can have partially acted. Capture can try another native helper because it
has no input side effects.

## Coordinate contract

A frame contains one real, currently connected display. Its pixels are normalized to that
display's native pointer coordinate grid, with frame scale 1. Input coordinates are local to
that frame; the driver applies the current display origin once. The display catalog can retain
the hardware scale. Do not multiply input by that scale again.

An unknown display fails rather than selecting the primary display. Unqueryable display
geometry and mismatched capture geometry also fail; inventing a synthetic display makes a
plausible screenshot capable of directing input to the wrong place. Wayland uses native capture
only because XWayland root capture does not represent the compositor's desktop.

## Readiness and transport

The environment capability flag advertises the API; `desktop_status` checks the graphical
session and capture path. Capture readiness and input permissions are separate. Platform helper
installation alone is not proof of readiness.

The ordinary authenticated node routes carry desktop RPCs. Capture, frame subscriptions and
input require Operate scope; status and window listing require Read. Frame subscriptions stop
capturing when cancelled. There is no independent desktop server or background capture loop.
