# Live conversation runbook

Maintainer setup, verification, and troubleshooting for the GPT-Live speech-to-speech mode.
The user-facing description lives in `docs/user/jarvis.md`.

## What runs where

- The browser/desktop renderer owns microphone and speaker audio over WebRTC. It creates the SDP
  offer and the `oai-events` data channel.
- The node creates the session: `POST https://api.openai.com/v1/live/sessions` with the node's
  OpenAI API key, `model`, `voice`, `delegation: { type: "client" }`, and the renderer's SDP offer.
  It returns the SDP answer and the opaque session id.
- GPT-Live handles speech and delegation. On `session.delegation.created`, the renderer submits the
  accumulated user transcript through the ordinary Jarvis voice submission queue, so the Director,
  grounding, clarification, and provider adapters behave exactly as typed turns.
- Backend feedback and task presentations return as `session.commentary.append` (spoken) and
  `session.thinking.append` (quiet progress). While a session is active, the browser report lane is
  bypassed.

## Configure a node

1. Open the ARIS control center on the node and find **Live conversation** under the node's
   settings.
2. Paste an OpenAI project API key, confirm or change the model (default `gpt-live-1`) and voice
   (default `marin`), then **Save**.
3. The key is written to the node secret store as `jarvis-live-voice-openai-api-key`
   (`<userdata>/secrets/jarvis-live-voice-openai-api-key.bin`). `settings.json` keeps only the
   redaction marker for `jarvisLiveVoice.apiKey`. In the parallel `ARIS-realtime` build the base
   directory is `~/.jarvis-realtime`, so the file is
   `~/.jarvis-realtime/userdata/secrets/jarvis-live-voice-openai-api-key.bin`.
4. **Remove key** clears the stored secret and disables live conversation on that node.

`Live conversation` requires the Full or Controller preset. Headless nodes
answer `capability-unavailable`. Live voice needs no local speech models: the
session handles listening and speaking end to end. In a realtime-only build there
are no hold-to-speak controls, so use live conversation or typing there. `gpt-live-1` is priced per
minute of session duration, billed by the second, and backend provider usage is billed separately.

Required OpenAI project access: GPT-Live in the API, `v1/live/sessions`, WebRTC transport. Tier 1
allows 25 concurrent sessions.

## Manual acceptance

Voice tests prove protocol wiring and transcript handling. They cannot prove a real microphone,
WebRTC negotiation, audio routing, or the model's delegation behavior. Before calling a release
candidate good, do this by hand on the target desktop:

1. Set the API key on the node.
2. Open the control center and press **Live conversation**. Expect the button to move through
   `Connecting…` to `End conversation`, and the browser to prompt for microphone permission once.
3. With the key saved, tap `Ctrl+Shift+J` (`Command+Shift+J` on macOS). Expect the tray item to read **Start live conversation**
   and the tap to start a session; tap again to end it.
4. On Linux, the first use of the global shortcut may show a desktop-portal approval dialog for the
   app; approve it once.
5. Say a conversational sentence ("what do you think about this approach"). Expect a spoken reply
   without a task being created.
6. Say a command ("start a task to fix the failing tests" or "what's the status"). Expect the model
   to acknowledge, then hear the Director's grounded acknowledgement or clarification, not an
   invented target.
7. Interrupt mid-reply. Expect speech to stop and the model to yield.
8. Let the task finish. Expect the completion or failure presentation to be spoken without a second
   report voice.
9. Press **End conversation** or tap the shortcut. Expect the microphone indicator to clear; the OS
   no longer shows the browser using the microphone. Confirm the session id reports usage on the
   OpenAI dashboard.

Data-channel events can be observed in the browser devtools WebRTC internals or by temporary
`console.debug` in `JarvisLiveVoice.logic.ts`.

## Troubleshooting

- **"Add an OpenAI API key on this node to use live voice."** The node settings have no key. Save one
  through **Live conversation** and retry.
- **"Live voice is unavailable on this Jarvis node."** The node preset is Headless, or the node was
  built before this feature. Check the node's preset.
- **"The GPT-Live session could not be created."** The upstream request failed. Check key validity,
  project access to GPT-Live, outbound HTTPS from the node, and the OpenAI status page. Server logs
  carry the cause with the key redacted; client errors never include the key or response body.
- **Microphone stays off / no reply audio.** WebRTC needs a secure context (`https` or `localhost`)
  and microphone permission. Autoplay policies can require one click on the page after the session
  starts.
- **The live voice repeats itself or a report is stale.** Check whether the presentation arrived for
  the session's origin. Reports are live-only; a reconnect does not replay them, and the durable task
  remains the source of truth.

## Cost and failure behavior

- A WebRTC session creation bills 15 seconds of voice duration during initialization, credited
  against the running session. Ending the session cleanly (`session.close` then `session.closed`)
  finalizes usage. A dropped connection leaves final usage unconfirmed.
- The client ends a session after 60 seconds without user speech and after 10 minutes at most, and
  releases the microphone immediately on stop. The timers are client-side: a killed renderer or a
  sleeping machine can leave a session billing until the provider expires it, because there is no
  verified Live REST hangup endpoint to call from the node.
- If the data channel closes unexpectedly, the renderer reports the failure and stops
  automatically. Pressing **Live conversation** starts a fresh session; work already accepted by the
  Director continues on the node.
