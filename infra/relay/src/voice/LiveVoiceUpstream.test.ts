import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/unstable/http/HttpClient";

import { LiveVoiceUpstream, layer as liveVoiceUpstreamLayer } from "./LiveVoiceUpstream.ts";

import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as TestClock from "effect/testing/TestClock";
import * as Fiber from "effect/Fiber";

const createInput = {
  apiKey: Redacted.make("sk-test"),
  sdpOffer: "offer",
  instructions: "test",
  model: "gpt-live-1",
  voice: "marin",
};
const withClient = (client: HttpClient.HttpClient) =>
  liveVoiceUpstreamLayer.pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, client)));

describe("LiveVoiceUpstream creation outcome", () => {
  for (const status of [400, 401, 429, 408, 500]) {
    it.effect(`classifies HTTP ${status} without treating uncertain creation as rejection`, () => {
      const client = HttpClient.make((request) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, new Response("error", { status }))),
      );
      return Effect.gen(function* () {
        const upstream = yield* LiveVoiceUpstream;
        const error = yield* Effect.flip(upstream.create(createInput));
        expect(error.outcome).toBe(status === 408 || status >= 500 ? "unknown" : "rejected");
      }).pipe(Effect.provide(withClient(client)));
    });
  }
  it.effect("keeps malformed successful responses uncertain", () => {
    const client = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json({ session: { id: "created-but-no-sdp" } }),
        ),
      ),
    );
    return Effect.gen(function* () {
      const upstream = yield* LiveVoiceUpstream;
      const error = yield* Effect.flip(upstream.create(createInput));
      expect(error.outcome).toBe("unknown");
    }).pipe(Effect.provide(withClient(client)));
  });
  it.effect("keeps transport failures uncertain", () => {
    const client = HttpClient.make((request) =>
      Effect.fail(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request, cause: "lost response" }),
        }),
      ),
    );
    return Effect.gen(function* () {
      const upstream = yield* LiveVoiceUpstream;
      const error = yield* Effect.flip(upstream.create(createInput));
      expect(error.outcome).toBe("unknown");
    }).pipe(Effect.provide(withClient(client)));
  });
  it.effect("keeps a timed-out creation uncertain", () =>
    Effect.gen(function* () {
      const upstream = yield* LiveVoiceUpstream;
      const pending = yield* upstream.create(createInput).pipe(Effect.flip, Effect.forkChild);
      yield* TestClock.adjust("31 seconds");
      const error = yield* Fiber.join(pending);
      expect(error.outcome).toBe("unknown");
    }).pipe(Effect.provide(withClient(HttpClient.make(() => Effect.never)))),
  );
  it.effect("returns the upstream identity and answer on successful creation", () => {
    const client = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json({ session: { id: "sess_ok" }, transport: { sdp: "answer" } }),
        ),
      ),
    );
    return Effect.gen(function* () {
      const upstream = yield* LiveVoiceUpstream;
      expect(yield* upstream.create(createInput)).toEqual({
        sessionId: "sess_ok",
        sdpAnswer: "answer",
      });
    }).pipe(Effect.provide(withClient(client)));
  });
});

describe("LiveVoiceUpstream hangup", () => {
  for (const scenario of [
    { name: "confirmed hangup", status: 200, body: {}, success: true },
    {
      name: "already ended session",
      status: 404,
      body: { error: { code: "session_id_not_found", param: "session_id" } },
      success: true,
    },
    {
      name: "already ended session without sibling fields",
      status: 404,
      body: { error: { code: "session_id_not_found" } },
      success: true,
    },
    {
      name: "already ended session with drifted sibling fields",
      status: 404,
      body: {
        error: { code: "session_id_not_found", param: "other", type: "invalid_request_error" },
      },
      success: true,
    },
    {
      name: "unrelated missing endpoint",
      status: 404,
      body: { error: { code: "not_found" } },
      success: false,
    },
    { name: "invalid credentials", status: 401, body: {}, success: false },
    { name: "upstream outage", status: 503, body: {}, success: false },
  ]) {
    it.effect(scenario.name, () => {
      const calls: Array<{ url: string; method: string; authorization: string | undefined }> = [];
      const client = HttpClient.make((request) =>
        Effect.sync(() => {
          calls.push({
            url: request.url,
            method: request.method,
            authorization: request.headers.authorization,
          });
          return HttpClientResponse.fromWeb(
            request,
            Response.json(scenario.body, { status: scenario.status }),
          );
        }),
      );
      return Effect.gen(function* () {
        const upstream = yield* LiveVoiceUpstream;
        const ending = upstream.end({
          apiKey: Redacted.make("sk-test"),
          sessionId: "live_original",
        });
        if (scenario.success) yield* ending;
        else
          expect(yield* ending.pipe(Effect.flip)).toMatchObject({
            _tag: "LiveVoiceUpstreamEndFailed",
          });
        expect(calls).toEqual([
          {
            url: "https://api.openai.com/v1/live/sessions/live_original/hangup",
            method: "POST",
            authorization: "Bearer sk-test",
          },
        ]);
      }).pipe(Effect.provide(withClient(client)));
    });
  }
  it.effect("keeps a non-JSON 404 uncertain so the reservation is retained", () => {
    const client = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response("<html>not found</html>", {
            status: 404,
            headers: { "content-type": "text/html" },
          }),
        ),
      ),
    );
    return Effect.gen(function* () {
      const upstream = yield* LiveVoiceUpstream;
      expect(
        yield* upstream
          .end({ apiKey: Redacted.make("sk-test"), sessionId: "live_original" })
          .pipe(Effect.flip),
      ).toMatchObject({ _tag: "LiveVoiceUpstreamEndFailed" });
    }).pipe(Effect.provide(withClient(client)));
  });
});
