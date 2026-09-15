import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import {
  CIRCE_FAST_SUPERVISOR_SYSTEM_PROMPT,
  CirceFastSupervisor,
  extractJsonObjectFromText,
  fxAssistantTextFromEnvelope,
  isFxStatusAuthenticated,
  parseFxStatusOutput,
} from "../Services/CirceFastSupervisor.ts";
import { makeCirceFastSupervisorLive } from "./CirceFastSupervisor.ts";

const stubScript = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "status") {
  process.stdout.write("[status] auth=chatgpt\\n[status] model=gpt-5.6-luna\\n");
  process.exit(0);
}
if (args[0] === "ask") {
  process.stdout.write(
    JSON.stringify({
      output: "",
      final_output: JSON.stringify({
        action: "start",
        refs: [],
        model: null,
        effort: null,
        answer: null,
      }),
    }),
  );
  process.exit(0);
}
process.stdout.write("unexpected args: " + args.join(" "));
process.exit(1);
`;

const slowStubScript = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "status") {
  process.stdout.write("[status] auth=chatgpt\\n[status] model=gpt-5.6-luna\\n");
  process.exit(0);
}
setTimeout(() => process.exit(0), 5_000);
`;

const unauthenticatedStubScript = `#!/usr/bin/env node
process.stdout.write("[status] auth=missing\\n[status] model=moonshotai/kimi-k3\\n");
process.exit(0);
`;

const withStub = <A, E>(
  script: string,
  run: (supervisor: CirceFastSupervisor["Service"]) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped();
    const binary = path.join(directory, "fx-stub.mjs");
    yield* fs.writeFileString(binary, script);
    yield* fs.chmod(binary, 0o755);
    const workingDirectory = path.join(directory, "fx-work");
    yield* fs.makeDirectory(workingDirectory, { recursive: true });
    const layer = makeCirceFastSupervisorLive({
      binaryPath: binary,
      homeDirectory: directory,
      workingDirectory,
      statusTimeoutMs: 2_000,
      askTimeoutMs: 1_000,
      cacheTtlMs: 1_000,
    }).pipe(Layer.provide(NodeServices.layer));
    const supervisor = yield* CirceFastSupervisor.pipe(Effect.provide(layer));
    return yield* run(supervisor);
  }).pipe(Effect.provide(NodeServices.layer));

describe("Circe fast supervisor", () => {
  it("parses fx status output", () => {
    const summary = parseFxStatusOutput("[status] model=gpt-5.6-luna\n[status] auth=chatgpt\n");
    expect(summary).toEqual({ auth: "chatgpt", model: "gpt-5.6-luna" });
    expect(isFxStatusAuthenticated(summary)).toBe(true);
    expect(isFxStatusAuthenticated({ auth: "missing", model: "gpt-5.6-luna" })).toBe(false);
    expect(isFxStatusAuthenticated({ auth: null, model: null })).toBe(false);
  });

  it("states the proposal schema in the fx base prompt", () => {
    // fx cannot enforce an output schema, so the shape must be in the prompt.
    expect(CIRCE_FAST_SUPERVISOR_SYSTEM_PROMPT).toContain('"action"');
    expect(CIRCE_FAST_SUPERVISOR_SYSTEM_PROMPT).toContain('"refs"');
    expect(CIRCE_FAST_SUPERVISOR_SYSTEM_PROMPT).toContain(
      '"destination|task|subject|excluded|correction|provider|node"',
    );
  });

  it("reads the assistant text and the first JSON object", () => {
    expect(fxAssistantTextFromEnvelope({ output: "ignored", final_output: "the answer" })).toBe(
      "the answer",
    );
    expect(fxAssistantTextFromEnvelope({ output: "fallback" })).toBe("fallback");
    expect(fxAssistantTextFromEnvelope({ output: "  " })).toBeNull();
    expect(extractJsonObjectFromText('Here it is: {"action":"start","refs":[]} thanks')).toEqual({
      action: "start",
      refs: [],
    });
    expect(extractJsonObjectFromText('{"a":{"b":1},"c":"}"}')).toEqual({ a: { b: 1 }, c: "}" });
    expect(extractJsonObjectFromText("no json here")).toBeNull();
  });

  it.effect("interprets a proposal through an authenticated fx login", () =>
    withStub(stubScript, (supervisor) =>
      Effect.gen(function* () {
        const availability = yield* supervisor.availability;
        expect(availability).toEqual({ available: true, model: "gpt-5.6-luna" });
        const outcome = yield* supervisor.interpret({ prompt: "route this request" });
        expect(outcome).toMatchObject({ status: "proposal", proposal: { action: "start" } });
      }),
    ),
  );

  it.effect("declines when fx has no subscription login", () =>
    withStub(unauthenticatedStubScript, (supervisor) =>
      Effect.gen(function* () {
        const availability = yield* supervisor.availability;
        expect(availability.available).toBe(false);
        const outcome = yield* supervisor.interpret({ prompt: "route this request" });
        expect(outcome).toEqual({ status: "decline", reason: "fast-supervisor-unavailable" });
      }),
    ),
  );

  it.effect("declines on timeout instead of stalling the turn", () =>
    withStub(slowStubScript, (supervisor) =>
      Effect.gen(function* () {
        const outcome = yield* supervisor.interpret({ prompt: "route this request" });
        expect(outcome).toEqual({ status: "decline", reason: "fast-supervisor-timeout" });
      }),
    ),
  );

  it.effect("creates the working directory during layer construction", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped();
      const binary = path.join(directory, "fx-stub.mjs");
      yield* fs.writeFileString(binary, stubScript);
      yield* fs.chmod(binary, 0o755);
      const workingDirectory = path.join(directory, "not-yet-created");
      const layer = makeCirceFastSupervisorLive({
        binaryPath: binary,
        homeDirectory: directory,
        workingDirectory,
        statusTimeoutMs: 2_000,
        askTimeoutMs: 1_000,
        cacheTtlMs: 1_000,
      }).pipe(Layer.provide(NodeServices.layer));
      const supervisor = yield* CirceFastSupervisor.pipe(Effect.provide(layer));
      expect(yield* fs.exists(workingDirectory)).toBe(true);
      const availability = yield* supervisor.availability;
      expect(availability).toEqual({ available: true, model: "gpt-5.6-luna" });
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
