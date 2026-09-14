import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { runCirceQuickLookup } from "./CirceQuickLookup.ts";

const ahmedabad = {
  id: 1279233,
  name: "Ahmedabad",
  admin1: "Gujarat",
  country: "India",
  country_code: "IN",
  latitude: 23.02,
  longitude: 72.57,
  timezone: "Asia/Kolkata",
};
const forecast = {
  current: {
    time: "2026-09-14T12:30",
    temperature_2m: 31,
    apparent_temperature: 34,
    weather_code: 2,
  },
  daily: {
    time: ["2026-09-14", "2026-09-15"],
    temperature_2m_min: [24, 25],
    temperature_2m_max: [32, 33],
    precipitation_probability_max: [10, 20],
  },
};
function fixture(places = [ahmedabad], weather: unknown = forecast, status = 200) {
  const calls: string[] = [];
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      calls.push(request.url);
      return HttpClientResponse.fromWeb(
        request,
        Response.json(request.url.includes("geocoding-api") ? { results: places } : weather, {
          status,
        }),
      );
    }),
  );
  return { calls, http };
}
const input = { kind: "weather", location: "Ahmedabad", day: "now" } as const;

describe("Circe quick lookup", () => {
  it.effect("fetches current weather from bounded APIs without provider services", () =>
    Effect.gen(function* () {
      const { http, calls } = fixture();
      const result = yield* runCirceQuickLookup(input, "full").pipe(
        Effect.provideService(HttpClient.HttpClient, http),
      );
      expect(result).toMatchObject({ status: "answer", source: "https://open-meteo.com/" });
      expect("message" in result && result.message).toContain("31°C");
      expect(calls).toHaveLength(2);
      expect(new URL(calls[0]!).searchParams.get("name")).toBe("Ahmedabad");
    }),
  );
  it.effect("works on Controller and refuses Headless before networking", () =>
    Effect.gen(function* () {
      const { http, calls } = fixture();
      expect(
        (yield* runCirceQuickLookup(input, "headless").pipe(
          Effect.provideService(HttpClient.HttpClient, http),
        )).status,
      ).toBe("unavailable");
      expect(calls).toHaveLength(0);
      expect(
        (yield* runCirceQuickLookup(input, "controller").pipe(
          Effect.provideService(HttpClient.HttpClient, http),
        )).status,
      ).toBe("answer");
    }),
  );
  it.effect("asks about ambiguous places and revalidates the selected ID", () =>
    Effect.gen(function* () {
      const { http, calls } = fixture([ahmedabad, { ...ahmedabad, id: 2, admin1: "Other state" }]);
      const run = (placeId?: number) =>
        runCirceQuickLookup(
          { ...input, ...(placeId === undefined ? {} : { placeId }) },
          "full",
        ).pipe(Effect.provideService(HttpClient.HttpClient, http));
      expect((yield* run()).status).toBe("needs-input");
      expect((yield* run(999)).status).toBe("needs-input");
      expect(calls).toHaveLength(2);
      expect((yield* run(ahmedabad.id)).status).toBe("answer");
    }),
  );
  it.effect("grounds explicit state and country, and handles tomorrow", () =>
    Effect.gen(function* () {
      const { http } = fixture([ahmedabad, { ...ahmedabad, id: 2, country: "Elsewhere" }]);
      const result = yield* runCirceQuickLookup(
        { ...input, location: "Ahmedabad, Gujarat, India", day: "tomorrow" },
        "full",
      ).pipe(Effect.provideService(HttpClient.HttpClient, http));
      expect(result.message).toContain("25 to 33°C");
      expect(result.message).toContain("20%");
    }),
  );
  it.effect("reports a place's local time without a weather request", () =>
    Effect.gen(function* () {
      const { http, calls } = fixture();
      const result = yield* runCirceQuickLookup({ ...input, kind: "time" }, "full").pipe(
        Effect.provideService(HttpClient.HttpClient, http),
      );
      expect(result.status).toBe("answer");
      expect(calls).toHaveLength(1);
    }),
  );
  it.effect("fails closed on an HTTP error or malformed weather", () =>
    Effect.gen(function* () {
      for (const sample of [fixture([ahmedabad], {}, 200), fixture([ahmedabad], forecast, 503)]) {
        const result = yield* runCirceQuickLookup(input, "full").pipe(
          Effect.provideService(HttpClient.HttpClient, sample.http),
        );
        expect(result.status).toBe("unavailable");
      }
    }),
  );
  it.effect("refuses a place the user never said before any network request", () =>
    Effect.gen(function* () {
      const { http, calls } = fixture();
      const result = yield* runCirceQuickLookup(
        { ...input, location: "London", sourceUtterance: "what's the weather in Ahmedabad?" },
        "full",
      ).pipe(Effect.provideService(HttpClient.HttpClient, http));
      expect(result.status).toBe("unavailable");
      expect(calls).toHaveLength(0);
    }),
  );
  it.effect("accepts a place copied verbatim from the utterance", () =>
    Effect.gen(function* () {
      const { http } = fixture();
      const result = yield* runCirceQuickLookup(
        { ...input, sourceUtterance: "What's the weather in ahmedabad?" },
        "full",
      ).pipe(Effect.provideService(HttpClient.HttpClient, http));
      expect(result.status).toBe("answer");
    }),
  );
});
