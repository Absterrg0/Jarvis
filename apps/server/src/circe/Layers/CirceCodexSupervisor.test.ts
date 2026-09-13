// @effect-diagnostics globalDateInEffect:off - this test measures real wall-clock elapsed time to prove interpret returns before the fetch timeout.
import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  CirceCodexSupervisor,
  buildCirceCodexResponsesBody,
  extractCirceCodexJsonObject,
  interpretCirceCodexSseEvent,
  isCirceCodexCredentialFresh,
  circeCodexAccountIdFromIdToken,
  mergeCirceCodexRefreshedAuth,
  parseCirceCodexAuth,
} from "../Services/CirceCodexSupervisor.ts";
import { makeCirceCodexSupervisorLive } from "./CirceCodexSupervisor.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const jwt = (payload: Record<string, unknown>): string =>
  `${Buffer.from("{}").toString("base64url")}.${Buffer.from(encodeJson(payload)).toString("base64url")}.sig`;

const sse = (lines: ReadonlyArray<unknown>): string =>
  lines.map((line) => `data: ${encodeJson(line)}\n\n`).join("");

const proposalEvent = {
  type: "response.output_text.delta",
  delta: encodeJson({ action: "start", refs: [], model: null, effort: null, answer: null }),
};

const fakeFetch = (body: string): typeof fetch =>
  (async () =>
    new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })) as unknown as typeof fetch;

describe("Circe codex supervisor helpers", () => {
  it("parses both Codex CLI and fx auth shapes", () => {
    expect(
      parseCirceCodexAuth({ tokens: { access_token: "tok", refresh_token: "ref" } }),
    ).toMatchObject({ shape: "codex", credentials: { accessToken: "tok", refreshToken: "ref" } });
    expect(
      parseCirceCodexAuth({ access_token: "tok", refresh_token: "ref", expires_at_ms: 100 }),
    ).toMatchObject({
      shape: "fx",
      credentials: { accessToken: "tok", refreshToken: "ref", expiresAtMs: 100 },
    });
    expect(parseCirceCodexAuth({ tokens: {} })).toBeNull();
    expect(parseCirceCodexAuth(null)).toBeNull();
  });

  it("reads the account id and expiry from JWT claims", () => {
    const idToken = jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_1" } });
    expect(circeCodexAccountIdFromIdToken(idToken)).toBe("acct_1");
    expect(circeCodexAccountIdFromIdToken("not-a-jwt")).toBeNull();
    const access = jwt({ exp: 2_000_000 });
    expect(parseCirceCodexAuth({ access_token: access })?.credentials.expiresAtMs).toBe(
      2_000_000_000,
    );
  });

  it("treats unknown expiry as fresh and enforces the skew window", () => {
    expect(isCirceCodexCredentialFresh({ accessToken: "t" }, 10, 60)).toBe(true);
    expect(isCirceCodexCredentialFresh({ accessToken: "t", expiresAtMs: 1_000 }, 950, 60)).toBe(
      false,
    );
    expect(isCirceCodexCredentialFresh({ accessToken: "t", expiresAtMs: 2_000 }, 950, 60)).toBe(
      true,
    );
  });

  it("merges refreshed tokens back into each shape", () => {
    const codex = mergeCirceCodexRefreshedAuth({
      shape: "codex",
      original: { tokens: { id_token: "old", account_id: "acct" }, auth_mode: "chatgpt" },
      accessToken: "new",
      refreshToken: "new-ref",
      refreshedAtIso: "2026-01-01T00:00:00.000Z",
    });
    expect(codex["auth_mode"]).toBe("chatgpt");
    expect(codex["last_refresh"]).toBe("2026-01-01T00:00:00.000Z");
    expect(codex["tokens"]).toMatchObject({
      access_token: "new",
      refresh_token: "new-ref",
      account_id: "acct",
      id_token: "old",
    });
    const fx = mergeCirceCodexRefreshedAuth({
      shape: "fx",
      original: { version: 1 },
      accessToken: "new",
      refreshToken: "new-ref",
      expiresAtMs: 500,
      refreshedAtIso: "2026-01-01T00:00:00.000Z",
    });
    expect(fx).toMatchObject({
      version: 1,
      access_token: "new",
      refresh_token: "new-ref",
      expires_at_ms: 500,
    });
  });

  it("builds a tool-free none-effort request", () => {
    const body = buildCirceCodexResponsesBody({
      model: "gpt-5.6-luna",
      prompt: "route this",
      instructions: "schema",
    });
    expect(body).toMatchObject({
      model: "gpt-5.6-luna",
      store: false,
      stream: true,
      tools: [],
      reasoning: { effort: "none" },
      text: { verbosity: "low" },
    });
    expect(body["input"]).toEqual([{ role: "user", content: "route this" }]);
  });

  it("translates SSE events and extracts the first JSON object", () => {
    expect(
      interpretCirceCodexSseEvent({ type: "response.output_text.delta", delta: "hi" }),
    ).toEqual({ type: "text", delta: "hi" });
    expect(
      interpretCirceCodexSseEvent({
        type: "response.completed",
        response: {
          output: [{ content: [{ type: "output_text", text: '{"a":1}' }] }],
          usage: { output_tokens: 5 },
        },
      }),
    ).toEqual({ type: "completed", text: '{"a":1}', outputTokens: 5 });
    expect(
      interpretCirceCodexSseEvent({ type: "response.failed", error: { message: "x" } }),
    ).toEqual({ type: "failed", message: "x" });
    expect(extractCirceCodexJsonObject('noise {"a":{"b":1}} tail')).toEqual({ a: { b: 1 } });
    expect(extractCirceCodexJsonObject("no json")).toBeNull();
  });
});

describe("Circe codex supervisor layer", () => {
  it.effect("interprets a proposal and returns as soon as the JSON is balanced", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped();
      const authFile = path.join(directory, "auth.json");
      yield* fs.writeFileString(
        authFile,
        encodeJson({ tokens: { access_token: "test-token", refresh_token: "test-refresh" } }),
      );
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(sse([proposalEvent])));
          // Remains open on purpose: only an early return on balanced JSON
          // lets interpret finish without waiting for close or timeout.
        },
      });
      const openFetch = (async () =>
        new Response(body, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        })) as unknown as typeof fetch;
      const layer = makeCirceCodexSupervisorLive({
        authFiles: [authFile],
        homeDirectory: "",
        fetchImpl: openFetch,
        timeoutMs: 2_000,
      }).pipe(Layer.provide(NodeServices.layer));
      const supervisor = yield* CirceCodexSupervisor.pipe(Effect.provide(layer));
      const availability = yield* supervisor.availability;
      expect(availability).toMatchObject({ available: true });
      const startedAt = Date.now();
      const outcome = yield* supervisor.interpret({ prompt: "route this" });
      const elapsedMs = Date.now() - startedAt;
      expect(outcome).toMatchObject({ status: "proposal", proposal: { action: "start" } });
      expect(elapsedMs).toBeLessThan(2_000);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("declines when there is no auth file", () =>
    Effect.gen(function* () {
      const layer = makeCirceCodexSupervisorLive({
        authFiles: ["/nonexistent/auth.json"],
        homeDirectory: "",
        fetchImpl: fakeFetch(""),
      }).pipe(Layer.provide(NodeServices.layer));
      const supervisor = yield* CirceCodexSupervisor.pipe(Effect.provide(layer));
      const outcome = yield* supervisor.interpret({ prompt: "route this" });
      expect(outcome).toMatchObject({
        status: "decline",
        reason: "codex-supervisor-unauthenticated",
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("refreshes expired credentials once under concurrent resolve", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped();
      const authFile = path.join(directory, "auth.json");
      yield* fs.writeFileString(
        authFile,
        encodeJson({
          access_token: "old-token",
          refresh_token: "test-refresh",
          expires_at_ms: 1,
        }),
      );
      let tokenCalls = 0;
      const countingFetch = (async (url: unknown) => {
        if (typeof url === "string" && url.includes("oauth/token")) {
          tokenCalls += 1;
          await new Promise((resolve) => setTimeout(resolve, 50));
          return new Response(
            encodeJson({ access_token: "new-token", refresh_token: "new-ref", expires_in: 3600 }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(sse([proposalEvent]), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }) as unknown as typeof fetch;
      const layer = makeCirceCodexSupervisorLive({
        authFiles: [authFile],
        homeDirectory: "",
        fetchImpl: countingFetch,
        timeoutMs: 2_000,
        cacheTtlMs: 30_000,
        refreshSkewMs: 60_000,
      }).pipe(Layer.provide(NodeServices.layer));
      const supervisor = yield* CirceCodexSupervisor.pipe(Effect.provide(layer));
      const results = yield* Effect.all([supervisor.availability, supervisor.availability], {
        concurrency: 2,
      });
      expect(results[0]).toMatchObject({ available: true });
      expect(results[1]).toMatchObject({ available: true });
      expect(tokenCalls).toBe(1);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("treats non-positive expires_in as unknown expiry", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped();
      const authFile = path.join(directory, "auth.json");
      yield* fs.writeFileString(
        authFile,
        encodeJson({
          access_token: "old-token",
          refresh_token: "test-refresh",
          expires_at_ms: 1,
        }),
      );
      const badExpiryFetch = (async (url: unknown) => {
        if (typeof url === "string" && url.includes("oauth/token")) {
          return new Response(
            encodeJson({ access_token: "new-token", refresh_token: "new-ref", expires_in: 0 }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(sse([proposalEvent]), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }) as unknown as typeof fetch;
      const layer = makeCirceCodexSupervisorLive({
        authFiles: [authFile],
        homeDirectory: "",
        fetchImpl: badExpiryFetch,
        timeoutMs: 2_000,
        cacheTtlMs: 30_000,
        refreshSkewMs: 60_000,
      }).pipe(Layer.provide(NodeServices.layer));
      const supervisor = yield* CirceCodexSupervisor.pipe(Effect.provide(layer));
      const availability = yield* supervisor.availability;
      expect(availability).toMatchObject({ available: true });
      const written = yield* fs.readFileString(authFile);
      const record = (yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(
        written,
      )) as Record<string, unknown>;
      expect(record["access_token"]).toBe("new-token");
      expect(record["expires_at_ms"]).toBeNull();
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
