import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { PrimaryConnectionTarget, type PreparedConnection } from "../connection/model.ts";
import { remoteHttpClientLayer } from "../rpc/http.ts";
import { ThreadSnapshotLoader, threadSnapshotLoaderLayer } from "./threadSnapshotHttp.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

const PREPARED: PreparedConnection = {
  environmentId: TARGET.environmentId,
  label: TARGET.label,
  httpBaseUrl: TARGET.httpBaseUrl,
  socketUrl: TARGET.wsBaseUrl,
  httpAuthorization: null,
  target: TARGET,
};

const lookupWith = (fetchFn: typeof fetch) =>
  Effect.gen(function* () {
    const loader = yield* ThreadSnapshotLoader;
    expect(loader.lookup).toBeDefined();
    return yield* loader.lookup!(PREPARED, ThreadId.make("thread-missing"));
  }).pipe(
    Effect.provide(threadSnapshotLoaderLayer.pipe(Layer.provide(remoteHttpClientLayer(fetchFn)))),
  );

describe("ThreadSnapshotLoader.lookup", () => {
  it.effect("turns an authoritative thread 404 into missing", () =>
    Effect.gen(function* () {
      const result = yield* lookupWith(() =>
        Promise.resolve(
          Response.json(
            { code: "not_found", reason: "thread_not_found", traceId: "trace-thread-missing" },
            { status: 404 },
          ),
        ),
      );

      expect(result).toEqual({ _tag: "missing" });
    }),
  );

  it.effect("leaves transport failures unreachable to the mobile caller", () =>
    lookupWith(() => Promise.reject(new Error("offline"))).pipe(
      Effect.match({
        onFailure: () => false,
        onSuccess: () => true,
      }),
      Effect.tap((unreachable) => Effect.sync(() => expect(unreachable).toBe(false))),
    ),
  );
});
