// Minimal codex app-server stand-in for runtime-level collab tests.
// Speaks just enough of the protocol for CodexSessionRuntime to start a
// session, using REAL captured responses (codexMultiAgentWire.json), then
// replays a scripted multi-agent notification sequence read from the
// T3_CODEX_COLLAB_SCRIPT env var (a JSON file path) whenever a turn starts.
// Runs as a plain Node process — stdlib only.
import * as NodeFS from "node:fs";
import * as NodeReadline from "node:readline";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const args = process.argv.slice(2);

if (args[0] === "exec") {
  const outputFlag = args.indexOf("--output-last-message");
  const outputPath = outputFlag < 0 ? undefined : args[outputFlag + 1];
  if (outputPath === undefined) throw new Error("Missing --output-last-message path.");
  let prompt = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) prompt += chunk;
  const request = /^Request: (.*)$/mu.exec(prompt)?.[1]?.trim() ?? "";
  const continuing = /^Continue selected conversation: true$/mu.test(prompt);
  NodeFS.writeFileSync(
    outputPath,
    JSON.stringify({
      action: continuing ? "continue" : "start",
      project: null,
      task: null,
      instruction: request,
      provider: continuing ? null : "Codex",
      model: null,
      effort: null,
    }),
  );
  process.exit(0);
}

const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  NodeFS.readFileSync(NodePath.join(here, "codexMultiAgentWire.json"), "utf8"),
);
const script = JSON.parse(NodeFS.readFileSync(process.env.T3_CODEX_COLLAB_SCRIPT, "utf8"));

const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
let turnStartCount = 0;
let activeTurn;

const nextTurnStartIndex = () => {
  if (script.persistTurnStartCount !== true) {
    const index = turnStartCount;
    turnStartCount += 1;
    return index;
  }
  const countPath = `${process.env.T3_CODEX_COLLAB_SCRIPT}.turn-count`;
  const index = NodeFS.existsSync(countPath)
    ? Number.parseInt(NodeFS.readFileSync(countPath, "utf8"), 10) || 0
    : 0;
  NodeFS.writeFileSync(countPath, `${index + 1}\n`);
  turnStartCount = index + 1;
  return index;
};

const rl = NodeReadline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method } = message;
  if (method === undefined && script.serverRequests?.some((request) => request.id === id)) {
    NodeFS.appendFileSync(
      `${process.env.T3_CODEX_COLLAB_SCRIPT}.responses`,
      `${JSON.stringify({ id, result: message.result, error: message.error })}\n`,
    );
    if (script.completeTurnOnServerResponse && activeTurn) {
      write({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: {
          threadId: script.rootThreadId,
          turn: { ...activeTurn, status: "completed" },
        },
      });
    }
    return;
  }
  if (method === "initialize") {
    write({
      id,
      result: {
        userAgent: "t3-collab-mock/0.0.0",
        codexHome: "/tmp",
        platformFamily: "unix",
        platformOs: "linux",
      },
    });
    return;
  }
  if (method === "account/read") {
    write({ id, result: { account: { type: "apiKey" }, requiresOpenaiAuth: false } });
    return;
  }
  if (method === "skills/list" || method === "model/list") {
    write({ id, result: { data: [] } });
    return;
  }
  if (method === "thread/start") {
    write({ id, result: fixture.responses.threadStart });
    return;
  }
  if (method === "thread/resume") {
    if (script.recordRequests) {
      NodeFS.appendFileSync(
        `${process.env.T3_CODEX_COLLAB_SCRIPT}.requests`,
        `${JSON.stringify({ method, params: message.params })}\n`,
      );
    }
    const threadId = message.params?.threadId;
    const childSnapshot = script.childResumeSnapshots?.[threadId];
    if (script.resumeRequestMarker) {
      write({
        jsonrpc: "2.0",
        method: "serverRequest/resolved",
        params: {
          threadId: script.rootThreadId,
          requestId: script.resumeRequestMarker,
        },
      });
    }
    if (childSnapshot?.hang) {
      return;
    }
    if (childSnapshot?.error) {
      write({ id, error: { code: -32000, message: childSnapshot.error } });
      return;
    }
    if (childSnapshot) {
      write({
        id,
        result: {
          ...fixture.responses.threadStart,
          model: childSnapshot.model,
          reasoningEffort: childSnapshot.reasoningEffort,
          thread: {
            ...fixture.responses.threadStart.thread,
            id: threadId,
            sessionId: threadId,
          },
        },
      });
      for (const notification of childSnapshot.notifications ?? []) {
        write({ jsonrpc: "2.0", method: notification.method, params: notification.params });
      }
      return;
    }

    write({ id, result: fixture.responses.threadStart });
    return;
  }
  if (method === "thread/resume") {
    const requestedThreadId = message.params?.threadId;
    const expectedThreadId =
      script.resumeThreadId ?? script.rootThreadId ?? fixture.responses.threadStart.thread.id;
    if (requestedThreadId !== expectedThreadId) {
      write({
        id,
        error: {
          code: -32602,
          message: `Cannot resume thread ${String(requestedThreadId)}; expected ${expectedThreadId}`,
        },
      });
      return;
    }
    write({
      id,
      result: {
        ...fixture.responses.threadStart,
        thread: { ...fixture.responses.threadStart.thread, id: requestedThreadId },
      },
    });
    return;
  }
  if (method === "turn/start") {
    const turnStartIndex = nextTurnStartIndex();
    const turnId = script.turnIds?.[turnStartIndex];
    const turn = turnId
      ? { ...fixture.responses.turnStart.turn, id: turnId }
      : fixture.responses.turnStart.turn;
    activeTurn = turn;
    turnStartCount += 1;
    write({ id, result: { ...fixture.responses.turnStart, turn } });
    const rootThreadId = script.rootThreadId;
    if (script.onlyFirstTurnStarts !== true || turnStartCount === 1) {
      write({
        jsonrpc: "2.0",
        method: "turn/started",
        params: { threadId: rootThreadId, turn },
      });
    }
    if (script.writeFileOnTurn?.turnIndex === turnStartIndex) {
      const relativePath = script.writeFileOnTurn.path;
      if (typeof relativePath !== "string" || relativePath.length === 0) {
        throw new Error("writeFileOnTurn.path must be a non-empty relative path");
      }
      const target = NodePath.resolve(process.cwd(), relativePath);
      const projectRoot = NodePath.resolve(process.cwd());
      if (target !== projectRoot && !target.startsWith(`${projectRoot}${NodePath.sep}`)) {
        throw new Error("writeFileOnTurn.path must stay inside the provider workspace");
      }
      NodeFS.writeFileSync(target, String(script.writeFileOnTurn.contents ?? ""));
    }
    for (const notification of script.notifications) {
      write({ jsonrpc: "2.0", method: notification.method, params: notification.params });
    }
    if (script.resultText) {
      const itemId = `mock-agent-message-${turn.id}`;
      write({
        jsonrpc: "2.0",
        method: "item/agentMessage/delta",
        params: {
          delta: script.resultText,
          itemId,
          threadId: rootThreadId,
          turnId: turn.id,
        },
      });
      write({
        jsonrpc: "2.0",
        method: "item/completed",
        params: {
          completedAtMs: Date.now(),
          item: {
            id: itemId,
            phase: "final_answer",
            text: script.resultText,
            type: "agentMessage",
          },
          threadId: rootThreadId,
          turnId: turn.id,
        },
      });
    }
    for (const request of script.serverRequests ?? []) {
      write({ jsonrpc: "2.0", id: request.id, method: request.method, params: request.params });
    }
    if (script.holdTurnOpen !== true) {
      write({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: {
          threadId: rootThreadId,
          turn: { ...turn, status: "completed" },
        },
      });
    }
    return;
  }
  if (method === "turn/interrupt") {
    // Record which thread/turn was interrupted (append-only sidecar file the
    // test reads) so Stop coverage can assert every live child was reached.
    // failInterruptFor simulates a dead child whose interrupt errors.
    const target = message.params?.threadId;
    NodeFS.appendFileSync(
      `${process.env.T3_CODEX_COLLAB_SCRIPT}.interrupts`,
      `${JSON.stringify({ threadId: target, turnId: message.params?.turnId })}\n`,
    );
    if (
      script.expectedActiveTurnId &&
      message.params?.threadId === script.rootThreadId &&
      message.params?.turnId !== script.expectedActiveTurnId
    ) {
      write({
        id,
        error: {
          code: -32000,
          message: `expected active turn id ${message.params?.turnId} but found ${script.expectedActiveTurnId}`,
        },
      });
      return;
    }
    if (script.failInterruptFor && script.failInterruptFor === target) {
      write({ id, error: { code: -32000, message: "thread already closed" } });
      return;
    }
    if (script.hangInterruptFor && script.hangInterruptFor === target) {
      // Never respond: simulates a wedged child whose RPC neither resolves
      // nor rejects. The runtime's bounded deadline must move on.
      return;
    }
    write({ id, result: {} });
    return;
  }
  if (id !== undefined) {
    write({ id, result: {} });
  }
});
