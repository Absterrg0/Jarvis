# ARIS on mobile

The ARIS mobile app opens directly into ARIS. It can browse paired nodes and projects, open recent work, and send ARIS text commands. It does not host projects or run coding providers.

Pair the phone with each ARIS environment through the existing T3 connection flow. Tailnet connections use the same authenticated RPC channel as the rest of the mobile app.

Use **Assistant** to direct work and **Tasks** to browse the workspace. Tap **Working in** to select a project and its computer. Current work stays above the collapsed recent-work list.

After pairing, open the app and:

1. Type a command. Text always works.
2. Open a task under **Recent work** to answer its approvals or questions with the ordinary thread controls.
3. Name a project in your command when you want work somewhere specific; otherwise ARIS routes to the focused or recent project automatically. Opening **Focus** on a task makes its project the ambient context for follow-ups like "continue fixing it". The route screen shows each node as loading, ready, or unavailable with its recovery action, and an unavailable node never receives the turn.
4. Inspect the selected project before sending. Each turn pins its project, task context, and pending-request identity when sending begins, and retries reuse the same request identity.

Each submitted turn keeps the project selected when sending began. You can browse another Task Desk or select another project after the command is accepted; the earlier task still executes. The lane shows the accepted acknowledgement or the next question. There is no filler while the turn waits. To stop running provider work, send `stop` for that task.

A fresh text turn is interpreted once before routing: the semantic pass marks which phrases name destinations, tasks, exclusions, or corrections, and only a validated destination ("In Rivvl, …" or "… in Rivvl") routes to the owning node; the wording itself is never rewritten. A ruled-out project ("but not in X") is never selected, and a bare mention inside the work stays a mention. A name on more than one node parks node-qualified choices instead of guessing. A destination on a disconnected node reports unavailable with no fallback to the current project. A pinned follow-up to an active task keeps its task even when the wording names another project, and clarification answers and retries never re-route.

Known semantic boundaries: a correction that denies a project without settling on one asks which project should receive the task. Joining two independent commands in one turn is unsupported and nothing dispatches. An open-ended or ambiguous request makes no claim: ARIS asks instead of guessing.

The app remembers the last valid project. On a fresh install it follows the focused or most recent
ARIS task, or selects the project automatically when only one is available. An explicitly named target that is missing stays
unavailable instead of falling back; multiple ambiguous choices still require confirmation
so ARIS cannot send work to the wrong machine.

General questions need no project. "What is new today?" is answered directly on any online node, even on a fresh install with no projects yet, and creates no task. Coding commands still route to a node-qualified project as above.

While work runs, the route screen shows progress and the full result text. There is no waiting filler while a turn is being interpreted or dispatched.

A submission on the wire can still be cancelled before acceptance by its exact request identity (`requestId` plus node and origin interaction). `Cancelled` means nothing dispatched, and a retry after a recorded cancel stays cancelled instead of running again. `Already-accepted` means the dispatch succeeded; the returned task identity is pinned and the work keeps running with `That request already started and keeps running.` A cancel that lands mid-commit waits for the dispatch receipt and reports `unknown` when the commit fails. `Unknown` keeps waiting for the receipt. A correction typed while the previous request still submits cancels that in-flight request first. Cancel never stops provider work after acceptance.

Server-owned project and task questions pin their node, origin turn, exact `clarificationFrameId`, and `expectedReply` pin. The next instruction answers that pinned frame on its original node only when the live frame still matches; a missing or replaced frame rejects without acting, and a rejected repeat keeps its frame guard. A stale exact frame may retire locally without claiming a cancel happened, with no automatic unguarded retry. Retained focus is tri-state: unset restores once from the server durable focus on the same node and project, while an explicit project-only selection stays put and is never overridden by a later desk read. Switching project or task first cancels the waiting frame by exact ID; if the cancel cannot be verified, mobile keeps the frame and asks you to answer it instead of letting the next command be consumed unnoticed. Typed provider, model, and effort answers resend the original utterance with its resolved selection under the same request identity.

Push notifications name the outcome only ("Task completed", "Input needed"). They never include thread or project titles. An accepted Expo ticket means the push service accepted the notification, not that the phone delivered it. Only a structured `DeviceNotRegistered` response removes that device registration, and a same-token renewal in flight survives a stale failure.

Leaving ARIS never cancels an already submitted coding task: it continues on its execution node. Return to ARIS or open the normal thread screen to inspect durable task state.
