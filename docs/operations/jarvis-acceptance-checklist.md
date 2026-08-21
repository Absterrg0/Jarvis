# Jarvis acceptance checklist

Use this checklist against a laptop host and one Windows Companion. Items marked **planned** describe the next intelligence-layer slices and are not release claims.

## Install and updates

- [ ] Install the Windows Companion once from the signed installer.
- [ ] Confirm the tray shows the installed version.
- [ ] Use **Check for updates** and confirm a newer build downloads in the background.
- [ ] Confirm **Restart to install update** replaces the app without downloading a ZIP manually.
- [ ] Quit and relaunch; pairing, provider default, project default, and voice vocabulary remain intact.

## Pairing and connectivity

- [ ] Pair with the complete HTTPS Tailscale link, including its token.
- [ ] Restart both machines and confirm the Companion reconnects without re-pairing.
- [ ] Disconnect Tailscale: the Companion explains that the host is unavailable and does not lose the transcript.
- [ ] Expire or revoke the session: setup exposes the pairing field and requests a fresh link.
- [ ] Confirm only the elected Companion speaks a report when the laptop UI is also open.

## Voice capture and transcription

- [ ] Hold `Ctrl+Shift+J`, begin speaking immediately, and confirm the first word is retained.
- [ ] Speak for more than one Whisper VAD segment; release the keys and confirm the complete instruction appears.
- [ ] Hold the shortcut for an extended instruction; recording continues until release.
- [ ] Release without speech; the Companion asks for another try instead of dispatching an empty task.
- [ ] Say `Rivvl`, `GitHub`, and every current project title; confirm the review transcript uses canonical spelling.
- [ ] Cancel or correct the transcript before dispatch.
- [ ] Confirm the voice strip dismisses after success, failure, or inactivity.

## Provider and project routing

- [ ] Save a provider, model, and effort once; ordinary hotkey tasks do not ask again.
- [ ] Say “What projects are there?”; Jarvis lists the typed T3 project catalog without starting Codex.
- [ ] Start a task with “in Rivvl”; confirm the created thread belongs to Rivvl even when another project is open in T3.
- [ ] Use a phonetic misrecognition such as “ripple” when Rivvl is the only clear match; confirm it resolves to Rivvl.
- [ ] Create an ambiguous project name; confirm Jarvis asks a short question and accepts “the second one.”
- [ ] Name an unknown project; confirm Jarvis never silently falls back to the previous project.

## Conversation control

- [ ] Start a new task and verify the returned thread becomes the exact attention target.
- [ ] Say “actually, use SQLite instead” while it runs; confirm the same thread receives the steering turn.
- [ ] Say “after that, update the docs”; confirm it queues and runs after the active turn settles.
- [ ] Ask for status; confirm running, waiting for input, waiting for approval, failed, interrupted, and ready states are distinguished.
- [ ] Say “stop that task”; confirm only an explicitly running target is interrupted.
- [ ] Say “do that last run in Rivvl”; confirm the replacement is created safely and linked to the source task.
- [ ] Restart Companion and confirm the last exact attention target remains available.
- [ ] **Planned:** “start another conversation,” back, forward, and named-task switching use a durable task desk rather than one last-task pointer.
- [ ] **Planned:** pending clarification frames survive restart and resolve only against their original candidate IDs.

## Approvals and blocked work

- [ ] Trigger file read, file change, tests, build, dependency install, Git push, database migration, network, elevated, and destructive commands.
- [ ] Confirm each known operation is explained in ordinary English with project context and an honest risk label.
- [ ] For a compound `sed` plus `find` inspection, confirm Jarvis says which files will be read and that directories will be listed.
- [ ] Confirm the exact raw command remains visible but is not read aloud.
- [ ] Say an explicit “allow” and “deny”; verify each maps to the pending approval.
- [ ] Ask “what does that do?”; confirm it does not accidentally approve the request.
- [ ] For a genuinely unknown tool, confirm Jarvis requests on-screen review instead of inventing an explanation.

## Reports and JARVIS-style speech

- [ ] Complete a coding task with a long Markdown response; Companion speaks the outcome and verification, not paths, code blocks, hashes, or a file changelog.
- [ ] Confirm generic boilerplate such as “Done” or “Completed” is omitted.
- [ ] Confirm the overlay may show more detail than Piper speaks.
- [ ] Trigger a question, approval, failure, and blocker; each report is actionable and names the correct project/task.
- [ ] Generate multiple reports quickly; only the current speech plus the latest pending report is retained.
- [ ] Confirm speech can finish naturally without the former five-second cutoff.
- [ ] While a report is speaking, choose **Stop speaking** or hold the shortcut; speech stops immediately and the report is not replayed.
- [ ] **Planned:** optional constrained language rewriting may improve tone, but it cannot authorize, select IDs, or dispatch work.

## Performance and safety

- [ ] Idle Companion uses no microphone, local model, animation loop, or polling worker beyond the bounded update check.
- [ ] Capture starts only while the shortcut is held and releases microphone/process resources afterward.
- [ ] Report relay mounts only the report surface, never the full T3 UI.
- [ ] HTTP and WebSocket contracts decode the same control references and acknowledgements.
- [ ] Local network, Tailscale IP, and Tailscale HTTPS modes route to one running host process and one state database.
