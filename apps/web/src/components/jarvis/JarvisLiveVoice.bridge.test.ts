import { describe, expect, it } from "vite-plus/test";

import {
  consumeJarvisLiveVoiceActivationReason,
  getJarvisLiveVoiceSink,
  getJarvisLiveVoiceUiState,
  registerJarvisLiveVoiceDelegate,
  requestJarvisLiveVoiceAnnouncement,
  setJarvisLiveVoiceActive,
  setJarvisLiveVoiceEnabled,
  setJarvisLiveVoiceSink,
  setJarvisLiveVoiceStatus,
  submitJarvisLiveVoiceDelegation,
  subscribeJarvisLiveVoice,
  takeJarvisLiveVoiceAnnouncements,
} from "./JarvisLiveVoice.bridge";

describe("Jarvis live voice bridge", () => {
  it("activates, tracks status, and clears the sink outside a session", () => {
    const events: string[] = [];
    const unsubscribe = subscribeJarvisLiveVoice(() => events.push("changed"));
    setJarvisLiveVoiceActive(true);
    setJarvisLiveVoiceStatus("live");
    expect(getJarvisLiveVoiceUiState()).toEqual({ active: true, status: "live" });
    setJarvisLiveVoiceSink({ speak: () => undefined, note: () => undefined });
    expect(getJarvisLiveVoiceSink()).not.toBeNull();
    setJarvisLiveVoiceActive(false);
    setJarvisLiveVoiceSink(null);
    expect(getJarvisLiveVoiceUiState()).toEqual({ active: false, status: "idle" });
    expect(getJarvisLiveVoiceSink()).toBeNull();
    // active true, live, active false: the sink itself is not UI state.
    expect(events).toHaveLength(3);
    unsubscribe();
  });

  it("queues announcements and marks an announcement-only activation", () => {
    setJarvisLiveVoiceActive(false);
    setJarvisLiveVoiceSink(null);
    setJarvisLiveVoiceEnabled(true);
    requestJarvisLiveVoiceAnnouncement("The login fix is done.");
    expect(getJarvisLiveVoiceUiState().active).toBe(true);
    expect(consumeJarvisLiveVoiceActivationReason()).toBe("announcement");
    expect(consumeJarvisLiveVoiceActivationReason()).toBe("user");
    expect(takeJarvisLiveVoiceAnnouncements()).toEqual(["The login fix is done."]);
    expect(takeJarvisLiveVoiceAnnouncements()).toEqual([]);

    // A live session takes the report directly instead of restarting.
    const spoken: string[] = [];
    setJarvisLiveVoiceSink({
      speak: (text) => spoken.push(text),
      note: () => undefined,
    });
    requestJarvisLiveVoiceAnnouncement("Another report.");
    expect(spoken).toEqual(["Another report."]);
    expect(takeJarvisLiveVoiceAnnouncements()).toEqual([]);
    setJarvisLiveVoiceSink(null);
    setJarvisLiveVoiceEnabled(false);
  });

  it("routes delegated utterances to the registered runtime", () => {
    const seen: Array<{ utterance: string; delegationId: string }> = [];
    const unregister = registerJarvisLiveVoiceDelegate((utterance, delegationId) => {
      seen.push({ utterance, delegationId });
      return true;
    });
    expect(submitJarvisLiveVoiceDelegation("fix the login", "item_1")).toBe(true);
    expect(seen).toEqual([{ utterance: "fix the login", delegationId: "item_1" }]);
    unregister();
    expect(submitJarvisLiveVoiceDelegation("fix the login", "item_2")).toBe(false);
  });
});
