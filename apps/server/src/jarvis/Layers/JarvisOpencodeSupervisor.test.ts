import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  JarvisOpencodeSupervisor,
  buildJarvisOpencodeChatBody,
  interpretJarvisOpencodeSseEvent,
  parseJarvisOpencodeAuth,
  resolveJarvisOpencodeRoute,
} from "../Services/JarvisOpencodeSupervisor.ts";
import { makeJarvisOpencodeSupervisorLive } from "./JarvisOpencodeSupervisor.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const fakeFetch = (body: string): typeof fetch =>
  (async () =>
    new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })) as unknown as typeof fetch;

const proposalText = encodeJson({
  action: "start",
  refs: [],
  model: null,
  effort: null,
  answer: null,
});
const chatBody = `data: ${encodeJson({ choices: [{ delta: { content: proposalText } }] })}\n\ndata: [DONE]\n\n`;

const withLayer = <A, E>(
  body: string,
  run: (supervisor: JarvisOpencodeSupervisor["Service"]) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped();
    const authFile = path.join(directory, "auth.json");
    yield* fs.writeFileString(
      authFile,
      encodeJson({ "opencode-go": { type: "api", key: "test-key" } }),
    );
    const layer = makeJarvisOpencodeSupervisorLive({
      authFiles: [authFile],
      homeDirectory: "",
      fetchImpl: fakeFetch(body),
      timeoutMs: 2_000,
    }).pipe(Layer.provide(NodeServices.layer));
    const supervisor = yield* JarvisOpencodeSupervisor.pipe(Effect.provide(layer));
    return yield* run(supervisor);
  }).pipe(Effect.provide(NodeServices.layer));

describe("Jarvis opencode supervisor helpers", () => {
  it("parses the two gateway keys", () => {
    expect(
      parseJarvisOpencodeAuth({ "opencode-go": { key: "go" }, opencode: { key: "zen" } }),
    ).toEqual({ go: "go", zen: "zen" });
    expect(parseJarvisOpencodeAuth({ opencode: { key: "  " } })).toEqual({});
    expect(parseJarvisOpencodeAuth(null)).toEqual({});
  });

  it("resolves Go versus Zen from the model slug", () => {
    expect(
      resolveJarvisOpencodeRoute({ auth: { go: "g", zen: "z" }, model: "opencode-go/x" }),
    ).toMatchObject({ route: "go" });
    expect(
      resolveJarvisOpencodeRoute({ auth: { go: "g", zen: "z" }, model: "opencode/x" }),
    ).toMatchObject({ route: "zen" });
    expect(resolveJarvisOpencodeRoute({ auth: {}, model: "opencode-go/x" })).toBeNull();
    expect(
      resolveJarvisOpencodeRoute({ auth: { go: "g" }, goModel: "deepseek-flash" }),
    ).toMatchObject({ route: "go", model: "deepseek-flash" });
  });

  it("builds a minimal chat body and reads stream deltas", () => {
    const body = buildJarvisOpencodeChatBody({
      model: "deepseek-flash",
      prompt: "route",
      instructions: "schema",
    });
    expect(body).toMatchObject({ model: "deepseek-flash", stream: true });
    expect(body["messages"]).toEqual([
      { role: "system", content: "schema" },
      { role: "user", content: "route" },
    ]);
    expect(interpretJarvisOpencodeSseEvent({ choices: [{ delta: { content: "hi" } }] })).toEqual({
      type: "text",
      delta: "hi",
    });
    expect(interpretJarvisOpencodeSseEvent({ choices: [] })).toEqual({ type: "ignore" });
  });
});

describe("Jarvis opencode supervisor layer", () => {
  it.effect("interprets a proposal from the chat stream", () =>
    withLayer(chatBody, (supervisor) =>
      Effect.gen(function* () {
        const availability = yield* supervisor.availability;
        expect(availability).toMatchObject({ available: true, route: "go" });
        const outcome = yield* supervisor.interpret({ prompt: "route this" });
        expect(outcome).toMatchObject({ status: "proposal", proposal: { action: "start" } });
      }),
    ),
  );

  it.effect("declines without an auth file", () =>
    Effect.gen(function* () {
      const layer = makeJarvisOpencodeSupervisorLive({
        authFiles: ["/nonexistent/auth.json"],
        homeDirectory: "",
        fetchImpl: fakeFetch(""),
      }).pipe(Layer.provide(NodeServices.layer));
      const supervisor = yield* JarvisOpencodeSupervisor.pipe(Effect.provide(layer));
      const outcome = yield* supervisor.interpret({ prompt: "route this" });
      expect(outcome).toMatchObject({
        status: "decline",
        reason: "opencode-supervisor-unauthenticated",
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
