# ARIS on mobile

The ARIS mobile app opens directly into ARIS. It can browse paired nodes and projects, open recent work, send ARIS commands, and use foreground push-to-talk. It does not host projects, run coding providers, or load speech models.

Pair the phone with each ARIS environment through the existing T3 connection flow. Tailnet connections use the same authenticated RPC channel as the rest of the mobile app; ARIS does not expose a separate audio endpoint.

Use **Assistant** to direct work and **Tasks** to browse the workspace. Tap **Working in** to select a project and its computer. Current work stays above the collapsed recent-work list.

After pairing, open the app and:

1. Hold the microphone for up to 15 seconds, then release to send, or type a command. Text always works, with or without voice support.
2. Open a task under **Recent work** to answer its approvals or questions with the ordinary thread controls.
3. Name a project in your command when you want work somewhere specific; otherwise ARIS routes to the focused or recent project automatically. Opening **Focus** on a task makes its project the ambient context for follow-ups like "continue fixing it". The route screen shows each node as loading, ready, or unavailable with its recovery action, and an unavailable node never receives the turn.
4. Inspect the selected project and voice node before sending. Each turn pins its project, task context, and pending-request identity when recording begins, and retries reuse the same request identity.

Each submitted voice turn keeps the project and voice node selected when recording began. You can browse another Task Desk or select another project after the command is accepted; the earlier task still executes and speaks through its original voice node. The lane shows `Heard: "..."` (truncated past 120 characters) at capture, then `Heard: "..." Interpreting…` during routing. Both stay silent as text until the accepted acknowledgement or the next question arrives. There is no filler speech while the turn waits for the Host. A haptic tick is the only immediate cue; the Host-owned acknowledgement speaks after a `started` result. Spoken responses stream into the phone’s native audio player one at a time. **Preparing speech** changes to playback when the first audio arrives; **Stop speaking** cancels playback and generation, not provider work. To stop running provider work, say `stop` for that task.

A fresh text or voice turn is interpreted once before routing: the semantic pass marks which phrases name destinations, tasks, exclusions, or corrections, and only a validated destination (“In Rivvl, …” or “… in Rivvl”) routes to the owning node; the wording itself is never rewritten. A ruled-out project (“but not in X”) is never selected, and a bare mention inside the work stays a mention. A name heard on more than one node parks node-qualified choices instead of guessing. A destination on a disconnected node reports unavailable with no fallback to the current project. A pinned follow-up to an active task keeps its task even when the wording names another project, and clarification answers and retries never re-route. Recognition is not always correct: uncertain matches ask before anything runs.

Known semantic boundaries: a correction that denies a project without settling on one asks which project should receive the task. Joining two independent commands in one turn is unsupported and nothing dispatches. An open-ended or ambiguous request makes no claim: ARIS asks instead of guessing.

The app remembers the last valid project. On a fresh install it follows the focused or most recent
ARIS task, or selects the project automatically when only one is available. A sole online
voice-capable node is selected automatically. An explicitly named target that is missing stays
unavailable instead of falling back; multiple ambiguous choices still require confirmation
so ARIS cannot send work or audio to the wrong machine.

## Voice input and speech output

Voice input has an explicit backend choice. Remote is the default. Remote uploads to the selected voice node. On-device keeps audio on the phone. The choice never flips on its own because a node appeared or a pack is missing.

Speech output always needs an explicitly selected online voice node, even when input runs on-device. On-device input with no voice node can fill the draft for edit and resend, but it cannot speak. The project may execute on a different node. If the preferred voice node disconnects, mobile reports that state and offers online voice-capable nodes, but never changes the choice automatically.

Prerequisites: grant microphone permission, keep the device locale supported, and install the on-device pack for that locale where the platform asks for one. Remote input and all speech output also need one online voice-compute node. Without it the voice action reports no voice node and stays idle.

Platform behavior differs today, and neither on-device path is proven on hardware in this tree. iOS records a file and transcribes it through the Apple transcription path, which needs a supported device with iOS 26 or later. Android runs a live on-device session and has no file transcription path. Static tests cover wiring with the native module mocked. They do not prove permission flow, pack download, locale support, accuracy, or playback on a phone. Plan a real-device pass before relying on either path.

A submission on the wire can still be cancelled before acceptance by its exact request identity (`requestId` plus node and origin interaction). `Cancelled` means nothing dispatched, and a retry after a recorded cancel stays cancelled instead of running again. `Already-accepted` means the dispatch succeeded; the returned task identity is pinned and the work keeps running with `That request already started and keeps running.` A cancel that lands mid-commit waits for the dispatch receipt and reports `unknown` when the commit fails. `Unknown` keeps waiting for the receipt. A correction typed while the previous request still submits cancels that in-flight request first. Cancel never stops provider work after acceptance.

Server-owned project and task questions pin their node, origin turn, exact `clarificationFrameId`, and `expectedReply` pin. The next instruction answers that pinned frame on its original node only when the live frame still matches; a missing or replaced frame rejects without acting, and a rejected repeat keeps its frame guard. A stale exact frame may retire locally without claiming a cancel happened, with no automatic unguarded retry. Retained focus is tri-state: unset restores once from the server durable focus on the same node and project, while an explicit project-only selection stays put and is never overridden by a later desk read. Switching project or task first cancels the waiting frame by exact ID; if the cancel cannot be verified, mobile keeps the frame and asks you to answer it instead of letting the next command be consumed unnoticed. Typed provider, model, and effort answers resend the original utterance with its resolved selection under the same request identity.

General questions need no project. "What is new today?" is answered directly on any online node, even on a fresh install with no projects yet, and creates no task. Coding commands still route to a node-qualified project as above.

While ARIS speaks, tap **Stop speaking** or send a message to interrupt speech only; provider work continues. Spoken completions are short summaries (roughly two sentences); approvals and questions always speak in full. The full result text stays on screen either way. There is no waiting filler speech while a turn is being interpreted or dispatched.

Push notifications name the outcome only ("Task completed", "Input needed"). They never include thread or project titles. An accepted Expo ticket means the push service accepted the notification, not that the phone delivered it. Only a structured `DeviceNotRegistered` response removes that device registration, and a same-token renewal in flight survives a stale failure.

Backgrounding the app or leaving ARIS while recording discards that capture. Cancelling during preparing, recording, or transcribing keeps the transcript above for edit and resend; cancelling from idle or speaking phases stays silent so a stray release cannot rewrite progress. Leaving ARIS also
stops current playback and cancels active transcription or speech generation on the selected voice
node, but an already submitted coding task continues on its execution node. Return to ARIS or
open the normal thread screen to inspect durable task state; missed speech is not replayed.

Mobile voice is foreground push-to-talk only. Wake words, background listening, historical speech replay, and cross-turn phone model retention are not supported. Explicit on-device transcription exists as the local backend choice above, with the hardware limits noted there.
