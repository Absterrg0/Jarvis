import * as Schema from "effect/Schema";

import { PortSchema, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** Authenticated loopback bridge to Desktop's single voice worker. */
export const JarvisVoiceBrokerBootstrap = Schema.Struct({
  host: Schema.Literal("127.0.0.1"),
  port: PortSchema,
  token: TrimmedNonEmptyString,
});
export type JarvisVoiceBrokerBootstrap = typeof JarvisVoiceBrokerBootstrap.Type;

export const DesktopBackendBootstrap = Schema.Struct({
  mode: Schema.Literal("desktop"),
  noBrowser: Schema.Boolean,
  port: PortSchema,
  // Omitted when the desktop launches the backend inside WSL, since the
  // Windows-side baseDir maps to /mnt/c/... and the Linux side should use its
  // own home directory instead.
  t3Home: Schema.optional(Schema.String),
  host: Schema.String,
  desktopBootstrapToken: Schema.String,
  tailscaleServeEnabled: Schema.Boolean,
  tailscaleServePort: PortSchema,
  otlpTracesUrl: Schema.optional(Schema.String),
  otlpMetricsUrl: Schema.optional(Schema.String),
  desktopTelemetryFd: Schema.optionalKey(PositiveInt),
  desktopTelemetryControlFd: Schema.optionalKey(PositiveInt),
  resourceMonitorPath: Schema.optionalKey(TrimmedNonEmptyString),
  jarvisVoiceBroker: Schema.optionalKey(JarvisVoiceBrokerBootstrap),
});

export type DesktopBackendBootstrap = typeof DesktopBackendBootstrap.Type;
