# Circe acceptance checklist

Use this checklist against two T3 machines and one control client (web or desktop). Call the machines **A**
and **B**, and use the same project title on both so node qualification is exercised. Items marked
**manual** are acceptance actions that require a surface not covered by an automated test; items
marked **planned** are not release claims.

## 0.0.34 release focus

- [ ] Confirm a successful provider result is reported immediately, with checkpoint change counts added when available; a checkpoint capture failure is shown only as a non-blocking diagnostic.
- [ ] Restart the Host during completion reconciliation and confirm startup repair is idempotent: the same finalized result produces one completion report, not duplicates.

## Multi-node MVP: exact two-machine pass

Set up the following before starting. Keep the repositories separate and do not copy provider credentials between machines.

- Machine **A** runs T3 with a ready provider and a project titled **Rivvl**.
- Machine **B** runs T3 with a separate project also titled **Rivvl**. Configure the provider differently (for the missing-provider check below, leave it disabled, unauthenticated, or not installed on B).
- On a web or desktop control client, add both environments from **Settings → Connections → Add environment** using each machine's complete pairing link. Record the two stable environment IDs and labels.

Run the directional checks once with the control client targeting B from A, and again with the same control client targeting A from B. The result must always be owned by the target machine, not by the machine holding the dialog open.

### Pair, label, remove, and reconnect

- [ ] Pair A and B. The connection directory shows two node entries with distinct stable IDs and their labels; the same project title is not collapsed into one entry.
- [ ] Pair A a second time with a fresh link. Confirm it updates the existing A entry rather than adding a duplicate node or duplicate project group.
- [ ] **Manual:** If the build exposes **Rename node**, rename A to **Desk** and B to **Laptop**. Confirm labels change only in the local directory and project/task identity and routing remain unchanged. If no rename action is exposed, record that as a surface mismatch; do not call a changed descriptor or a second pairing a rename.
- [ ] Remove B from the control client's saved environment list. Confirm B disappears from the local catalog and local cache while B's T3 workspace and state remain intact.
- [ ] Pair B again with a fresh link. Confirm it returns under the same B environment ID and reconnects without creating a second B entry.
- [ ] Disconnect the network path to B (or stop only B's T3 server) while A remains available. A marks B offline/reconnecting and does not route B work to A. Restore the path and use **Retry/Connect**; B returns without re-pairing.

### Grouping, duplicate names, and provider availability

- [ ] Refresh the Circe catalog. Projects, providers, and task history are grouped under their node labels; each entry retains a node-qualified reference.
- [ ] Ask for **Rivvl** with both nodes online. Circe presents exactly two choices, **Rivvl — Desk** and **Rivvl — Laptop** (or the recorded labels), and waits for an explicit choice. It does not choose the first row, the last visible project, or catalog order.
- [ ] Choose A's Rivvl and start a task. Verify the thread, provider process, workspace, and checkpoint are on A. Choose B's Rivvl and repeat; verify the same facts on B.
- [ ] Disable, uninstall, or remove authentication for the chosen provider on B while leaving it ready on A. Confirm A's provider is shown as available and B's as unavailable; choosing B returns a provider-unavailable/selection clarification and never falls back to A's provider.

### Continuation, origin briefing, and live delivery

- [ ] From A's control client, start a task explicitly targeted at B's Rivvl. Confirm the response carries B's execution-node task reference and the task appears in B's task desk.
- [ ] From A, continue that task after it asks a question or finishes a turn. Confirm the continuation is sent to B's exact thread/provider conversation even if A's visible project is selected. Disconnect B and verify the continuation fails as “B unavailable” rather than creating work on A; reconnect B and retry the same node-qualified task.
- [ ] Start a B task from A's interaction, then disconnect A's presentation client before B emits the final result. Reconnect A without re-pairing. Confirm no stale completion is spoken late, the exact origin interaction receives only live events while connected, and the full result remains in B's T3 thread and task desk.
- [ ] Resolve the question or approval from either authorized client. Confirm the matching pending report stops being presented live and is not spoken again after restart. A reconnecting client inspects current durable task state instead of replaying speech.
- [ ] Repeat the full start/continue/report pass in the reverse direction (the same control client targeting A). Confirm the node, origin interaction, live presentation, and provider availability all reverse with the target.

### Scope guardrails

- [ ] Confirm the pass uses explicit pairing links only. There is no central node-discovery list.
- [ ] Confirm mobile joins the same multi-node mesh with real text and voice turns through its paired-environment registry; it never becomes an execution node.
- [ ] Confirm no repository sync or workspace copy occurs. A task's files and checkpoints remain on its execution node.

## Install and updates

- [ ] For a future stable release, install the signed `Circe-Setup.exe` once. For an unsigned
      preview, record that it is explicitly a preview/manual-verification build instead of treating
      it as a stable signed release. In **Installed Apps**, confirm there is exactly one **Circe**
      product, one launcher identity (`Circe.lnk` on the Desktop and in the Start Menu `Circe`
      folder, targeting the preserved `desktop\Circe.exe`), and one uninstall entry; no separate Circe Desktop or runtime
      app appears. Confirm legacy `Circe.lnk` shortcuts are gone after install.
- [ ] Select **Full**, **Controller**, and **Headless** on separate clean machines and confirm
      Full owns the desktop workspace and execution; Controller is the lightweight
      controller surface that opens a paired Host workspace; Headless is runtime-only and
      has no voice capability.
- [ ] Open Circe onboarding and confirm exactly three steps: **Device**, **Essentials**, and
      **Ready**. Change the device name and use **Continue** once; confirm it saves without a
      separate Save action or a stuck loading state.
- [ ] In **Essentials**, confirm authenticated connection health is separate from route metadata:
      Local, Tailscale, SSH, and Relay describe the route only. A paired Controller shows the online
      execution node's provider/project resources and route rather than an empty local catalog.
- [ ] Confirm the node's helpers pair, restart, and reconnect under the
      owning Circe installation without adding another launcher, setup flow, or uninstall entry.
- [ ] Update Circe Full manually: rerun the newer Windows Setup, replace the Linux Full AppImage,
      or install the newer macOS DMG. Full does not consume its own updater metadata or ZIP payloads.
- [ ] Quit and relaunch; pairing, provider default, and project default remain intact.

## Pairing and connectivity

- [ ] Pair with the complete HTTPS Tailscale link, including its token.
- [ ] Restart both machines and confirm the control client reconnects without re-pairing.
- [ ] Disconnect Tailscale: the control client explains that the host is unavailable and does not lose the transcript.
- [ ] Expire or revoke the session: setup exposes the pairing field and requests a fresh link.
- [ ] Confirm only the client that owns the live conversation speaks a report when another UI is also open.

## Live conversation

Live conversation is the only voice path. CI and package smoke tests cannot prove physical microphone, permission, or device-routing behavior, so the following checks are real-device checks. No physical checks were run in this pass. See the live conversation runbook for setup.

- [ ] **Manual:** save a live-conversation key on the node, press **Live conversation**, and confirm the button moves through `Connecting…` to `End conversation` with one microphone prompt.
- [ ] **Manual:** tap `Ctrl+Shift+J` (`Command+Shift+J` on macOS) to start and end the session; confirm the tray reads **Start** or **End live conversation** with the live status.
- [ ] **Manual:** revoke microphone access in System Settings and confirm the session reports a bounded permission error and recovers after access is restored.
- [ ] Speak a multi-sentence instruction and confirm the delegated request runs to completion.
- [ ] Say `Rivvl`, `GitHub`, and every current project title; confirm the delegated transcript uses canonical spelling.
- [ ] Interrupt mid-reply and confirm speech stops and the model yields.

## Provider and project routing

- [ ] Save a provider, model, and effort once; ordinary tasks do not ask again.
- [ ] Ask "What projects are there?"; Circe lists the typed T3 project catalog without starting Codex.
- [ ] Start a task with "in Rivvl"; confirm the created thread belongs to Rivvl even when another project is open in T3.
- [ ] Use a phonetic mishearing such as "ripple" when Rivvl is the only clear match; confirm it asks before routing.
- [ ] Create an ambiguous project name; confirm Circe asks a short question and accepts "the second one."
- [ ] Name an unknown project; confirm Circe never silently falls back to the previous project.

## Conversation control

- [ ] Start a new task and verify the returned thread becomes the exact attention target.
- [ ] Send "actually, use SQLite instead" while it runs; confirm the same thread receives the steering turn.
- [ ] Send "after that, update the docs"; confirm it queues and runs after the active turn settles.
- [ ] Ask for status; confirm running, waiting for input, waiting for approval, failed, interrupted, and ready states are distinguished.
- [ ] Send "stop that task"; confirm only an explicitly running target is interrupted.
- [ ] Send "stop that task"; then start a new task with an explicit provider and confirm the two tasks remain separate.
- [ ] Start another conversation, then use back, forward, and named-task switching. Confirm each resolves against the durable bounded recent-task catalog and persisted desk focus instead of one last-task pointer.
- [ ] Restart with a pending project or task clarification frame. Confirm the frame survives the restart in the persisted desk, resolves only against its original candidate IDs, and a replaced or missing frame rejects the late answer without acting.

## Approvals and blocked work

- [ ] Trigger file read, file change, tests, build, dependency install, Git push, database migration, network, elevated, and destructive commands.
- [ ] Confirm each known operation is explained in ordinary English with project context and an honest risk label.
- [ ] For a compound `sed` plus `find` inspection, confirm Circe says which files will be read and that directories will be listed.
- [ ] Confirm the exact raw command remains visible but is not read aloud.
- [ ] Send an explicit "allow" and "deny"; verify each maps to the pending approval through the deterministic prepass, and a question or ambiguous reply keeps it pending. Input `expectedReply` is tri-state value, null (explicit nothing waiting), or absent (legacy with no pin); a new `needs-input` output pin is non-null optional (present value or absent, never null). Task views carry node-qualified thread, task, and project refs with pending null when none and absent only on legacy payloads. A focused ack carries optional exact `taskRef`; when absent, clear the thread instead of choosing from the desk.
- [ ] Ask “what does that do?”; confirm it does not accidentally approve the request.
- [ ] For a genuinely unknown tool, confirm Circe requests on-screen review instead of inventing an explanation.

## Reports and speech

- [ ] Complete a coding task with a long Markdown response; the live session speaks the outcome and verification, not paths, code blocks, hashes, or a file changelog.
- [ ] Confirm generic boilerplate such as "Done" or "Completed" is omitted.
- [ ] Trigger a question, approval, failure, and blocker; each report is actionable and names the correct project/task.
- [ ] Complete a task while checkpoint capture fails. Confirm the checkpoint issue is a non-blocking
      warning and the later successful task result remains the completed result.
- [ ] Generate multiple reports quickly; confirm the bounded FIFO speech queue keeps arrival order with dedupe by presentation ID (one in-flight plus waiting, default cap 8, oldest dropped first). Stale reports give way; the durable task keeps the result.
- [ ] While a report is speaking, end the conversation; speech stops immediately and the report is not replayed.
- [ ] **Planned:** optional constrained language rewriting may improve tone, but it cannot authorize, select IDs, or dispatch work.

## Partial outage, stale replies, cancel, installer, and push

No physical checks were run for this pass. Keep the manual microphone and permission
items above unchecked. The scenarios below are explicit
manual checks for the current worktree behavior.

- [ ] **Manual partial outage:** with two nodes paired, make one catalog unreadable while it still looks connected. Confirm that node reads loading, ready, or unavailable with its recovery action, name resolution stays partial, and an explicit target on the unavailable node reports unavailable instead of routing elsewhere.
- [ ] **Manual stale reply:** open a task with a waiting approval or question, let a second request open or the first close, then answer the old pin from Control Center composer or mobile with its `expectedReply` and `clarificationFrameId`. Confirm the answer is rejected as stale with the current state named, the live request is untouched, and explicit stop, status, or queue text is never captured as an answer. A bare allow or deny answers only through the deterministic prepass without a supervisor call.
- [ ] **Manual cancel:** pause on a server-owned project or task question, then send **cancel** with the echoed `clarificationFrameId`. Confirm a missing or replaced frame rejects without cancelling, answering, or dispatching; there is no read-then-cancel window and no automatic unguarded retry. An exact stale frame may retire locally with “no longer open; nothing cancelled”. A verified cancel clears only its exact frame, and a rejected repeat retains its frame guard.
- [ ] **Manual installer failure:** interrupt the Headless install or update mid-write. Confirm rollback restores only mutations owned by that attempt, untouched originals are never removed, backups are retained on restore failure, a partial tree never starts, and user data under `userdata` survives.
- [ ] **Manual push rotation:** renew a push registration for the same token, device, and session, then deliver a stale `DeviceNotRegistered` failure for the older version. Confirm the renewal survives, expired or revoked rows never send without being deleted by the send path, and only the exact structured `DeviceNotRegistered` version is removed. Confirm an accepted Expo ticket is treated as acceptance, not delivery.

## Performance and safety

- [ ] An idle voice client uses no microphone, continuous animation loop, or
      polling worker. A live session holds the microphone only while active.
- [ ] Confirm the voice shader/presence animation runs only for active live, working, or speaking states, stops when idle or hidden, and is disabled with
      `prefers-reduced-motion`.
- [ ] Ending the session releases microphone resources immediately.
- [ ] Report relay mounts only the report surface, never the full T3 UI.
- [ ] The WebSocket contract decodes qualified control references and acknowledgements.
- [ ] Local network, Tailscale IP, and Tailscale HTTPS modes route to one running host process and one state database.
