import { requireNativeModule } from "expo";

interface JarvisAudio {
  begin(id: string): Promise<void>;
  write(id: string, sequence: number, pcmBase64: string): Promise<void>;
  end(id: string): Promise<void>;
  stop(id: string): void;
}

export function getMobilePcmPlayer(): JarvisAudio {
  return requireNativeModule<JarvisAudio>("JarvisAudio");
}
