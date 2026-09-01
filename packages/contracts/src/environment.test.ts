import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  ExecutionEnvironmentDescriptor,
  jarvisNodeCapabilitiesForPreset,
  ServerEnvironmentLabelInput,
} from "./environment.ts";

const decodeDescriptor = Schema.decodeUnknownSync(ExecutionEnvironmentDescriptor);
const decodeLabelInput = Schema.decodeUnknownSync(ServerEnvironmentLabelInput);

const descriptor = {
  environmentId: "environment-1",
  label: "Local",
  platform: { os: "darwin", arch: "arm64" },
  serverVersion: "0.0.32",
  capabilities: { repositoryIdentity: true },
} as const;

describe("ExecutionEnvironmentDescriptor", () => {
  it("trims and bounds user-owned environment labels", () => {
    expect(decodeLabelInput({ label: "  Studio node  " }).label).toBe("Studio node");
    expect(() => decodeLabelInput({ label: "x".repeat(81) })).toThrow();
  });

  it("treats a missing pull-request capability as unsupported under version skew", () => {
    expect(decodeDescriptor(descriptor).capabilities.pullRequests).toBeUndefined();
  });

  it("preserves an advertised pull-request capability", () => {
    expect(
      decodeDescriptor({
        ...descriptor,
        capabilities: { ...descriptor.capabilities, pullRequests: true },
      }).capabilities.pullRequests,
    ).toBe(true);
  });

  it("decodes canonical Jarvis node capabilities and keeps old descriptors compatible", () => {
    expect(decodeDescriptor(descriptor).capabilities.jarvisNode).toBeUndefined();
    expect(
      decodeDescriptor({
        ...descriptor,
        capabilities: {
          ...descriptor.capabilities,
          jarvisNode: jarvisNodeCapabilitiesForPreset("headless"),
        },
      }).capabilities.jarvisNode,
    ).toEqual({
      preset: "headless",
      ui: false,
      voiceCompute: false,
      parakeet: false,
      kokoro: false,
      execution: true,
      projects: true,
      providers: true,
    });
  });

  it("defaults voice compute off for older Jarvis capability records", () => {
    const capabilities = jarvisNodeCapabilitiesForPreset("full");
    const { voiceCompute: _voiceCompute, ...legacyCapabilities } = capabilities;
    expect(
      decodeDescriptor({
        ...descriptor,
        capabilities: { ...descriptor.capabilities, jarvisNode: legacyCapabilities },
      }).capabilities.jarvisNode?.voiceCompute,
    ).toBe(false);
  });

  it("advertises voice compute only from speech-capable presets", () => {
    expect(jarvisNodeCapabilitiesForPreset("full").voiceCompute).toBe(true);
    expect(jarvisNodeCapabilitiesForPreset("controller")).toMatchObject({
      voiceCompute: true,
      execution: false,
      projects: false,
      providers: false,
    });
    expect(jarvisNodeCapabilitiesForPreset("headless").voiceCompute).toBe(false);
  });

  it("treats a missing attachment upload capability as unsupported", () => {
    expect(decodeDescriptor(descriptor).capabilities.attachmentUploads).toBeUndefined();
  });

  it("preserves an advertised attachment upload capability", () => {
    expect(
      decodeDescriptor({
        ...descriptor,
        capabilities: { ...descriptor.capabilities, attachmentUploads: true },
      }).capabilities.attachmentUploads,
    ).toBe(true);
  });
});
