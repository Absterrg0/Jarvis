import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  CirceGrokSupervisor,
  buildCirceGrokResponsesBody,
  mergeCirceGrokRefreshedAuth,
  parseCirceGrokAuth,
} from "../Services/CirceGrokSupervisor.ts";
import { makeCirceGrokSupervisorLive } from "./CirceGrokSupervisor.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const fakeFetch = (body: string): typeof fetch =>
  (async () =>
    new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })) as unknown as typeof fetch;

const proposalEvent = {
  type: "response.output_text.delta",
  delta: encodeJson({ action: "start", refs: [], model: null, effort: null, answer: null }),
};
const sse = `data: ${encodeJson(proposalEvent)}\n\ndata: [DONE]\n\n`;

const withLayer = <A, E>(
  run: (supervisor: CirceGrokSupervisor["Service"]) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped();
    const authFile = path.join(directory, "auth.json");
    const versionFile = path.join(directory, "version.json");
    yield* fs.writeFileString(
      authFile,
      encodeJson({
        "https://auth.x.ai::client": {
          key: "test-token",
          refresh_token: "test-refresh",
          user_id: "user-1",
          expires_at: "2999-01-01T00:00:00.000Z",
        },
      }),
    );
    yield* fs.writeFileString(versionFile, encodeJson({ version: "1.0.30" }));
    const layer = makeCirceGrokSupervisorLive({
      authFiles: [authFile],
      versionFiles: [versionFile],
      homeDirectory: "",
      fetchImpl: fakeFetch(sse),
      timeoutMs: 2_000,
    }).pipe(Layer.provide(NodeServices.layer));
    const supervisor = yield* CirceGrokSupervisor.pipe(Effect.provide(layer));
    return yield* run(supervisor);
  }).pipe(Effect.provide(NodeServices.layer));

describe("Circe grok supervisor helpers", () => {
  it("parses both the Grok CLI and fx auth shapes", () => {
    expect(
      parseCirceGrokAuth({
        "https://auth.x.ai::client": {
          key: "tok",
          refresh_token: "ref",
          user_id: "u",
          expires_at: "2026-01-01T00:00:00.000Z",
        },
      }),
    ).toMatchObject({ shape: "grok-cli", credentials: { accessToken: "tok", accountId: "u" } });
    expect(
      parseCirceGrokAuth({
        access_token: "tok",
        refresh_token: "ref",
        account_id: "acct",
        expires_at_ms: 100,
      }),
    ).toMatchObject({ shape: "fx", credentials: { accessToken: "tok", accountId: "acct" } });
    expect(parseCirceGrokAuth({})).toBeNull();
  });

  it("returns the selected entry key and merges into it, not the first entry", () => {
    const original = {
      broken: null,
      stale: "not-a-record",
      "https://auth.x.ai::client": {
        key: "old-token",
        refresh_token: "ref",
        user_id: "u",
        expires_at: "2026-01-01T00:00:00.000Z",
      },
    };
    const parsed = parseCirceGrokAuth(original);
    expect(parsed).toMatchObject({
      shape: "grok-cli",
      key: "https://auth.x.ai::client",
      credentials: { accessToken: "old-token" },
    });
    if (parsed?.shape !== "grok-cli") throw new Error("expected grok-cli auth");
    const merged = mergeCirceGrokRefreshedAuth({
      shape: parsed.shape,
      original,
      accessToken: "new-token",
      refreshToken: "new-ref",
      expiresAtIso: "2026-02-01T00:00:00.000Z",
      key: parsed.key,
    });
    expect((merged["https://auth.x.ai::client"] as Record<string, unknown>)["key"]).toBe(
      "new-token",
    );
    expect((merged["https://auth.x.ai::client"] as Record<string, unknown>)["refresh_token"]).toBe(
      "new-ref",
    );
    expect(merged["broken"]).toBeNull();
    expect(merged["stale"]).toBe("not-a-record");
  });

  it("builds a tool-free body without tool_choice", () => {
    const body = buildCirceGrokResponsesBody({
      model: "grok-4.6",
      prompt: "route",
      instructions: "schema",
    });
    expect(body).toMatchObject({
      model: "grok-4.6",
      stream: true,
      tools: [],
      reasoning: { effort: "low" },
    });
    expect(body["tool_choice"]).toBeUndefined();
  });
});

describe("Circe grok supervisor layer", () => {
  it.effect("interprets a proposal from the Grok stream", () =>
    withLayer((supervisor) =>
      Effect.gen(function* () {
        const availability = yield* supervisor.availability;
        expect(availability).toMatchObject({ available: true, model: "grok-4.6" });
        const outcome = yield* supervisor.interpret({ prompt: "route this" });
        expect(outcome).toMatchObject({ status: "proposal", proposal: { action: "start" } });
      }),
    ),
  );

  it.effect("declines without an auth file", () =>
    Effect.gen(function* () {
      const layer = makeCirceGrokSupervisorLive({
        authFiles: ["/nonexistent/auth.json"],
        homeDirectory: "",
        fetchImpl: fakeFetch(""),
      }).pipe(Layer.provide(NodeServices.layer));
      const supervisor = yield* CirceGrokSupervisor.pipe(Effect.provide(layer));
      const outcome = yield* supervisor.interpret({ prompt: "route this" });
      expect(outcome).toMatchObject({
        status: "decline",
        reason: "grok-supervisor-unauthenticated",
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
