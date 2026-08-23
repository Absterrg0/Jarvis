export type SampleFormat = "i16" | "u16" | "f32";

export interface AudioDeviceConfig {
  minSampleRate: number;
  maxSampleRate: number;
  channels: number;
  sampleFormat: SampleFormat;
}

export interface StreamConfig {
  minSampleRate?: number;
  maxSampleRate?: number;
  sampleRate: number;
  channels: number;
  sampleFormat: SampleFormat;
}

export interface AudioDevice {
  name: string;
  hostId: string;
  deviceId: string;
  isDefaultInput: boolean;
  isDefaultOutput: boolean;
  supportedInputConfigs?: AudioDeviceConfig[];
  supportedOutputConfigs?: AudioDeviceConfig[];
}

export interface AudioHost {
  id: string;
  name: string;
}

export interface StreamHandle {
  deviceId: string;
  streamId: string;
}

export function getHosts(): AudioHost[];
export function getDevices(hostId?: string): AudioDevice[];
export function getDefaultInputDevice(): AudioDevice;
export function getDefaultOutputDevice(): AudioDevice;
export function getSupportedInputConfigs(deviceId: string): AudioDeviceConfig[];
export function getSupportedOutputConfigs(deviceId: string): AudioDeviceConfig[];
export function getDefaultInputConfig(deviceId: string): StreamConfig;
export function getDefaultOutputConfig(deviceId: string): StreamConfig;
export function getSupportedFormats(deviceId: string, isInput: boolean): SampleFormat[];
export function getSupportedSampleRates(deviceId: string, isInput: boolean): number[];
export function getMaxChannels(deviceId: string, isInput: boolean): number;
export function createStream(
  deviceId: string,
  isInput: boolean,
  config: StreamConfig,
  onData?: (data: Float32Array) => void,
): StreamHandle;
export function writeToStream(stream: StreamHandle, data: Float32Array): void;
export function pauseStream(stream: StreamHandle): void;
export function resumeStream(stream: StreamHandle): void;
export function closeStream(stream: StreamHandle): void;
export function isStreamActive(stream: StreamHandle): boolean;
