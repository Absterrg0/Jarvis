import { describe, expect, it } from "vite-plus/test";

import {
  applyJarvisLiveVoiceTranscript,
  createJarvisLiveVoiceTranscript,
  JARVIS_LIVE_VOICE_MAX_APPEND_BYTES,
  JARVIS_LIVE_VOICE_MAX_FRAGMENTS,
  JARVIS_LIVE_VOICE_MAX_TRANSCRIPT_CHARS,
  jarvisLiveVoiceAppendCommand,
  jarvisLiveVoiceAppendText,
  parseJarvisLiveVoiceServerEvent,
  takeJarvisLiveVoiceDelegateUtterance,
} from "./liveVoice.ts";

describe("Jarvis live voice session reduction", () => {
  it("accumulates user and assistant transcripts independently", () => {
    let state = createJarvisLiveVoiceTranscript();
    state = applyJarvisLiveVoiceTranscript(state, {
      type: "session.input_transcript.delta",
      delta: "fix the ",
      startMs: 1000,
      endMs: 1200,
    });
    state = applyJarvisLiveVoiceTranscript(state, {
      type: "session.output_transcript.delta",
      delta: "Okay.",
      startMs: 1200,
      endMs: 1400,
    });
    state = applyJarvisLiveVoiceTranscript(state, {
      type: "session.input_transcript.delta",
      delta: "login bug",
      startMs: 1400,
      endMs: 1800,
    });
    expect(state.userText).toBe("fix the login bug");
    expect(state.assistantText).toBe("Okay.");
    expect(state.pendingUserText).toBe("fix the login bug");
  });

  it("uses only speech since the previous delegation for the next one", () => {
    let state = createJarvisLiveVoiceTranscript();
    state = applyJarvisLiveVoiceTranscript(state, {
      type: "session.input_transcript.delta",
      delta: "fix the login bug",
      startMs: null,
      endMs: null,
    });
    const first = takeJarvisLiveVoiceDelegateUtterance(state);
    expect(first.utterance).toBe("fix the login bug");
    state = applyJarvisLiveVoiceTranscript(first.state, {
      type: "session.input_transcript.delta",
      delta: "and then run the tests",
      startMs: null,
      endMs: null,
    });
    const second = takeJarvisLiveVoiceDelegateUtterance(state);
    expect(second.utterance).toBe("and then run the tests");
  });

  it("delegates only the last spoken utterance when lines are separated by silence", () => {
    let state = createJarvisLiveVoiceTranscript();
    const input = (delta: string, startMs: number, endMs: number) => {
      state = applyJarvisLiveVoiceTranscript(state, {
        type: "session.input_transcript.delta",
        delta,
        startMs,
        endMs,
      });
    };
    input("hello, hello", 0, 500);
    // 1300 ms of silence starts a new utterance.
    input("can you hear me", 1800, 2400);
    // Another long pause starts the request utterance.
    input("alright, check pull requests in Rivvl", 5000, 8000);

    const delegation = takeJarvisLiveVoiceDelegateUtterance(state);
    expect(delegation.utterance).toBe("alright, check pull requests in Rivvl");
    expect(takeJarvisLiveVoiceDelegateUtterance(delegation.state).utterance).toBe("");
  });

  it("keeps a continuous request with corrections in one utterance", () => {
    let state = createJarvisLiveVoiceTranscript();
    state = applyJarvisLiveVoiceTranscript(state, {
      type: "session.input_transcript.delta",
      delta: "check the pull requests ",
      startMs: 0,
      endMs: 800,
    });
    state = applyJarvisLiveVoiceTranscript(state, {
      type: "session.input_transcript.delta",
      delta: "no, in Rivvl",
      startMs: 1000,
      endMs: 1600,
    });
    expect(takeJarvisLiveVoiceDelegateUtterance(state).utterance).toBe(
      "check the pull requests no, in Rivvl",
    );
  });

  it("falls back to the last sentence when fragments carry no timing", () => {
    let state = createJarvisLiveVoiceTranscript();
    state = applyJarvisLiveVoiceTranscript(state, {
      type: "session.input_transcript.delta",
      delta: "Hello, hello. Can you hear me? Check pull requests in Rivvl",
      startMs: null,
      endMs: null,
    });
    expect(takeJarvisLiveVoiceDelegateUtterance(state).utterance).toBe(
      "Check pull requests in Rivvl",
    );
  });

  it("never replays the session transcript when there is no new speech", () => {
    let state = createJarvisLiveVoiceTranscript();
    state = applyJarvisLiveVoiceTranscript(state, {
      type: "session.input_transcript.delta",
      delta: "start the voice task",
      startMs: null,
      endMs: null,
    });
    state = takeJarvisLiveVoiceDelegateUtterance(state).state;
    state = applyJarvisLiveVoiceTranscript(state, {
      type: "session.input_transcript.delta",
      delta: "yes",
      startMs: null,
      endMs: null,
    });
    const delegation = takeJarvisLiveVoiceDelegateUtterance(state);
    expect(delegation.utterance).toBe("yes");
    // No new speech after "yes" was consumed: skip instead of resubmitting
    // "start the voice taskyes" and rebilling backend work.
    const exhausted = takeJarvisLiveVoiceDelegateUtterance(delegation.state);
    expect(exhausted.utterance).toBe("");
    expect(exhausted.state.pendingUserText).toBe("");
  });

  it("carries the earlier request when the user answers an assistant question", () => {
    let state = createJarvisLiveVoiceTranscript();
    state = applyJarvisLiveVoiceTranscript(state, {
      type: "session.input_transcript.delta",
      delta: "what's the weather today",
      startMs: 0,
      endMs: 1500,
    });
    state = applyJarvisLiveVoiceTranscript(state, {
      type: "session.output_transcript.delta",
      delta: "Which city?",
      startMs: 2000,
      endMs: 2600,
    });
    state = applyJarvisLiveVoiceTranscript(state, {
      type: "session.input_transcript.delta",
      delta: "gujarat",
      startMs: 3200,
      endMs: 3700,
    });
    // The city alone loses the request it answers; the delegation must keep
    // both so the backend can answer the actual question.
    expect(takeJarvisLiveVoiceDelegateUtterance(state).utterance).toBe(
      "what's the weather today gujarat",
    );
  });

  it("never resubmits a consumed request when answering a later assistant question", () => {
    let state = createJarvisLiveVoiceTranscript();
    state = applyJarvisLiveVoiceTranscript(state, {
      type: "session.input_transcript.delta",
      delta: "check pull requests in Rivvl",
      startMs: 0,
      endMs: 1500,
    });
    // First request delegates and clears pending speech.
    const first = takeJarvisLiveVoiceDelegateUtterance(state);
    expect(first.utterance).toBe("check pull requests in Rivvl");
    state = applyJarvisLiveVoiceTranscript(first.state, {
      type: "session.output_transcript.delta",
      delta: "Which city?",
      startMs: 2000,
      endMs: 2600,
    });
    state = applyJarvisLiveVoiceTranscript(state, {
      type: "session.input_transcript.delta",
      delta: "gujarat",
      startMs: 3200,
      endMs: 3700,
    });
    // The consumed Rivvl request must not be prepended to the short answer.
    expect(takeJarvisLiveVoiceDelegateUtterance(state).utterance).toBe("gujarat");
  });

  it("keeps a full request alone when an assistant question preceded it", () => {
    let state = createJarvisLiveVoiceTranscript();
    const input = (delta: string, startMs: number, endMs: number) => {
      state = applyJarvisLiveVoiceTranscript(state, {
        type: "session.input_transcript.delta",
        delta,
        startMs,
        endMs,
      });
    };
    const output = (delta: string, startMs: number, endMs: number) => {
      state = applyJarvisLiveVoiceTranscript(state, {
        type: "session.output_transcript.delta",
        delta,
        startMs,
        endMs,
      });
    };
    input("hello, hello", 0, 500);
    output("How can I help?", 1000, 1600);
    // A full new request is not an answer to the assistant's question: the
    // greeting must not be prepended to it.
    input("alright, check pull requests in Rivvl", 2600, 5600);
    expect(takeJarvisLiveVoiceDelegateUtterance(state).utterance).toBe(
      "alright, check pull requests in Rivvl",
    );
  });

  it("parses only the events the app acts on", () => {
    expect(parseJarvisLiveVoiceServerEvent('{"type":"session.started","session":{"id":"live_1"}}')) //
      .toEqual({ type: "session.started", sessionId: "live_1" });
    expect(
      parseJarvisLiveVoiceServerEvent(
        '{"type":"session.delegation.created","offset_ms":1000,"delegation":{"id":"item_1","type":"delegation","target":"client"}}',
      ),
    ).toEqual({
      type: "session.delegation.created",
      delegationId: "item_1",
      target: "client",
      offsetMs: 1000,
    });
    expect(
      parseJarvisLiveVoiceServerEvent(
        '{"type":"session.input_transcript.delta","delta":"hello","start_ms":1000,"end_ms":1200}',
      ),
    ).toEqual({
      type: "session.input_transcript.delta",
      delta: "hello",
      startMs: 1000,
      endMs: 1200,
    });
    expect(parseJarvisLiveVoiceServerEvent('{"type":"session.usage.updated"}')).toEqual({
      type: "other",
    });
    expect(parseJarvisLiveVoiceServerEvent("not json")).toEqual({ type: "other" });
    expect(parseJarvisLiveVoiceServerEvent(null)).toEqual({ type: "other" });
  });

  it("preserves fragment timing without treating it as turn boundaries", () => {
    let state = createJarvisLiveVoiceTranscript();
    state = applyJarvisLiveVoiceTranscript(
      state,
      parseJarvisLiveVoiceServerEvent(
        '{"type":"session.input_transcript.delta","delta":"What is","start_ms":1000,"end_ms":1200}',
      ),
    );
    expect(state.userFragments).toEqual([{ text: "What is", startMs: 1000, endMs: 1200 }]);
    // Missing timing stays null instead of inventing a wall-clock time.
    state = applyJarvisLiveVoiceTranscript(
      state,
      parseJarvisLiveVoiceServerEvent('{"type":"session.input_transcript.delta","delta":" next"}'),
    );
    expect(state.userFragments[1]).toEqual({ text: " next", startMs: null, endMs: null });
    expect(state.userText).toBe("What is next");
  });

  it("bounds transcript memory", () => {
    let state = createJarvisLiveVoiceTranscript();
    const chunk = "a".repeat(1000);
    for (let index = 0; index < 20; index += 1) {
      state = applyJarvisLiveVoiceTranscript(state, {
        type: "session.input_transcript.delta",
        delta: chunk,
        startMs: null,
        endMs: null,
      });
    }
    expect(state.userText.length).toBeLessThanOrEqual(JARVIS_LIVE_VOICE_MAX_TRANSCRIPT_CHARS);
    expect(state.pendingUserText.length).toBeLessThanOrEqual(
      JARVIS_LIVE_VOICE_MAX_TRANSCRIPT_CHARS,
    );
    expect(state.userFragments.length).toBeLessThanOrEqual(JARVIS_LIVE_VOICE_MAX_FRAGMENTS);
    // Keeps the recent tail, not the stale head.
    expect(state.userText.endsWith(chunk)).toBe(true);
  });

  it("bounds append text and builds commentary and thinking commands", () => {
    expect(jarvisLiveVoiceAppendText("  task   finished  ")).toBe("task finished");
    // Byte bound, not char bound: 500 UTF-8 bytes hold at most 500 tokens
    // because one token spans at least one byte.
    expect(JARVIS_LIVE_VOICE_MAX_APPEND_BYTES).toBe(500);
    const long = "a".repeat(JARVIS_LIVE_VOICE_MAX_APPEND_BYTES + 50);
    const bounded = jarvisLiveVoiceAppendText(long);
    expect(new TextEncoder().encode(bounded).length).toBeLessThanOrEqual(
      JARVIS_LIVE_VOICE_MAX_APPEND_BYTES,
    );
    expect(bounded.endsWith("\u2026")).toBe(true);

    expect(
      jarvisLiveVoiceAppendCommand("commentary", "Task finished.", {
        delegationId: "item_1",
        eventId: "event_1",
      }),
    ).toEqual({
      type: "session.commentary.append",
      event_id: "event_1",
      delegation_id: "item_1",
      content: "Task finished.",
    });
    expect(
      jarvisLiveVoiceAppendCommand("thinking", "Checking the tests.", { eventId: "event_2" }),
    ).toMatchObject({ delegation_id: null, type: "session.thinking.append" });
    expect(jarvisLiveVoiceAppendCommand("commentary", "   ", { eventId: "event_3" })).toBeNull();
  });

  it("truncates multi-byte text without splitting characters", () => {
    const encode = (value: string) => new TextEncoder().encode(value).length;
    const accented = jarvisLiveVoiceAppendText("é".repeat(400));
    expect(encode(accented)).toBeLessThanOrEqual(JARVIS_LIVE_VOICE_MAX_APPEND_BYTES);
    expect(accented.endsWith("\u2026")).toBe(true);
    expect(() => encodeURIComponent(accented)).not.toThrow();
    const emoji = jarvisLiveVoiceAppendText("😀".repeat(200));
    expect(encode(emoji)).toBeLessThanOrEqual(JARVIS_LIVE_VOICE_MAX_APPEND_BYTES);
    expect(emoji.endsWith("\u2026")).toBe(true);
    expect(Array.from(emoji)).not.toContain("�");
    // Short unicode passes through untouched.
    expect(jarvisLiveVoiceAppendText("  héllo  wörld  ")).toBe("héllo wörld");
  });
});
