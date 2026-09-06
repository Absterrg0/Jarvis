import { describe, expect, it, vi } from "vite-plus/test";

import { createJarvisInteractionSpeech } from "./JarvisInteractionSpeech";

describe("Jarvis interaction speech ownership", () => {
  it("retains the delivery identity it speaks", () => {
    const sink = { speak: vi.fn(), cancel: vi.fn() };
    const speech = createJarvisInteractionSpeech(sink);
    speech.speak("Which effort?");
    expect(sink.speak).toHaveBeenCalledTimes(1);
    expect(speech.currentDeliveryId()).toBe(sink.speak.mock.calls[0]?.[1]);
  });

  it("supersedes the previous utterance before speaking the next", () => {
    const sink = { speak: vi.fn(), cancel: vi.fn() };
    const speech = createJarvisInteractionSpeech(sink);
    speech.speak("First.");
    const first = sink.speak.mock.calls[0]?.[1] as string;
    speech.speak("Second.");
    expect(sink.cancel).toHaveBeenCalledWith(first);
    expect(sink.speak).toHaveBeenCalledTimes(2);
    expect(speech.currentDeliveryId()).toBe(sink.speak.mock.calls[1]?.[1]);
    expect(speech.currentDeliveryId()).not.toBe(first);
  });

  it("cancels the current utterance and stays silent afterwards", () => {
    const sink = { speak: vi.fn(), cancel: vi.fn() };
    const speech = createJarvisInteractionSpeech(sink);
    speech.speak("Which effort?");
    const deliveryId = speech.currentDeliveryId() as string;
    speech.cancel();
    expect(sink.cancel).toHaveBeenCalledWith(deliveryId);
    expect(speech.currentDeliveryId()).toBeNull();
    speech.cancel();
    expect(sink.cancel).toHaveBeenCalledTimes(1);
  });

  it("ignores empty text without touching the lane", () => {
    const sink = { speak: vi.fn(), cancel: vi.fn() };
    const speech = createJarvisInteractionSpeech(sink);
    speech.speak("   ");
    expect(sink.speak).not.toHaveBeenCalled();
    expect(speech.currentDeliveryId()).toBeNull();
  });

  it("keeps speaking normally after a cancel", () => {
    const sink = { speak: vi.fn(), cancel: vi.fn() };
    const speech = createJarvisInteractionSpeech(sink);
    speech.speak("First.");
    speech.cancel();
    speech.speak("Second.");
    expect(sink.speak).toHaveBeenCalledTimes(2);
    expect(speech.currentDeliveryId()).toBe(sink.speak.mock.calls[1]?.[1]);
  });
});
