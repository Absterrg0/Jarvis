import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { vi } from "vite-plus/test";

import { LiveVoiceUpstream, layer as liveVoiceUpstreamLayer } from "./LiveVoiceUpstream.ts";

interface FakeSocket {
  readonly accepted: { value: boolean };
  readonly sent: Array<string>;
  readonly closed: { value: boolean };
  readonly socket: {
    accept: () => void;
    addEventListener: (type: string, listener: (event: { data: string }) => void) => void;
    send: (data: string) => void;
    close: () => void;
  };
}

function makeFakeSocket(): FakeSocket {
  const listeners = new Map<string, (event: { data: string }) => void>();
  const accepted = { value: false };
  const closed = { value: false };
  const sent: string[] = [];
  const socket = {
    accept: () => {
      accepted.value = true;
    },
    addEventListener: (type: string, listener: (event: { data: string }) => void) => {
      listeners.set(type, listener);
    },
    send: (data: string) => {
      sent.push(data);
      if ((JSON.parse(data) as { readonly type?: unknown }).type === "session.close") {
        queueMicrotask(() =>
          listeners.get("message")?.({ data: JSON.stringify({ type: "session.closed" }) }),
        );
      }
    },
    close: () => {
      closed.value = true;
    },
  };
  return { accepted, sent, closed, socket };
}

const clientLayer = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make(() => Effect.die("unused upstream client")),
);

const upstreamLayer = liveVoiceUpstreamLayer.pipe(Layer.provide(clientLayer));

describe("LiveVoiceUpstream", () => {
  it.effect("closes the sideband and resolves after session.closed", () => {
    const fake = makeFakeSocket();
    const fetchSpy = vi.fn(async () => ({ webSocket: fake.socket }));
    vi.stubGlobal("fetch", fetchSpy);
    return Effect.gen(function* () {
      const upstream = yield* LiveVoiceUpstream;
      yield* upstream.end({ apiKey: Redacted.make("sk-test"), sessionId: "sess_1" });
      expect(fake.accepted.value).toBe(true);
      expect(fake.closed.value).toBe(true);
      expect(fake.sent.map((entry) => JSON.parse(entry))).toEqual([
        { type: "session.close", event_id: "relay-close" },
      ]);
      expect(fetchSpy).toHaveBeenCalledWith(
        "https://api.openai.com/v1/live/sessions/sess_1/attach",
        expect.objectContaining({
          headers: expect.objectContaining({ Upgrade: "websocket" }),
        }),
      );
    }).pipe(
      Effect.provide(upstreamLayer),
      Effect.ensuring(Effect.sync(() => vi.unstubAllGlobals())),
    );
  });

  it.effect("fails when the sideband is unavailable", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({})),
    );
    return Effect.gen(function* () {
      const upstream = yield* LiveVoiceUpstream;
      const error = yield* Effect.flip(
        upstream.end({ apiKey: Redacted.make("sk-test"), sessionId: "sess_1" }),
      );
      expect(error._tag).toBe("LiveVoiceUpstreamEndFailed");
    }).pipe(
      Effect.provide(upstreamLayer),
      Effect.ensuring(Effect.sync(() => vi.unstubAllGlobals())),
    );
  });
});

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
