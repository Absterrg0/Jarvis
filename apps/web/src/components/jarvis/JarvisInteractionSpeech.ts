export interface JarvisInteractionSpeechSink {
  readonly speak: (text: string, deliveryId: string) => void;
  readonly cancel: (deliveryId: string) => void;
}

/**
 * Owns one live interaction utterance on the shared browser speech lane.
 * Speaking supersedes the previous utterance, and cancel retracts whatever
 * is current — audible or still queued — by its retained delivery identity.
 * Empty text never touches the lane.
 */
export function createJarvisInteractionSpeech(sink: JarvisInteractionSpeechSink): {
  readonly speak: (text: string) => void;
  readonly cancel: () => void;
  readonly currentDeliveryId: () => string | null;
} {
  let current: string | null = null;
  let counter = 0;
  const instancePrefix = Math.random().toString(36).slice(2);
  return {
    speak: (text: string) => {
      if (text.trim().length === 0) return;
      if (current !== null) {
        sink.cancel(current);
        current = null;
      }
      counter += 1;
      const deliveryId = `jarvis-interaction-${instancePrefix}-${counter}`;
      current = deliveryId;
      sink.speak(text, deliveryId);
    },
    cancel: () => {
      if (current === null) return;
      const deliveryId = current;
      current = null;
      sink.cancel(deliveryId);
    },
    currentDeliveryId: () => current,
  };
}

export type JarvisInteractionSpeech = ReturnType<typeof createJarvisInteractionSpeech>;
