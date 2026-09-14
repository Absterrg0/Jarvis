import type * as Cause from "effect/Cause";
import type * as HttpClientError from "effect/unstable/http/HttpClientError";
import { CirceQuickLookupInput, type CirceQuickLookupResult } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

const decodeLookupInput = Schema.decodeEffect(CirceQuickLookupInput);
const Place = Schema.Struct({
  id: Schema.Int,
  name: Schema.String,
  latitude: Schema.Finite,
  longitude: Schema.Finite,
  timezone: Schema.String,
  country: Schema.optionalKey(Schema.String),
  country_code: Schema.optionalKey(Schema.String),
  admin1: Schema.optionalKey(Schema.String),
});
const Places = Schema.Struct({
  results: Schema.optionalKey(Schema.Array(Place).check(Schema.isMaxLength(10))),
});
const Forecast = Schema.Struct({
  current: Schema.Struct({
    time: Schema.String,
    temperature_2m: Schema.Finite,
    apparent_temperature: Schema.Finite,
    weather_code: Schema.Int,
  }),
  daily: Schema.Struct({
    time: Schema.Array(Schema.String),
    temperature_2m_max: Schema.Array(Schema.Finite),
    temperature_2m_min: Schema.Array(Schema.Finite),
    precipitation_probability_max: Schema.Array(Schema.Finite),
  }),
});
const placeLabel = (place: typeof Place.Type) =>
  [...new Set([place.name, place.admin1, place.country].filter(Boolean))].join(", ");
const normalized = (text: string) =>
  text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().trim();
const condition = (code: number) => {
  if (code === 0) return "clear skies";
  if (code <= 3) return "partly cloudy to overcast skies";
  if (code === 45 || code === 48) return "fog";
  if (code >= 51 && code <= 57) return "drizzle";
  if (code >= 61 && code <= 67) return "rain";
  if (code >= 71 && code <= 77) return "snow";
  if (code >= 80 && code <= 82) return "rain showers";
  if (code === 85 || code === 86) return "snow showers";
  if (code >= 95 && code <= 99) return "thunderstorms";
  return "conditions unavailable";
};

/** Fixed-origin, read-only tools. No model, provider session, filesystem, or task dispatch. */
export const runCirceQuickLookup = (
  rawInput: CirceQuickLookupInput,
  preset: "full" | "controller" | "headless",
) =>
  Effect.gen(function* (): Effect.fn.Return<
    CirceQuickLookupResult,
    Schema.SchemaError | HttpClientError.HttpClientError | Cause.UnknownError,
    HttpClient.HttpClient
  > {
    if (preset === "headless")
      return {
        status: "unavailable",
        message: "Quick assistant lookups need a Full or Controller node.",
      };
    const input = yield* decodeLookupInput(rawInput);
    if (
      input.sourceUtterance !== undefined &&
      !normalized(input.sourceUtterance).includes(normalized(input.location))
    ) {
      return {
        status: "unavailable",
        message:
          "I couldn't match that place to what you said. Name the city with its state or country.",
      };
    }
    const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
    const [name, ...regions] = input.location.split(",").map((part) => part.trim());
    if (!name)
      return {
        status: "needs-input",
        message: "Name a city, optionally followed by its state and country.",
        choices: [],
      };
    const geocoding = new URL("https://geocoding-api.open-meteo.com/v1/search");
    geocoding.search = new URLSearchParams({
      name,
      count: "10",
      language: "en",
      format: "json",
    }).toString();
    const placesResponse = yield* client.get(geocoding.href);
    const places = yield* HttpClientResponse.schemaBodyJson(Places)(placesResponse);
    const candidates = (places.results ?? []).filter((place) =>
      regions.every((region) =>
        [place.admin1, place.country, place.country_code].some(
          (value) => value !== undefined && normalized(value) === normalized(region),
        ),
      ),
    );
    const selected =
      input.placeId === undefined
        ? candidates.length === 1
          ? candidates[0]
          : undefined
        : candidates.find((place) => place.id === input.placeId);
    if (selected === undefined) {
      return {
        status: "needs-input",
        message:
          candidates.length === 0
            ? `I couldn't find ${input.location}. Try the city, state, and country.`
            : "Which place did you mean?",
        choices: candidates.map((place) => ({ id: place.id, label: placeLabel(place) })),
      };
    }
    const label = placeLabel(selected);
    if (input.kind === "time") {
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      const time = yield* Effect.try(() =>
        new Intl.DateTimeFormat("en", {
          timeZone: selected.timezone,
          weekday: "long",
          hour: "numeric",
          minute: "2-digit",
          timeZoneName: "short",
        }).format(now),
      );
      return {
        status: "answer",
        message: `${label}: ${time}.`,
        source: "https://open-meteo.com/en/docs/geocoding-api",
      };
    }
    const url = new URL("https://api.open-meteo.com/v1/forecast");
    url.search = new URLSearchParams({
      latitude: String(selected.latitude),
      longitude: String(selected.longitude),
      timezone: selected.timezone,
      current: "temperature_2m,apparent_temperature,weather_code",
      daily: "temperature_2m_max,temperature_2m_min,precipitation_probability_max",
      forecast_days: "2",
    }).toString();
    const response = yield* client.get(url.href);
    const forecast = yield* HttpClientResponse.schemaBodyJson(Forecast)(response);
    if (input.day === "now")
      return {
        status: "answer",
        source: "https://open-meteo.com/",
        message: `${label}: ${forecast.current.temperature_2m}°C, ${condition(forecast.current.weather_code)}, feels like ${forecast.current.apparent_temperature}°C. Updated ${forecast.current.time.replace("T", " ")} local time.`,
      };
    const index = input.day === "tomorrow" ? 1 : 0;
    const day = forecast.daily.time[index];
    const low = forecast.daily.temperature_2m_min[index];
    const high = forecast.daily.temperature_2m_max[index];
    const rain = forecast.daily.precipitation_probability_max[index];
    if (day === undefined || low === undefined || high === undefined || rain === undefined)
      return {
        status: "unavailable",
        message: "The weather service returned an incomplete forecast. Try again.",
      };
    return {
      status: "answer",
      source: "https://open-meteo.com/",
      message: `${label}, ${input.day} (${day}): ${low} to ${high}°C, with a ${rain}% chance of rain.`,
    };
  }).pipe(
    Effect.timeout("10 seconds"),
    Effect.orElseSucceed((): CirceQuickLookupResult => ({
      status: "unavailable",
      message: "I couldn't reach the weather and place service. Try the lookup again.",
    })),
  );
