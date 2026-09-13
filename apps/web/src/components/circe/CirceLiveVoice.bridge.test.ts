import { describe, expect, it } from "vite-plus/test";

import {
  consumeCirceLiveVoiceActivationReason,
  getCirceLiveVoiceSink,
  getCirceLiveVoiceUiState,
  registerCirceLiveVoiceDelegate,
  requestCirceLiveVoiceAnnouncement,
  setCirceLiveVoiceActive,
  setCirceLiveVoiceEnabled,
  setCirceLiveVoiceSink,
  setCirceLiveVoiceStatus,
  submitCirceLiveVoiceDelegation,
  subscribeCirceLiveVoice,
  takeCirceLiveVoiceAnnouncements,
} from "./CirceLiveVoice.bridge";

describe("Circe live voice bridge", () => {
  it("activates, tracks status, and clears the sink outside a session", () => {
    const events: string[] = [];
    const unsubscribe = subscribeCirceLiveVoice(() => events.push("changed"));
    setCirceLiveVoiceActive(true);
    setCirceLiveVoiceStatus("live");
    expect(getCirceLiveVoiceUiState()).toEqual({ active: true, status: "live" });
    setCirceLiveVoiceSink({ speak: () => undefined, note: () => undefined });
    expect(getCirceLiveVoiceSink()).not.toBeNull();
    setCirceLiveVoiceActive(false);
    setCirceLiveVoiceSink(null);
    expect(getCirceLiveVoiceUiState()).toEqual({ active: false, status: "idle" });
    expect(getCirceLiveVoiceSink()).toBeNull();
    // active true, live, active false: the sink itself is not UI state.
    expect(events).toHaveLength(3);
    unsubscribe();
  });

  it("queues announcements and marks an announcement-only activation", () => {
    setCirceLiveVoiceActive(false);
    setCirceLiveVoiceSink(null);
    setCirceLiveVoiceEnabled(true);
    requestCirceLiveVoiceAnnouncement("The login fix is done.");
    expect(getCirceLiveVoiceUiState().active).toBe(true);
    expect(consumeCirceLiveVoiceActivationReason()).toBe("announcement");
    expect(consumeCirceLiveVoiceActivationReason()).toBe("user");
    expect(takeCirceLiveVoiceAnnouncements()).toEqual(["The login fix is done."]);
    expect(takeCirceLiveVoiceAnnouncements()).toEqual([]);

    // A live session takes the report directly instead of restarting.
    const spoken: string[] = [];
    setCirceLiveVoiceSink({
      speak: (text) => spoken.push(text),
      note: () => undefined,
    });
    requestCirceLiveVoiceAnnouncement("Another report.");
    expect(spoken).toEqual(["Another report."]);
    expect(takeCirceLiveVoiceAnnouncements()).toEqual([]);
    setCirceLiveVoiceSink(null);
    setCirceLiveVoiceEnabled(false);
  });

  it("routes delegated utterances to the registered runtime", () => {
    const seen: Array<{ utterance: string; delegationId: string }> = [];
    const unregister = registerCirceLiveVoiceDelegate((utterance, delegationId) => {
      seen.push({ utterance, delegationId });
      return true;
    });
    expect(submitCirceLiveVoiceDelegation("fix the login", "item_1")).toBe(true);
    expect(seen).toEqual([{ utterance: "fix the login", delegationId: "item_1" }]);
    unregister();
    expect(submitCirceLiveVoiceDelegation("fix the login", "item_2")).toBe(false);
  });
});
